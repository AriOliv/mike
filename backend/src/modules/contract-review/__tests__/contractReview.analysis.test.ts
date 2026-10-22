import { describe, expect, it } from "vitest";
import {
    analysisCounts,
    analysisPrompt,
    ANALYSIS_NOTICE,
    estimateUsage,
    normalizeAnalysis,
    withMissingIntake,
} from "../contractReview.analysis";

// A fictitious contract: no real party or clause.
const CONTRACT = [
    "1. OBJETO. A Fornecedora Exemplo Ltda. prestará serviços de suporte à Empresa Teste S.A.",
    "5.1 A Contratante pagará multa de 50% do valor total em caso de rescisão antecipada.",
    "7.2 As informações confidenciais serão mantidas em sigilo por prazo indeterminado.",
    "9.1 Fica eleito o foro da Comarca de São Paulo.",
].join("\n");

const answer = {
    executive_summary: { text: "Prestação de serviços de suporte.", object: "Suporte", parties: ["Fornecedora Exemplo", "Empresa Teste"], value: null },
    critical: [
        { title: "Multa rescisória alta", quote: "pagará multa de 50% do valor total", clause: "cl. 5.1", rationale: "Desproporcional.", rule_id: "multa" },
        { title: "Trecho inventado", quote: "a Contratante renuncia a qualquer indenização", clause: "cl. 8", rationale: "x" },
    ],
    attention: [
        { title: "Sigilo sem prazo", quote: "mantidas  em SIGILO por prazo indeterminado", clause: "cl. 7.2", rationale: "Perpétuo.", suggestion: "Limitar a 5 anos.", rule_id: "prazo" },
        { title: "Sem trecho", quote: "", rationale: "y" },
    ],
    favorable: [{ title: "Foro em São Paulo", quote: "Fica eleito o foro da Comarca de São Paulo.", clause: "cl. 9.1", rationale: "Bom." }],
    redlines: [
        { clause: "cl. 5.1", from: "multa de 50% do valor total", to: "multa de 10% do valor remanescente", why: "Proporcionalidade.", item_index: { section: "critical", index: 0 } },
        { clause: "cl. 3", from: "texto que não existe", to: "y", why: "z" },
    ],
    compliance: { data_protection: "Não trata dados pessoais.", confidentiality: "Sigilo perpétuo.", governing_law_forum: "Foro em SP.", term_termination_penalties: "Multa alta." },
    open_points: [{ text: "Aprovação do founder.", depends_on: "founder" }, { text: "Valor do contrato", depends_on: "chefe" }],
};

describe("normalizeAnalysis", () => {
    it("keeps only items and redlines whose quote is in the contract, and records what it dropped", () => {
        const { result, dropped } = normalizeAnalysis(answer, CONTRACT);
        expect(result.critical.map((i) => i.title)).toEqual(["Multa rescisória alta"]);
        expect(result.attention.map((i) => i.title)).toEqual(["Sigilo sem prazo"]);
        expect(result.favorable).toHaveLength(1);
        expect(dropped).toEqual([
            { section: "critical", title: "Trecho inventado", quote: "a Contratante renuncia a qualquer indenização", reason: "trecho não encontrado no documento" },
            { section: "attention", title: "Sem trecho", quote: "", reason: "sem trecho citado" },
            { section: "redlines", title: "cl. 3", quote: "texto que não existe", reason: "trecho DE não encontrado no documento" },
        ]);
        // Case and spacing do not make a real quote fail; its span points at the contract.
        const sigilo = result.attention[0];
        expect(CONTRACT.slice(sigilo.span!.start, sigilo.span!.end)).toBe("mantidas em sigilo por prazo indeterminado");
        expect(result.redlines).toEqual([
            expect.objectContaining({ id: "r1", clause: "cl. 5.1", item_id: "c1", from: "multa de 50% do valor total" }),
        ]);
        expect(result.notice).toBe(ANALYSIS_NOTICE);
        expect(result.open_points.map((p) => p.depends_on)).toEqual(["founder", "outro"]);
        expect(analysisCounts(result)).toEqual({ critical: 1, attention: 1 });
    });

    it("lets the playbook's verdict on a rule set the item's light and section", () => {
        const { result } = normalizeAnalysis(answer, CONTRACT, [
            { ruleId: "multa", ruleName: "Multa", status: "needs_review" },
            { ruleId: "prazo", ruleName: "Prazo", status: "unacceptable" },
        ]);
        expect(result.critical.map((i) => [i.title, i.light, i.rule_id])).toEqual([["Sigilo sem prazo", "red", "prazo"]]);
        expect(result.attention.map((i) => [i.title, i.light])).toEqual([["Multa rescisória alta", "yellow"]]);
    });

    it("survives an empty or malformed answer", () => {
        const { result, dropped } = normalizeAnalysis(null, CONTRACT);
        expect(result).toMatchObject({ critical: [], attention: [], favorable: [], redlines: [], open_points: [], notice: ANALYSIS_NOTICE });
        expect(dropped).toEqual([]);
    });
});

describe("analysisPrompt", () => {
    it("frames the review with the intake answers and the playbook's verdicts", () => {
        const prompt = analysisPrompt({
            documentText: CONTRACT,
            documentName: "Contrato.docx",
            intake: [{ key: "proposito", label: "Motivo da contratação", value: "Suporte técnico" }],
            playbook: { name: "NDA", findings: [{ ruleId: "multa", ruleName: "Multa", status: "unacceptable", analysis: "alta" }, { ruleId: "x", ruleName: "X", status: "not_applicable" }] },
        });
        expect(prompt).toContain("- Motivo da contratação: Suporte técnico");
        expect(prompt).toContain('"rule_id":"multa"');
        expect(prompt).not.toContain('"rule_id":"x"');
        expect(prompt).toContain("NUNCA diga se a Avenia deve ou não assinar");
        expect(prompt).toContain("CONTRATO (Contrato.docx)");
    });

    it("uses the general criterion and flags a missing intake", () => {
        const prompt = analysisPrompt({ documentText: CONTRACT, documentName: "c.pdf", intake: [], playbook: null });
        expect(prompt).toContain("critério geral");
        expect(prompt).toContain("checklist de intake não foi preenchido");
    });
});

describe("withMissingIntake and estimateUsage", () => {
    it("adds an open point only when the intake is empty", () => {
        const { result } = normalizeAnalysis(answer, CONTRACT);
        expect(withMissingIntake(result, [])).toMatchObject({ open_points: [{ id: "o0", depends_on: "outro" }, {}, {}] });
        expect(withMissingIntake(result, [{ key: "a", label: "A", value: "b" }])).toBe(result);
    });

    it("estimates tokens and cost from characters and the model family's list price", () => {
        expect(estimateUsage("claude-sonnet-5-5", [{ input: 400_000, output: 40_000 }, { input: 0, output: 0 }])).toEqual({
            model: "claude-sonnet-5-5",
            calls: 2,
            input_tokens: 100_000,
            output_tokens: 10_000,
            estimated_cost_usd: 0.45,
            estimated: true,
        });
        expect(estimateUsage("gemini-4-argon", [{ input: 4, output: 4 }]).estimated_cost_usd).toBeNull();
    });
});
