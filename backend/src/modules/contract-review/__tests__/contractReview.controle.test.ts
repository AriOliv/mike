import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    CONTROLE_COLUMNS,
    NAO_ENCONTRADO,
    controleColumnsConfig,
    controleHeader,
    controleRow,
    diasParaVencimento,
    parseSheetDate,
    parseSheetDuration,
} from "../contractReview.service";

// The Legal team's sheet, row 2 (groups) and row 3 (names), as delivered.
const SHEET_GROUPS: Record<string, string> = {
    G: "Pagamento",
    M: "Vigência",
    R: "Rescisão",
    T: "Multa rescisória",
    V: "Cessão",
    Z: "Alteração Controle",
    AD: "Compartilhamento de dados",
    AG: "Alteração de parte",
};
const SHEET_NAMES = [
    "Tipo de Contrato", "Contraparte", "Área responsável", "Link do drive", "Ativo?", "Obrigações periódicas/importantes",
    "Prazo", "Multa", "Juros", "Correção Monetária", "Valor", "Tributos",
    "Data Assinatura", "Prazo de vigência", "Dias para vencimento/renovação", "Data de vencimento", "Renovação Automática",
    "Rescisão antecipada", "Prazo do aviso prévio", "Sim/Não", "Valor",
    "Sim / Não", "Notificação / Autorização", "Prazo antecedência", "Penalidade por não informar",
    "Sim / Não", "Notificação / Autorização", "Prazo antecedência", "Penalidade por não informar",
    "Sim / Não", "Agente", "Multa", "Cessão contratual", "Alteração de Controle",
];

const letter = (n: number) => (n < 26 ? String.fromCharCode(65 + n) : "A" + String.fromCharCode(65 + n - 26));

describe("Controle de Contratos columns", () => {
    it("has the sheet's 34 columns in its order, A..AH", () => {
        expect(CONTROLE_COLUMNS).toHaveLength(34);
        expect(CONTROLE_COLUMNS.map((c) => c.letter)).toEqual(SHEET_NAMES.map((_, i) => letter(i)));
        expect(CONTROLE_COLUMNS.map((c) => c.name)).toEqual(SHEET_NAMES);
        for (const [start, group] of Object.entries(SHEET_GROUPS))
            expect(CONTROLE_COLUMNS.find((c) => c.letter === start)!.group).toBe(group);
    });

    it("maps each column to the Ficha field the schema assigns it (x-planilha)", () => {
        const schemaPath = path.resolve(__dirname, "../../../../../docs/product/contract-schema.v1.json");
        const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
        const byLetter = new Map<string, { field: string; origin: string | null }>();
        const walk = (node: Record<string, unknown>, at: string) => {
            if (typeof node["x-planilha"] === "string")
                for (const l of (node["x-planilha"] as string).split(","))
                    byLetter.set(l.trim(), { field: at, origin: (node["x-origem"] as string) ?? null });
            const props = node.properties as Record<string, Record<string, unknown>> | undefined;
            for (const [key, child] of Object.entries(props ?? {})) walk(child, at ? `${at}.${key}` : key);
        };
        walk(schema, "");
        for (const column of CONTROLE_COLUMNS) {
            const mapped = byLetter.get(column.letter);
            expect(mapped, column.letter).toBeDefined();
            expect(column.field, column.letter).toBe(mapped!.field);
            // Derived columns carry no x-origem in the schema; the rest must agree.
            expect(column.origin, column.letter).toBe(mapped!.origin ?? "derivado");
        }
        expect(byLetter.size).toBe(34);
    });

    it("only asks the model for what is in the contract", () => {
        const config = controleColumnsConfig();
        const asked = CONTROLE_COLUMNS.filter((c) => c.origin === "ia");
        expect(config).toHaveLength(asked.length);
        expect(config.map((c) => c.index)).toEqual(config.map((_, i) => i));
        // Computed, human and platform columns never become prompts.
        for (const name of ["Vigência · Dias para vencimento/renovação", "Área responsável", "Link do drive", "Ativo?"])
            expect(config.map((c) => c.name)).not.toContain(name);
        for (const column of config) {
            expect(column.prompt).toContain(`"${NAO_ENCONTRADO}"`);
            expect(column.prompt).toContain("DD/MM/AAAA");
            if (column.format === "tag") expect(column.tags).toContain(NAO_ENCONTRADO);
        }
        // Same name under two groups stays two distinct headers.
        expect(new Set(config.map((c) => c.name)).size).toBe(config.length);
        expect(config.find((c) => c.name === "Pagamento · Valor")).toBeDefined();
        expect(config.find((c) => c.name === "Multa rescisória · Valor")).toBeDefined();
        expect(controleHeader(CONTROLE_COLUMNS[0])).toBe("Tipo de Contrato");
    });
});

describe("computed columns", () => {
    const today = new Date(Date.UTC(2026, 9, 21, 15));

    it("reads the sheet's dates and terms", () => {
        expect(parseSheetDate("01/03/2025")?.toISOString()).toBe("2025-03-01T00:00:00.000Z");
        expect(parseSheetDate("2025-03-01")?.toISOString()).toBe("2025-03-01T00:00:00.000Z");
        expect(parseSheetDate("31/02/2025")).toBeNull();
        expect(parseSheetDate(NAO_ENCONTRADO)).toBeNull();
        expect(parseSheetDate(null)).toBeNull();
        expect(parseSheetDuration("12 (doze) meses")).toEqual({ amount: 12, unit: "meses", day_count: "nao_especificado" });
        expect(parseSheetDuration("Determinado, 2 anos")).toEqual({ amount: 2, unit: "anos", day_count: "nao_especificado" });
        expect(parseSheetDuration("90 dias corridos")).toEqual({ amount: 90, unit: "dias", day_count: "corridos" });
        expect(parseSheetDuration("5 dias úteis")).toEqual({ amount: 5, unit: "dias", day_count: "uteis" });
        expect(parseSheetDuration("1 mês")).toEqual({ amount: 1, unit: "meses", day_count: "nao_especificado" });
        expect(parseSheetDuration("Indeterminado")).toBeNull();
    });

    it("counts days to the written expiry, else signature plus a fixed term", () => {
        expect(diasParaVencimento({ vencimento: "31/10/2026" }, today)).toBe(10);
        expect(diasParaVencimento({ assinatura: "21/10/2025", prazo: "12 meses" }, today)).toBe(0);
        expect(diasParaVencimento({ assinatura: "01/01/2026", prazo: "1 ano" }, today)).toBe(72);
        expect(diasParaVencimento({ assinatura: "01/10/2026", prazo: "30 dias" }, today)).toBe(10);
        // Past due is negative; an open-ended or unreadable term has no count.
        expect(diasParaVencimento({ vencimento: "11/10/2026" }, today)).toBe(-10);
        expect(diasParaVencimento({ assinatura: "01/01/2026", prazo: "Indeterminado, 12 meses de aviso" }, today)).toBeNull();
        expect(diasParaVencimento({ assinatura: NAO_ENCONTRADO, prazo: "12 meses" }, today)).toBeNull();
        expect(diasParaVencimento({}, today)).toBeNull();
    });

    it("lays a row out in the sheet's order with O computed and the human columns empty", () => {
        const row = controleRow(
            { A: "Prestação de serviços", B: "Empresa Exemplo Ltda.", M: "01/01/2026", N: "12 meses", Q: "Sim", AG: "—" },
            { driveLink: "https://drive.example/x", today },
        );
        expect(row).toHaveLength(34);
        const at = (l: string) => row[CONTROLE_COLUMNS.findIndex((c) => c.letter === l)];
        expect(at("A")).toBe("Prestação de serviços");
        expect(at("C")).toBeNull();
        expect(at("D")).toBe("https://drive.example/x");
        expect(at("E")).toBeNull();
        expect(at("O")).toBe(72);
        expect(at("Q")).toBe("Sim");
        expect(at("AG")).toBe("—");
        expect(at("AF")).toBeNull();
        expect(controleRow({}, { today })[3]).toBeNull();
    });
});
