import { describe, expect, it } from "vitest";
import {
    brDate,
    contractTypeLabel,
    daysUntil,
    assigneeOptions,
    fichaProgress,
    filterPortfolio,
    NO_ASSIGNEE,
    portfolioCsv,
    situationOf,
    sortPortfolio,
    stageLabel,
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
    assignee: null,
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

    describe("situation, stage, filter and export", () => {
        const today = new Date(2026, 9, 20);

        it("reads the situation from the lane and the term end", () => {
            expect(situationOf(row({ lane: "revisao" }), today)).toBe("andamento");
            expect(situationOf(row({ lane: null }), today)).toBe("andamento");
            expect(situationOf(row({ lane: "assinatura" }), today)).toBe("assinatura");
            expect(situationOf(row({ lane: "arquivado", term_end: "2026-10-20" }), today)).toBe("vigente");
            expect(situationOf(row({ lane: "arquivado", term_end: "2026-10-19" }), today)).toBe("vencido");
            expect(situationOf(row({ lane: "arquivado", term_end: null }), today)).toBe("vigente");
        });

        it("names the stage, and has no stage for an unknown lane", () => {
            expect(stageLabel("revisao")).toBe("Análise");
            expect(stageLabel("arquivado")).toBe("Concluído");
            expect(stageLabel("outra")).toBe("—");
            expect(stageLabel(null)).toBe("—");
        });

        const rows = [
            row({ project_id: "a", name: "Prestação — Ação", counterparty: "Açaí Ltda", contract_type: "prestacao_servicos", lane: "arquivado", assignee: "Duda" }),
            row({ project_id: "b", name: "NDA Beta", lane: "revisao", assignee: null }),
            row({ project_id: "c", name: "MSA Gama", lane: "assinatura", assignee: "Bia" }),
        ];
        const all = { tab: "todos", query: "", assignee: "" } as const;

        it("filters by tab, owner and a search that ignores case and accents", () => {
            const ids = (f: Parameters<typeof filterPortfolio>[1]) => filterPortfolio(rows, f, today).map((r) => r.project_id);
            expect(ids(all)).toEqual(["a", "b", "c"]);
            expect(ids({ ...all, tab: "assinatura" })).toEqual(["c"]);
            expect(ids({ ...all, assignee: "Duda" })).toEqual(["a"]);
            expect(ids({ ...all, assignee: NO_ASSIGNEE })).toEqual(["b"]);
            expect(ids({ ...all, query: "  ACAI " })).toEqual(["a"]);
            expect(ids({ ...all, query: "prestação de serviços" })).toEqual(["a"]);
            expect(ids({ ...all, query: "nda", tab: "assinatura" })).toEqual([]);
        });

        it("lists the owners once, by name", () => {
            expect(assigneeOptions([...rows, row({ assignee: "Bia" })])).toEqual(["Bia", "Duda"]);
        });

        it("exports a CSV Excel opens: BOM, semicolons, quoted cells, no live formulas", () => {
            const csv = portfolioCsv(
                [
                    row({ name: 'Contrato "X"; teste', counterparty: "=HYPERLINK(1)", contract_type: "nda", lane: "arquivado", term_end: "2026-12-31", notice_deadline: "2026-11-01", assignee: "Duda" }),
                    row({ name: "Sem dados" }),
                ],
                today,
            );
            const lines = csv.replace("\uFEFF", "").trimEnd().split("\r\n");
            expect(csv.startsWith("\uFEFF")).toBe(true);
            expect(lines[0]).toBe("Contrato;Contraparte;Tipo;Situação;Etapa;Responsável;Vencimento;Aviso até");
            expect(lines[1]).toBe('"Contrato ""X""; teste";\'=HYPERLINK(1);NDA;Vigente;Concluído;Duda;31/12/2026;01/11/2026');
            expect(lines[2]).toBe("Sem dados;;—;Em andamento;—;;;");
        });
    });
});
