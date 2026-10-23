import { describe, expect, it } from "vitest";
import {
    brDate,
    contractTypeLabel,
    daysUntil,
    fichaProgress,
    sortPortfolio,
    type PortfolioRow,
} from "./contractsPortfolio";

const row = (over: Partial<PortfolioRow>): PortfolioRow => ({
    project_id: "p",
    name: "Contrato",
    counterparty: null,
    contract_type: null,
    lane: null,
    term_end: null,
    notice_days: null,
    notice_deadline: null,
    filled: 0,
    verified: 0,
    total: 24,
    risk: null,
    ...over,
});

describe("contractsPortfolio", () => {
    it("counts whole calendar days to a date, negative once past", () => {
        const today = new Date(2026, 9, 20, 23, 30);
        expect(daysUntil("2026-10-20", today)).toBe(0);
        expect(daysUntil("2026-10-21", today)).toBe(1);
        expect(daysUntil("2026-10-19", today)).toBe(-1);
    });

    it("puts the soonest notice first and contracts without one last, by name", () => {
        const rows = [
            row({ project_id: "c", name: "Cessão Beta" }),
            row({ project_id: "b", name: "Beta", notice_deadline: "2026-12-01" }),
            row({ project_id: "a", name: "Alfa", notice_deadline: "2026-11-01" }),
            row({ project_id: "d", name: "Atlas" }),
        ];
        expect(sortPortfolio(rows, "aviso").map((r) => r.project_id)).toEqual(["a", "b", "d", "c"]);
    });

    it("breaks a tie on the same notice date by name", () => {
        const rows = [
            row({ project_id: "z", name: "Zeta", notice_deadline: "2026-11-01" }),
            row({ project_id: "a", name: "Alfa", notice_deadline: "2026-11-01" }),
        ];
        expect(sortPortfolio(rows, "aviso").map((r) => r.project_id)).toEqual(["a", "z"]);
    });

    it("sorts by name when asked, without changing the input", () => {
        const rows = [row({ project_id: "b", name: "Beta" }), row({ project_id: "a", name: "Alfa" })];
        expect(sortPortfolio(rows, "nome").map((r) => r.project_id)).toEqual(["a", "b"]);
        expect(rows[0].project_id).toBe("b");
    });

    it("describes the Ficha's progress", () => {
        expect(fichaProgress({ filled: 12, total: 24 })).toBe("12 de 24 preenchidos");
        expect(fichaProgress({ filled: 0, total: 0 })).toBe("sem Ficha");
    });

    it("formats a date the Brazilian way without moving the day", () => {
        expect(brDate("2027-01-10")).toBe("10/01/2027");
        expect(brDate("2027-01-10T00:00:00Z")).toBe("10/01/2027");
        expect(brDate(null)).toBe("—");
    });

    it("names the contract type for a person, never the stored key", () => {
        expect(contractTypeLabel("prestacao_servicos")).toBe("Prestação de serviços");
        expect(contractTypeLabel("tratamento_dados")).toBe("Tratamento de dados");
        expect(contractTypeLabel("nda")).toBe("NDA");
        expect(contractTypeLabel(null)).toBe("—");
        expect(contractTypeLabel("")).toBe("—");
    });

    it("falls back to readable words for a type it does not know", () => {
        expect(contractTypeLabel("seguro_garantia")).toBe("Seguro garantia");
        expect(contractTypeLabel("___")).toBe("—");
    });
});
