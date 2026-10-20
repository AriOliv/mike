import { describe, expect, it } from "vitest";
import {
    addBusinessDays,
    computeDueAt,
    effectiveDueAt,
    parseRequestCode,
    requestCode,
    requesterStep,
    slaDays,
    slaState,
} from "../requests.shared";
import { parseTriage, suggestAssignee } from "../requests.triage";
import { renderNotification } from "../requests.notifications";

const tue = new Date("2026-10-20T12:00:00Z");

describe("SLA", () => {
    it("counts business days, skipping the weekend", () => {
        expect(addBusinessDays(new Date("2026-10-23T12:00:00Z"), 1).toISOString()).toBe("2026-10-26T12:00:00.000Z");
        expect(addBusinessDays(tue, 5).toISOString()).toBe("2026-10-27T12:00:00.000Z");
    });

    it("shortens with urgency, never under a day, and honours the team's table", () => {
        expect(slaDays("contrato_novo", "normal")).toBe(5);
        expect(slaDays("contrato_novo", "alta")).toBe(3);
        expect(slaDays("nda", "urgente")).toBe(1);
        expect(slaDays("nda", "normal", { nda: 2 })).toBe(2);
        expect(slaDays("nda", "normal", { nda: "x" })).toBe(1);
    });

    it("takes the requester's date only when sooner and still ahead", () => {
        expect(computeDueAt(tue, "parecer", "normal", "2026-10-30").toISOString()).toBe("2026-10-22T12:00:00.000Z");
        expect(computeDueAt(tue, "parecer", "normal", "2026-10-19").toISOString()).toBe("2026-10-22T12:00:00.000Z");
        expect(computeDueAt(tue, "parecer", "normal", "2026-10-21").toISOString()).toBe("2026-10-21T23:59:59.000Z");
    });

    it("pauses while waiting on the requester and pushes the deadline by the pause", () => {
        const clock = { due_at: "2026-10-21T12:00:00Z", status: "em_andamento" as const, paused_at: null, paused_seconds: 0 };
        expect(slaState(clock, tue)).toBe("no_prazo");
        expect(slaState(clock, new Date("2026-10-21T00:00:00Z"))).toBe("estourando");
        expect(slaState(clock, new Date("2026-10-22T00:00:00Z"))).toBe("estourado");
        expect(slaState({ ...clock, status: "aguardando_solicitante" }, tue)).toBe("pausado");
        expect(slaState({ ...clock, status: "entregue" }, tue)).toBe("encerrado");
        const paused = { ...clock, status: "aguardando_solicitante" as const, paused_at: "2026-10-20T10:00:00Z", paused_seconds: 3600 };
        expect(effectiveDueAt(paused, tue).toISOString()).toBe("2026-10-21T15:00:00.000Z");
    });
});

describe("readable number", () => {
    it("formats and parses LEG-nnnn", () => {
        expect(requestCode(1)).toBe("LEG-0001");
        expect(requestCode(12345)).toBe("LEG-12345");
        expect(parseRequestCode("LEG-0042")).toBe(42);
        expect(parseRequestCode("leg42")).toBe(42);
        expect(parseRequestCode(" 7 ")).toBe(7);
        expect(parseRequestCode("LEG-0")).toBeNull();
        expect(parseRequestCode("ABC-1")).toBeNull();
    });
});

describe("requester steps", () => {
    it("folds the six lanes into four steps", () => {
        expect(requesterStep("novo", "entrada")).toBe("recebido");
        expect(requesterStep("em_triagem", null)).toBe("recebido");
        expect(requesterStep("em_andamento", "triagem")).toBe("em_analise");
        expect(requesterStep("aguardando_solicitante", "entrada")).toBe("em_analise");
        expect(requesterStep("em_andamento", "negociacao")).toBe("em_analise");
        expect(requesterStep("em_andamento", "assinatura")).toBe("assinatura");
        expect(requesterStep("em_andamento", "arquivado")).toBe("concluido");
        expect(requesterStep("cancelado", "revisao")).toBe("concluido");
    });
});

describe("triage parsing", () => {
    it("keeps only known kinds and drops 'null' strings and empty items", () => {
        expect(
            parseTriage('Aqui: {"kind":"mou","counterparty":"null","area":" Compras ","summary":"ok","missing":["a","",3,"b","c","d"]}'),
        ).toEqual({ kind: null, counterparty: null, area: "Compras", summary: "ok", missing: ["a", "b", "c"] });
        expect(parseTriage('{"kind":"aditivo"}')).toMatchObject({ kind: "aditivo", missing: [] });
        expect(() => parseTriage("não sei")).toThrow();
    });
});

describe("assignee suggestion", () => {
    const team = [
        { user_id: "m", email: "m@x", name: "Marina" },
        { user_id: "d", email: "d@x", name: "Duda" },
        { user_id: "t", email: "t@x", name: "Téo" },
    ];
    it("picks the lightest load and explains it", () => {
        const s = suggestAssignee(team, new Map([["m", 3], ["d", 1], ["t", 2]]), null, "nda");
        expect(s).toEqual({ user_id: "d", name: "Duda", open: 1, reason: "Duda: 1 pedido aberto (Téo tem 2, Marina tem 3)." });
    });
    it("breaks a tie toward whoever handled the same kind last", () => {
        const s = suggestAssignee(team, new Map(), "t", "aditivo");
        expect(s?.reason).toBe("Téo: 0 pedidos abertos (Duda tem 0, Marina tem 0); foi quem cuidou do último Aditivo ou renovação.");
        expect(suggestAssignee([team[2]], new Map(), "t", "nda")?.reason).toBe("Téo: 0 pedidos abertos; foi quem cuidou do último NDA.");
        expect(suggestAssignee([team[1], team[2]], new Map(), "d", "nda")?.name).toBe("Duda");
    });
    it("suggests nobody when the team is empty", () => {
        expect(suggestAssignee([], new Map(), null, "nda")).toBeNull();
    });
});

describe("e-mails", () => {
    it("writes each e-mail in Portuguese with the code and the link", () => {
        process.env.APP_BASE_URL = "https://mike.example/";
        const id = "r1";
        expect(renderNotification("request.created", 3, "NDA · Polaris", id, { due: "21/10/2026" })).toEqual({
            subject: "LEG-0003 recebido: NDA · Polaris",
            text: 'Recebemos seu pedido LEG-0003 ("NDA · Polaris").\nPrazo previsto: 21/10/2026.\n\nAcompanhe por aqui: https://mike.example/pedidos/r1\n',
        });
        expect(renderNotification("request.assigned", 3, "T", id, { assignee: "Duda" }).subject).toBe(
            "LEG-0003: Duda está cuidando do seu pedido",
        );
        expect(renderNotification("request.question", 3, "T", id, { author: "Duda", question: "Tem minuta?" }).text).toContain(
            "Tem minuta?",
        );
        expect(renderNotification("request.delivered", 3, "T", id, { message: "Pode assinar." }).text).toContain("Pode assinar.");
        expect(renderNotification("request.delivered", 3, "T", id, {}).text).not.toContain("undefined");
        expect(renderNotification("request.invited", 3, "T", id, { inviter: "Marina", expires: "19/01/2027" }).text).toContain(
            "até 19/01/2027",
        );
        delete process.env.APP_BASE_URL;
    });
});
