import { describe, expect, it } from "vitest";
import { alertLabel, daysUntil, dueLabel, ownerLabel, parseAlertDays } from "./obligations";

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
    });

    it("accepts a lead time of 0 to 365 days only", () => {
        expect(parseAlertDays("0")).toBe(0);
        expect(parseAlertDays(" 365 ")).toBe(365);
        for (const bad of ["", "366", "-1", "1.5", "abc", "1000"]) expect(parseAlertDays(bad)).toBeNull();
    });
});
