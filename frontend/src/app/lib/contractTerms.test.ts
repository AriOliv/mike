import { describe, expect, it } from "vitest";
import {
    brDate,
    emailError,
    monthsError,
    parseMonths,
    startNotice,
    termEndDate,
    termEndSentence,
} from "./contractTerms";

describe("contract terms", () => {
    it("ends the day before the start's day, months later", () => {
        expect(termEndDate("2026-11-12", 12)).toBe("2027-11-11");
        expect(termEndDate("2026-01-15", 1)).toBe("2026-02-14");
        expect(termEndDate("2026-11-12", 36)).toBe("2029-11-11");
        expect(termEndDate("2026-06-10", 6)).toBe("2026-12-09");
        expect(termEndDate("2026-12-15", 1)).toBe("2027-01-14");
    });

    it("lets a term from the 1st end on the last day of the month before", () => {
        expect(termEndDate("2026-01-01", 12)).toBe("2026-12-31");
        expect(termEndDate("2026-03-01", 1)).toBe("2026-03-31");
        expect(termEndDate("2026-02-01", 1)).toBe("2026-02-28");
        expect(termEndDate("2028-02-01", 1)).toBe("2028-02-29");
        expect(termEndDate("2026-12-01", 1)).toBe("2026-12-31");
        expect(termEndDate("2026-01-01", 600)).toBe("2075-12-31");
    });

    it("ends on the last day of a shorter month and never spills into the next (CC art. 132, §3º)", () => {
        expect(termEndDate("2027-01-31", 1)).toBe("2027-02-28");
        expect(termEndDate("2028-01-31", 1)).toBe("2028-02-29");
        expect(termEndDate("2026-08-31", 6)).toBe("2027-02-28");
        expect(termEndDate("2026-12-31", 2)).toBe("2027-02-28");
        expect(termEndDate("2026-03-31", 1)).toBe("2026-04-30");
        expect(termEndDate("2026-01-30", 1)).toBe("2026-02-28");
        expect(termEndDate("2026-01-29", 1)).toBe("2026-02-28");
        expect(termEndDate("2026-01-28", 1)).toBe("2026-02-27");
        expect(termEndDate("2026-12-31", 12)).toBe("2027-12-30");
    });

    it("handles leap days", () => {
        expect(termEndDate("2024-02-29", 12)).toBe("2025-02-28");
        expect(termEndDate("2024-02-29", 48)).toBe("2028-02-28");
        expect(termEndDate("2023-02-28", 12)).toBe("2024-02-27");
        expect(termEndDate("2023-03-01", 12)).toBe("2024-02-29");
        expect(termEndDate("2027-03-01", 12)).toBe("2028-02-29");
    });

    it("has no end until both values are valid", () => {
        expect(termEndDate("", 12)).toBeNull();
        expect(termEndDate("2026-11-12", null)).toBeNull();
        expect(termEndDate("2026-02-31", 12)).toBeNull();
        expect(termEndDate("12/11/2026", 12)).toBeNull();
        expect(termEndDate("2026-11-12", 0)).toBeNull();
        expect(termEndDate("2026-11-12", 601)).toBeNull();
        expect(termEndDate("2026-11-12", 1.5)).toBeNull();
    });

    it("writes the end in Portuguese, singular and plural", () => {
        expect(termEndSentence("2026-11-12", 12)).toBe("Termina em 11/11/2027 (início + 12 meses − 1 dia)");
        expect(termEndSentence("2026-11-12", 1)).toBe("Termina em 11/12/2026 (início + 1 mês − 1 dia)");
        expect(termEndSentence("2026-11-12", null)).toBeNull();
        expect(termEndSentence("", 12)).toBeNull();
        expect(brDate("2027-03-05")).toBe("05/03/2027");
    });

    it("reads the months as typed", () => {
        expect(parseMonths("")).toBeNull();
        expect(parseMonths("  ")).toBeNull();
        expect(parseMonths(" 12 ")).toBe(12);
        expect(parseMonths("1,5")).toBeNaN();
        expect(parseMonths("doze")).toBeNaN();
    });

    it("says what is wrong with the months, in the server's words, and nothing when empty", () => {
        expect(monthsError("")).toBeNull();
        expect(monthsError("12")).toBeNull();
        expect(monthsError("0")).toBe("Use um prazo de 1 mês ou mais.");
        expect(monthsError("601")).toBe("Confira o prazo: isso passa de 50 anos.");
        expect(monthsError("x")).toBe("Use um prazo em meses, com número inteiro.");
    });

    it("warns, never errors, about a start far in the past", () => {
        const today = new Date("2026-10-23T12:00:00Z");
        expect(startNotice("2018-01-10", today)).toMatch(/mais de 5 anos/);
        expect(startNotice("2024-01-10", today)).toBeNull();
        expect(startNotice("", today)).toBeNull();
        expect(startNotice("2026-02-31", today)).toBeNull();
    });

    it("accepts an empty e-mail and a plain one, and rejects the rest", () => {
        expect(emailError("")).toBeNull();
        expect(emailError("  ")).toBeNull();
        expect(emailError("nome@empresa.com")).toBeNull();
        expect(emailError("nome@empresa")).toBe("Esse e-mail não parece certo. Confira e tente de novo.");
        expect(emailError("sem arroba")).toBe("Esse e-mail não parece certo. Confira e tente de novo.");
        expect(emailError(`${"a".repeat(250)}@b.co`)).toBe("Esse e-mail não parece certo. Confira e tente de novo.");
    });
});
