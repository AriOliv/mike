import { describe, expect, it, vi } from "vitest";
import type { LegalRequest, RequestListItem } from "./mikeApi";
import {
    CHANNEL_LABEL,
    filterQueue,
    formatDate,
    nextAction,
    positionText,
    requestPlan,
    sinceText,
    stageHolderText,
    slaText,
    slaTone,
    sortQueue,
    requestChip,
    stepIndex,
} from "./requests";

const now = Date.parse("2026-10-20T12:00:00Z");

function item(over: Partial<RequestListItem>): RequestListItem {
    return {
        id: "r",
        code: "LEG-0001",
        title: "NDA · Polaris",
        kind: "nda",
        kind_label: "NDA",
        counterparty: "Polaris",
        status: "novo",
        sla: "no_prazo",
        due_at: "2026-10-22T12:00:00Z",
        requester_name: "Ana",
        requester_email: "ana@avenia.io",
        requester_area: null,
        assignee_id: null,
        assignee_name: null,
        suggested_assignee_name: null,
        triaged: false,
        triage_pending: false,
        channel: "form",
        project_id: "p",
        external: false,
        created_at: "2026-10-20T10:00:00Z",
        updated_at: "2026-10-20T10:00:00Z",
        ...over,
    };
}

function request(over: Partial<LegalRequest>): LegalRequest {
    return {
        id: "r",
        code: "LEG-0001",
        title: "NDA · Polaris",
        kind: "nda",
        kind_label: "NDA",
        counterparty: "Polaris",
        context: "",
        urgency: "normal",
        needed_by: null,
        status: "novo",
        step: "recebido",
        due_at: "2026-10-22T12:00:00Z",
        sla: "no_prazo",
        summary: null,
        assignee_name: null,
        requester_name: "Ana",
        requester_email: "ana@avenia.io",
        requester_area: null,
        delivery: null,
        messages: [],
        created_at: "",
        updated_at: "",
        audience: "team",
        ...over,
    };
}

describe("words", () => {
    it("maps statuses onto chips and steps onto positions", () => {
        const none = { triaged: false, pending: false };
        expect(requestChip("novo", none)).toEqual({ status: "a_fazer", label: "Novo" });
        expect(requestChip("em_triagem", none)).toEqual({ status: "rodando", label: "Fazendo a triagem…" });
        expect(requestChip("em_triagem", { triaged: true, pending: true })).toEqual({ status: "pronto", label: "Triagem pronta" });
        expect(requestChip("em_triagem", { triaged: true, pending: false })).toEqual({ status: "em_andamento", label: "Em triagem" });
        expect(requestChip("em_andamento", none)).toEqual({ status: "em_andamento", label: "Em análise" });
        expect(requestChip("aguardando_solicitante", none)).toEqual({ status: "aguardando", label: "Aguardando solicitante" });
        expect(requestChip("entregue", none)).toEqual({ status: "concluido", label: "Entregue" });
        expect(requestChip("cancelado", none)).toEqual({ status: "concluido", label: "Cancelado" });
        expect(stepIndex("assinatura")).toBe(2);
        expect(formatDate("2026-10-21T01:00:00Z")).toBe("20/10/2026");
    });

    it("says how the SLA stands in a few words", () => {
        expect(slaText("pausado", "", now)).toBe("pausado");
        expect(slaText("encerrado", "", now)).toBe("encerrado");
        expect(slaText("no_prazo", "2026-10-22T12:00:00Z", now)).toBe("vence em 2 d");
        expect(slaText("estourando", "2026-10-20T17:00:00Z", now)).toBe("vence em 5 h");
        expect(slaText("estourando", "2026-10-20T12:30:00Z", now)).toBe("vence em 1 h");
        expect(slaText("estourado", "2026-10-20T09:00:00Z", now)).toBe("atrasado 3 h");
        expect(slaText("estourado", "2026-10-20T11:59:00Z", now)).toBe("atrasado 1 h");
        expect(slaText("estourado", "2026-10-17T12:00:00Z", now)).toBe("atrasado 3 d");
        expect(slaTone("estourado")).toBe("critico");
        expect(slaTone("estourando")).toBe("atencao");
        expect(slaTone("no_prazo")).toBe("default");
    });
});

describe("queue", () => {
    const rows = [
        item({ id: "a", code: "LEG-0001" }),
        item({ id: "b", code: "LEG-0002", assignee_id: "me", status: "em_andamento", sla: "estourando", due_at: "2026-10-20T20:00:00Z" }),
        item({ id: "c", code: "LEG-0003", assignee_id: "other", status: "aguardando_solicitante", sla: "pausado" }),
        item({ id: "d", code: "LEG-0004", status: "entregue", sla: "encerrado", updated_at: "2026-10-19T00:00:00Z" }),
        item({ id: "e", code: "LEG-0005", status: "entregue", sla: "encerrado", updated_at: "2026-09-01T00:00:00Z" }),
        item({ id: "f", code: "LEG-0006", assignee_id: "me", status: "em_andamento", sla: "estourado", counterparty: "Trópico" }),
    ];
    const ids = (r: RequestListItem[]) => r.map((x) => x.id);
    const base = { userId: "me", query: "", now };

    it("filters by tab and counter", () => {
        expect(ids(filterQueue(rows, { ...base, tab: "abertos", filter: null }))).toEqual(["a", "b", "c", "f"]);
        expect(ids(filterQueue(rows, { ...base, tab: "todos", filter: null }))).toHaveLength(6);
        expect(ids(filterQueue(rows, { ...base, tab: "meus", filter: null }))).toEqual(["b", "f"]);
        expect(ids(filterQueue(rows, { ...base, tab: "abertos", filter: "sem_dono" }))).toEqual(["a"]);
        expect(ids(filterQueue(rows, { ...base, tab: "abertos", filter: "sla_estourando" }))).toEqual(["b", "f"]);
        expect(ids(filterQueue(rows, { ...base, tab: "abertos", filter: "aguardando_solicitante" }))).toEqual(["c"]);
        expect(ids(filterQueue(rows, { ...base, tab: "abertos", filter: "concluidos_semana" }))).toEqual(["d"]);
        expect(ids(filterQueue(rows, { ...base, tab: "todos", filter: "meus" }))).toEqual(["b", "f"]);
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-11-30T00:00:00Z"));
        expect(ids(filterQueue(rows, { ...base, now: undefined, tab: "todos", filter: "concluidos_semana" }))).toEqual([]);
        vi.useRealTimers();
    });

    it("searches code, title, counterparty and requester", () => {
        expect(ids(filterQueue(rows, { ...base, tab: "todos", filter: null, query: "trópico" }))).toEqual(["f"]);
        expect(ids(filterQueue(rows, { ...base, tab: "todos", filter: null, query: "leg-0003" }))).toEqual(["c"]);
        expect(ids(filterQueue([item({ id: "z", requester_area: "Compras" })], { ...base, tab: "todos", filter: null, query: "compras" }))).toEqual(["z"]);
        expect(ids(filterQueue([item({ counterparty: null, requester_name: null })], { ...base, tab: "todos", filter: null, query: "ana@" }))).toEqual(["r"]);
    });

    it("puts the most urgent open request first and closed ones last", () => {
        // b is due today; a, c, f in two days (stable order); then delivered, newest first.
        expect(ids(sortQueue(rows))).toEqual(["b", "a", "c", "f", "d", "e"]);
    });
});

describe("orchestration plan", () => {
    it("shows the agents running before triage lands", () => {
        const plan = requestPlan(request({}));
        expect(plan.map((s) => [s.id, s.state])).toEqual([
            ["triagem", "rodando"],
            ["atribuicao", "a_fazer"],
            ["analise", "a_fazer"],
            ["devolutiva", "a_fazer"],
        ]);
        expect(plan[2].owner.name).toBe("Responsável");
        expect(plan[3].asksFirst).toBe(true);
    });

    it("adds the playbook and what the requester owes, and follows the work", () => {
        const triage = {
            kind: "nda" as const,
            assignee_name: "Duda",
            playbook_name: "Playbook NDA",
            missing: ["minuta da contraparte"],
            decision: null,
        };
        const plan = requestPlan(request({ triage, status: "aguardando_solicitante" }));
        expect(plan.map((s) => s.id)).toEqual(["triagem", "atribuicao", "revisao", "solicitante", "analise", "devolutiva"]);
        expect(plan[0].task).toBe("classificou como NDA e listou o que falta");
        expect(plan[1].task).toBe("sugeriu Duda pela carga do time");
        expect(plan[3]).toMatchObject({ owner: { kind: "requester", name: "Ana" }, task: "enviar: minuta da contraparte", state: "aguardando" });

        const working = requestPlan(
            request({
                triage: { ...triage, kind: "outro_tipo" as never },
                status: "em_andamento",
                assignee_name: "Téo",
                messages: [{ id: "m", kind: "answer", body: "", author_name: null, author_email: "", created_at: "" }],
            }),
        );
        expect(working[0].task).toBe("classificou como outro_tipo e listou o que falta");
        expect(working[3].state).toBe("feito");
        expect(working[4]).toMatchObject({ owner: { name: "Téo" }, state: "rodando" });

        expect(requestPlan(request({ triage, status: "em_triagem" }))[3].state).toBe("a_fazer");
        const done = requestPlan(request({ triage, status: "entregue", assignee_name: "Téo" }));
        expect(done.every((s) => s.state === "feito")).toBe(true);
    });

    it("asks the requester to answer when the team asked without a checklist", () => {
        const plan = requestPlan(
            request({ triage: { kind: "parecer", missing: [] }, status: "aguardando_solicitante", requester_name: null }),
        );
        expect(plan.find((s) => s.id === "solicitante")).toMatchObject({
            owner: { name: "ana@avenia.io" },
            task: "responder a pergunta do Legal",
        });
        expect(plan.find((s) => s.id === "atribuicao")?.task).toBe("sugerir quem pega");
    });
});

describe("CHANNEL_LABEL", () => {
    it("names where a request came from, including the platform itself", () => {
        expect(CHANNEL_LABEL).toMatchObject({ form: "Formulário", mcp: "Assistente", sistema: "Automático" });
    });
});

describe("stage strip words", () => {
    const at = (iso: string) => Date.parse(iso);
    const base = at("2026-10-20T12:00:00Z");

    it("says how long ago in the units a person thinks in, then a date past a week", () => {
        expect(sinceText("2026-10-20T11:59:40Z", base)).toBe("agora");
        expect(sinceText("2026-10-20T11:15:00Z", base)).toBe("há 45 min");
        expect(sinceText("2026-10-20T09:00:00Z", base)).toBe("há 3 h");
        expect(sinceText("2026-10-19T09:00:00Z", base)).toBe("ontem");
        expect(sinceText("2026-10-16T12:00:00Z", base)).toBe("há 4 dias");
        expect(sinceText("2026-10-05T12:00:00Z", base)).toBe("05/10");
        expect(sinceText("lixo", base)).toBe("");
    });

    it("names who has the ball and since when", () => {
        expect(stageHolderText({ kind: "person", name: "Téo" }, "2026-10-19T09:00:00Z", base)).toBe("com Téo, desde ontem");
        expect(stageHolderText({ kind: "person", name: "Téo" }, "2026-10-20T09:00:00Z", base)).toBe("com Téo, há 3 h");
        expect(stageHolderText({ kind: "agent", name: "Agente de triagem" }, "2026-10-20T11:00:00Z", base)).toBe(
            "com o agente de triagem, há 1 h",
        );
        expect(stageHolderText({ kind: "requester", name: "Ana" }, "2026-10-19T09:00:00Z", base)).toBe("aguardando Ana, desde ontem");
        expect(stageHolderText({ kind: "requester", name: null }, null, base)).toBe("aguardando quem pediu");
        expect(stageHolderText({ kind: "none", name: null }, "2026-10-19T09:00:00Z", base)).toBe("sem responsável, desde ontem");
    });

    it("leaves the time out for a request older than the history", () => {
        expect(stageHolderText({ kind: "person", name: "Téo" }, null, base)).toBe("com Téo");
        expect(stageHolderText({ kind: "person", name: null }, null, base)).toBe("sem responsável");
        expect(stageHolderText({ kind: "agent", name: null }, null, base)).toBe("com o agente");
    });

    it("counts the stage position, and says nothing on the two ends", () => {
        expect(positionText({ index: 3, of: 5 })).toBe("Etapa 3 de 5");
        expect(positionText(null)).toBeNull();
    });
});

describe("next action", () => {
    const mine = { assignee_id: "u1", assignee_name: "Téo", status: "em_andamento" as const, project_id: "p1" };

    it("puts the assignee's own analysis first, with the deadline and the document", () => {
        expect(nextAction(request(mine), "u1", now)).toEqual({
            title: "Analisar e decidir",
            detail: "vence em 2 d",
            tone: "mine",
            action: "review",
        });
    });

    it("offers no document button before the request has a project", () => {
        expect(nextAction(request({ ...mine, project_id: null }), "u1", now)?.action).toBeNull();
    });

    it("shows nothing to someone else, or to nobody signed in", () => {
        expect(nextAction(request(mine), "u2", now)).toBeNull();
        expect(nextAction(request(mine), null, now)).toBeNull();
    });

    it("asks the Head to pick an owner when nobody has the request", () => {
        expect(nextAction(request({ can_decide: true }), "u2", now)).toMatchObject({ tone: "head", action: "assign" });
        expect(nextAction(request({ can_decide: false }), "u2", now)).toBeNull();
    });

    it("says it is the requester's turn, in amber terms, while the SLA is paused", () => {
        expect(nextAction(request({ ...mine, status: "aguardando_solicitante", sla: "pausado" }), "u1", now)).toEqual({
            title: "Aguardando Ana",
            detail: "o prazo está pausado",
            tone: "wait",
            action: null,
        });
        expect(nextAction(request({ status: "aguardando_solicitante", requester_name: null }), "u1", now)?.title).toBe(
            "Aguardando ana@avenia.io",
        );
    });

    it("has no next action once the request is closed", () => {
        expect(nextAction(request({ ...mine, status: "entregue" }), "u1", now)).toBeNull();
        expect(nextAction(request({ ...mine, status: "cancelado" }), "u1", now)).toBeNull();
    });
});
