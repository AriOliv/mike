import { describe, expect, it } from "vitest";
import {
    activitySentence,
    actorLabel,
    describeEvent,
    fieldLabel,
    relativeTime,
    toActivityItems,
    type CardEventRow,
} from "./activityFeed";

const NOW = Date.parse("2026-10-20T12:00:00Z");

function event(overrides: Partial<CardEventRow>): CardEventRow {
    return {
        id: 1,
        project_id: "p1",
        at: "2026-10-20T11:00:00Z",
        actor_type: "user",
        actor_id: "u1",
        actor_name: null,
        action: "comment.added",
        ...overrides,
    };
}

describe("fieldLabel", () => {
    it("names known fields, keeps words, and hides internal names", () => {
        expect(fieldLabel("assignee_email")).toBe("responsável");
        expect(fieldLabel("Cessão do contrato")).toBe("Cessão do contrato");
        expect(fieldLabel("identificacao.tipo")).toBeUndefined();
        expect(fieldLabel("riskLevel")).toBeUndefined();
        expect(fieldLabel("  ")).toBeUndefined();
        expect(fieldLabel(null)).toBeUndefined();
    });
});

describe("actorLabel", () => {
    it("prefers the stored name", () => {
        expect(actorLabel(event({ actor_name: "  Duda  " }))).toBe("Duda");
    });

    it("names agents in Portuguese from their id, with a generic fallback", () => {
        expect(actorLabel(event({ actor_type: "agent", actor_id: "agent:revisor@1" }))).toBe("Agente de revisão");
        expect(actorLabel(event({ actor_type: "agent", actor_id: "agent:novo" }))).toBe("Agente");
    });

    it("names the bot, the system, and a person by e-mail or not at all", () => {
        expect(actorLabel(event({ actor_type: "hermes", actor_id: "hermes:docbot" }))).toBe("Assistente no Slack");
        expect(actorLabel(event({ actor_type: "system", actor_id: "cron:vigia" }))).toBe("Mike");
        expect(actorLabel(event({ actor_id: "ana@example.com" }))).toBe("ana");
        expect(actorLabel(event({ actor_id: "b0b-uuid", actor_name: " " }))).toBe("Alguém");
    });
});

describe("describeEvent", () => {
    it("names pipeline lanes and unknown lanes", () => {
        expect(describeEvent(event({ action: "lane.changed", after: "revisao" }))).toEqual({
            verb: "moveu para",
            object: "Revisão",
        });
        expect(describeEvent(event({ action: "lane.changed", after: "outra" })).object).toBe("outra");
        expect(describeEvent(event({ action: "lane.changed", after: null })).object).toBe("fora da esteira");
    });

    it("describes assignment and its removal", () => {
        expect(describeEvent(event({ action: "assignee.changed", after: "duda@example.com" }))).toEqual({
            verb: "atribuiu a",
            object: "duda",
        });
        expect(describeEvent(event({ action: "assignee.changed", after: null }))).toEqual({
            verb: "removeu o responsável",
        });
        expect(
            describeEvent(event({ action: "assignee.changed", after: { name: "Legal Demo", steps: ["x"] } })),
        ).toEqual({ verb: "atribuiu a", object: "Legal Demo" });
        expect(describeEvent(event({ action: "assignee.changed", after: { email: "ana@x.com" } })).object).toBe("ana");
        expect(describeEvent(event({ action: "assignee.suggested", after: { name: "Duda" } }))).toEqual({
            verb: "sugeriu como responsável",
            object: "Duda",
        });
        expect(describeEvent(event({ action: "assignee.suggested", after: { email: "duda@x.com" } })).object).toBe("duda");
        expect(describeEvent(event({ action: "assignee.suggested" })).object).toBeUndefined();
    });

    it("describes progress, known and unknown", () => {
        expect(describeEvent(event({ action: "status.changed", after: "bloqueado" })).object).toBe("Bloqueado");
        expect(describeEvent(event({ action: "status.changed", after: "x" })).object).toBe("x");
        expect(describeEvent(event({ action: "status.changed", after: 3 })).object).toBe("vazio");
    });

    it("describes agent reviews with their document and sources", () => {
        expect(
            describeEvent(event({ action: "review.completed", after: { document: "NDA.docx", sources: 3 } })),
        ).toEqual({ verb: "revisou", object: "NDA.docx", sources: 3 });
        expect(describeEvent(event({ action: "review.started", after: { document: "A" } })).verb).toBe(
            "começou a revisar",
        );
        expect(describeEvent(event({ action: "review.failed" }))).toEqual({
            verb: "não conseguiu revisar",
            object: undefined,
        });
    });

    it("describes the requests' moves: triage, suggestion, questions, delivery, guests", () => {
        expect(describeEvent(event({ action: "request.created", after: { code: "LEG-0007" } })).object).toBe("LEG-0007");
        expect(describeEvent(event({ action: "request.triaged", after: { kind: "nda" } }))).toEqual({
            verb: "fez a triagem",
            object: "NDA",
        });
        expect(describeEvent(event({ action: "request.triaged", after: {} })).object).toBeUndefined();
        expect(describeEvent(event({ action: "triage.accepted" })).verb).toBe("aceitou a triagem");
        expect(describeEvent(event({ action: "triage.edited" })).verb).toBe("ajustou a triagem");
        expect(describeEvent(event({ action: "triage.rejected" })).verb).toBe("recusou a triagem");
        expect(describeEvent(event({ action: "triage.reopened" })).verb).toBe("reabriu a triagem");
        expect(describeEvent(event({ action: "request.question" })).verb).toBe("perguntou ao solicitante");
        expect(describeEvent(event({ action: "request.answered" })).verb).toBe("respondeu");
        expect(describeEvent(event({ action: "request.delivered" })).verb).toBe("entregou o pedido");
        expect(
            describeEvent(event({ action: "participant.invited", after: { email: "a@b.c", label: "Escritório X" } })).object,
        ).toBe("Escritório X");
        expect(describeEvent(event({ action: "participant.invited", after: { email: "a@b.c" } })).object).toBe("a@b.c");
        expect(describeEvent(event({ action: "participant.revoked", after: { email: "a@b.c" } }))).toEqual({
            verb: "removeu o acesso de",
            object: "a@b.c",
        });
    });

    it("describes the remaining actions and falls back to the raw action", () => {
        expect(describeEvent(event({ action: "document.added", after: { document: "B" } })).object).toBe("B");
        expect(describeEvent(event({ action: "folder.watched", after: { folder: "Fornecedores" } })).object).toBe(
            "Fornecedores",
        );
        expect(describeEvent(event({ action: "request.created", after: { request: "LEG-0142" } })).object).toBe(
            "LEG-0142",
        );
        expect(describeEvent(event({ action: "comment.added" })).verb).toBe("comentou");
        expect(describeEvent(event({ action: "review.accepted" })).verb).toBe("aceitou a revisão");
        expect(describeEvent(event({ action: "field.updated", field: "prazo" })).object).toBe("prazo");
        expect(describeEvent(event({ action: "field.updated", field: "status" })).object).toBe("progresso");
        expect(describeEvent(event({ action: "field.updated", field: "risk_level" })).object).toBe("risco");
        expect(describeEvent(event({ action: "field.updated", field: "some_column" }))).toEqual({
            verb: "atualizou o contrato",
        });
        expect(describeEvent(event({ action: "field.updated" })).verb).toBe("atualizou o contrato");
        expect(describeEvent(event({ action: "x.y" })).verb).toBe("registrou uma atualização");
        expect(describeEvent(event({ action: "agent.started" })).verb).toBe("começou a trabalhar neste contrato");
        expect(describeEvent(event({ action: "agent.suggested", field: "risk_level" })).object).toBe("risco");
        expect(describeEvent(event({ action: "agent.suggested", field: "triage" })).object).toBe("triagem");
        expect(describeEvent(event({ action: "agent.suggested", field: "x.y", after: { value: "z" } })).object).toBe("z");
        expect(describeEvent(event({ action: "agent.suggested", field: "risco", after: { sources: 2 } }))).toEqual({
            verb: "sugeriu",
            object: "risco",
            sources: 2,
        });
        expect(describeEvent(event({ action: "agent.suggested", after: { suggestion: "risco alto" } })).object).toBe(
            "risco alto",
        );
        expect(describeEvent(event({ action: "agent.suggested", after: { value: "NDA" } })).object).toBe("NDA");
        expect(describeEvent(event({ action: "agent.suggested" }))).toEqual({ verb: "fez uma sugestão", sources: undefined });
        expect(describeEvent(event({ action: "agent.failed" })).verb).toBe("não conseguiu terminar o trabalho");
        expect(describeEvent(event({ action: "document.version_added", after: { document: "v2.docx" } })).object).toBe(
            "v2.docx",
        );
        expect(describeEvent(event({ action: "notification.sent", after: { to: "Slack" } })).object).toBe("Slack");
        expect(describeEvent(event({ action: "kb.ask" })).verb).toBe("perguntou à base");
    });
});

describe("clause decisions from a playbook review", () => {
    const decide = (action: string, after: unknown, field: string | null = null) =>
        activitySentence(toActivityItems([event({ actor_name: "Duda", action, after, field })])[0]);

    it("names the clause by number, with the reason when there is one", () => {
        expect(decide("review.clause_aceito", { clause: "9" })).toBe("Duda aceitou a edição da cl. 9");
        expect(decide("review.clause_editado", { clause: "12.1", reason: null })).toBe(
            "Duda editou a edição da cl. 12.1",
        );
        expect(decide("review.clause_rejeitado", { clause: "4", reason: "posição do cliente" })).toBe(
            "Duda rejeitou a sugestão da cl. 4: posição do cliente",
        );
    });

    it("names it by the rule when there is no number, falling back to the event's field", () => {
        expect(decide("review.clause_aceito", { run: "r", clause: "Cessão do contrato", reason: null })).toBe(
            "Duda aceitou a edição em Cessão do contrato",
        );
        expect(decide("review.clause_rejeitado", null, "Lei aplicável e foro")).toBe(
            "Duda rejeitou a sugestão em Lei aplicável e foro",
        );
    });

    it("still reads without a clause", () => {
        expect(decide("review.clause_rejeitado", { reason: "fora do escopo" })).toBe(
            "Duda rejeitou a sugestão: fora do escopo",
        );
        expect(decide("review.clause_aceito", {})).toBe("Duda aceitou a edição");
    });
});

describe("toActivityItems", () => {
    it("sorts newest first and links each line", () => {
        const items = toActivityItems(
            [event({ id: 1, at: "2026-10-20T10:00:00Z" }), event({ id: 2, at: "2026-10-20T11:00:00Z" })],
            (e) => `/card/${e.id}`,
        );
        expect(items.map((i) => i.id)).toEqual(["2", "1"]);
        expect(items[0].href).toBe("/card/2");
    });

    it("folds the same agent reviewing several contracts in a short window", () => {
        const review = (id: number, project: string, at: string) =>
            event({
                id,
                project_id: project,
                at,
                actor_type: "agent",
                actor_id: "agent:revisor@1",
                action: "review.completed",
                after: { document: `${project}.docx` },
            });
        const items = toActivityItems([
            review(1, "p1", "2026-10-20T11:00:00Z"),
            review(2, "p2", "2026-10-20T11:05:00Z"),
            review(3, "p3", "2026-10-20T11:08:00Z"),
            review(4, "p4", "2026-10-20T08:00:00Z"),
        ]);
        expect(items).toHaveLength(2);
        expect(items[0]).toMatchObject({ count: 3, object: undefined });
        expect(activitySentence(items[0])).toBe("Agente de revisão revisou 3 contratos");
        expect(items[1].count).toBeUndefined();
    });

    it("carries an agent's steps and who confirmed its suggestion", () => {
        const [item] = toActivityItems([
            event({
                actor_type: "agent",
                actor_id: "agent:atribuicao",
                action: "assignee.changed",
                after: { steps: ["leu a carga do time", 3, "sugeriu Duda"], confirmed_by: "Fernanda" },
            }),
        ]);
        expect(item.steps).toEqual(["leu a carga do time", "sugeriu Duda"]);
        expect(item.confirmedBy).toBe("Fernanda");
        const [plain] = toActivityItems([event({ after: { steps: "x" } })]);
        expect(plain).not.toHaveProperty("steps");
        expect(plain).not.toHaveProperty("confirmedBy");
    });

    it("never folds events on the same card or actions that do not count", () => {
        const items = toActivityItems([
            event({ id: 1, action: "review.completed", at: "2026-10-20T11:00:00Z" }),
            event({ id: 2, action: "review.completed", at: "2026-10-20T11:01:00Z" }),
            event({ id: 3, project_id: "p2", action: "comment.added", at: "2026-10-20T11:02:00Z" }),
            event({ id: 4, project_id: "p3", action: "comment.added", at: "2026-10-20T11:03:00Z" }),
        ]);
        expect(items).toHaveLength(4);
    });
});

describe("activitySentence", () => {
    it("reads with an object, sources in the singular and plural, and without", () => {
        const base = { id: "1", actorType: "agent" as const, actorName: "Agente de revisão", at: "" };
        expect(activitySentence({ ...base, verb: "revisou", object: "NDA.docx", sources: 1 })).toBe(
            "Agente de revisão revisou NDA.docx com 1 fonte",
        );
        expect(activitySentence({ ...base, verb: "revisou", sources: 3 })).toBe(
            "Agente de revisão revisou com 3 fontes",
        );
        expect(activitySentence({ ...base, verb: "comentou", sources: 0, count: 1 })).toBe(
            "Agente de revisão comentou",
        );
    });
});

describe("relativeTime", () => {
    it("speaks in minutes, hours, yesterday, days and then the date", () => {
        expect(relativeTime("2026-10-20T11:59:40Z", NOW)).toBe("agora");
        expect(relativeTime("2026-10-20T11:55:00Z", NOW)).toBe("há 5 min");
        expect(relativeTime("2026-10-20T10:00:00Z", NOW)).toBe("há 2 h");
        expect(relativeTime("2026-10-19T10:00:00Z", NOW)).toBe("ontem");
        expect(relativeTime("2026-10-17T10:00:00Z", NOW)).toBe("há 3 d");
        expect(relativeTime("2026-10-01T10:00:00Z", NOW)).toBe("01/10/2026");
    });

    it("treats a future time as now and an invalid one as blank, defaulting to the clock", () => {
        expect(relativeTime("2026-10-20T13:00:00Z", NOW)).toBe("agora");
        expect(relativeTime("nope")).toBe("");
        expect(relativeTime(new Date().toISOString())).toBe("agora");
    });
});
