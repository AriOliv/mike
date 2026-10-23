import { describe, expect, it } from "vitest";
import { ALERT_DAY_CHOICES, alertLabel, amendmentLine, KIND_LABEL, sortAlerts, STATUS_LABEL, daysUntil, dueLabel, ownerLabel, parseAlertDays } from "./obligations";

describe("obligation helpers", () => {
    it("counts days from today, midnight to midnight", () => {
        const today = new Date(2026, 10, 1, 22, 30);
        expect(daysUntil("2026-11-01", today)).toBe(0);
        expect(daysUntil("2026-11-06", today)).toBe(5);
        expect(daysUntil("2026-10-30", today)).toBe(-2);
    });

    it("words the due date in Portuguese", () => {
        expect(dueLabel(0)).toBe("vence hoje");
        expect(dueLabel(1)).toBe("vence amanhã");
        expect(dueLabel(5)).toBe("vence em 5 dias");
        expect(dueLabel(-1)).toBe("venceu ontem");
        expect(dueLabel(-4)).toBe("venceu há 4 dias");
    });

    it("words the warning lead time", () => {
        expect(alertLabel(0)).toBe("avisa no dia");
        expect(alertLabel(1)).toBe("avisa 1 dia antes");
        expect(alertLabel(30)).toBe("avisa 30 dias antes");
    });

    it("names the owner, or says there is none", () => {
        expect(ownerLabel({ owner_email: null })).toBe("Sem responsável");
        expect(ownerLabel({ owner_email: "ana@x.io" }, "Ana@X.io")).toBe("Você");
        expect(ownerLabel({ owner_email: "bia@x.io" }, "ana@x.io")).toBe("bia@x.io");
        expect(ownerLabel({ owner_email: "bia@x.io" })).toBe("bia@x.io");
        expect(ownerLabel({ owner_email: "bia@x.io" }, "ana@x.io", [{ email: "bia@x.io", name: "Bia" }])).toBe("Bia");
    });

    it("offers 30 days among the usual lead times", () => {
        expect(ALERT_DAY_CHOICES).toContain(30);
    });

    it("accepts a lead time of 0 to 365 days only", () => {
        expect(parseAlertDays("0")).toBe(0);
        expect(parseAlertDays(" 365 ")).toBe(365);
        for (const bad of ["", "366", "-1", "1.5", "abc", "1000"]) expect(parseAlertDays(bad)).toBeNull();
    });

    it("names each kind of deadline and each status in Portuguese", () => {
        expect(KIND_LABEL).toEqual({
            vigencia: "Fim da vigência",
            aviso_previo: "Aviso prévio",
            renovacao: "Decisão de renovação",
            manual: "Prazo",
        });
        expect(STATUS_LABEL).toEqual({ aberto: "Aberto", feito: "Feito", dispensado: "Dispensado" });
    });

    it("sorts open deadlines first, then the closed ones, each by date, without touching the input", () => {
        const input = [
            { id: "a", status: "feito", due_date: "2026-11-01" },
            { id: "b", status: "aberto", due_date: "2026-12-01" },
            { id: "c", status: "dispensado", due_date: "2026-10-01" },
            { id: "d", status: "aberto", due_date: "2026-11-15" },
        ] as const;
        const copy = [...input];
        expect(sortAlerts([...input]).map((x) => x.id)).toEqual(["d", "b", "c", "a"]);
        expect([...input]).toEqual(copy);
    });
});

describe("amendmentLine", () => {
    it("says where the amendment stands, with the delivery date once delivered", () => {
        expect(amendmentLine({ status: "em_andamento", delivered_at: null, term_end: null })).toBe("Em análise");
        expect(amendmentLine({ status: "entregue", delivered_at: "2026-11-03T12:00:00Z", term_end: null })).toBe("Entregue em 03/11/2026");
        expect(amendmentLine({ status: "entregue", delivered_at: null, term_end: null })).toBe("Entregue");
    });

    it("adds the term the amendment sets, and keeps an unknown status readable", () => {
        expect(amendmentLine({ status: "novo", delivered_at: null, term_end: "2028-01-05" })).toBe("Novo · define o fim da vigência em 05/01/2028");
        expect(amendmentLine({ status: "arquivado_x", delivered_at: null, term_end: null })).toBe("arquivado_x");
    });
});
