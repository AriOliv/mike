import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
    applyFieldDecision,
    correctionChoices,
    validCorrection,
    extractionPrompt,
    fichaProgress,
    FICHA_FIELDS,
    locateQuote,
    mergeExtraction,
    normalizeExtraction,
    type Ficha,
    type FichaField,
    type FichaPath,
} from "../contractReview.ficha";
import { durationDays, evaluateRules, overallRisk, RISK_PARAMS, RULES } from "../contractReview.rules";
import { AVENIA_PLAYBOOK_CONTENT, RULE_RISK_RULES } from "../contractReview.playbook";

const CONTRACT = `CLÁUSULA 7 – CESSÃO
7.1 A CONTRATANTE não poderá ceder este Contrato sem o prévio consentimento por escrito da CONTRATADA.

CLÁUSULA 9 – VIGÊNCIA
9.1 Este Contrato será renovado automaticamente por iguais períodos, salvo aviso com 30 (trinta) dias de antecedência.`;

function field(value: unknown, extra: Partial<FichaField> = {}): FichaField {
    return {
        status: "encontrado",
        value,
        citations: [{ quote: "x", clause: null, span: null, verified: true, match: "exato" }],
        confidence: "alta",
        origin: "ia",
        notes: null,
        review: { state: "pendente", by: null, at: null, comment: null },
        ...extra,
    };
}

describe("locateQuote", () => {
    it("finds a quote exactly, then ignoring case and spacing", () => {
        expect(locateQuote(CONTRACT, "renovado automaticamente")).toMatchObject({ match: "exato" });
        const loose = locateQuote(CONTRACT, "RENOVADO   automaticamente por\niguais períodos");
        expect(loose.match).toBe("normalizado");
        expect(CONTRACT.slice(loose.span!.start, loose.span!.end)).toBe("renovado automaticamente por iguais períodos");
        expect(locateQuote(CONTRACT, "cláusula inexistente")).toEqual({ match: "nao_encontrado", span: null });
        expect(locateQuote(CONTRACT, "  ")).toEqual({ match: "nao_encontrado", span: null });
    });
});

describe("normalizeExtraction", () => {
    it("verifies quotes, lowers confidence and enforces the envelope", () => {
        const ficha = normalizeExtraction(
            {
                fields: {
                    "vigencia.renovacao": {
                        status: "encontrado",
                        value: { tipo: "automatica", aviso_nao_renovacao: { amount: 30, unit: "dias", day_count: "nao_especificado" } },
                        citations: [{ quote: "renovado automaticamente por iguais períodos", clause: "cl. 9.1" }],
                        confidence: "alta",
                    },
                    "alteracao_parte.cessao": {
                        status: "encontrado",
                        value: { regime: "consentimento_previo" },
                        citations: [{ quote: "texto que o contrato não tem" }],
                        confidence: "alta",
                    },
                    "foro.lei_aplicavel": { status: "encontrado", value: { jurisdicao: "BR" }, citations: [] },
                    "responsabilidade.limitacao": { status: "nao_encontrado", value: { existe: true } },
                    "identificacao.papel_avenia": { status: "inferido", value: null },
                    "dados_pessoais.dpa": { status: "estranho", value: "anexo", confidence: "talvez", citations: [{ quote: "7.1 A CONTRATANTE" }] },
                    "campo.inventado": { status: "encontrado", value: 1 },
                    "rescisao.imotivada": "não é objeto",
                },
            },
            CONTRACT,
        );
        const renovacao = ficha["vigencia.renovacao"]!;
        expect(renovacao.citations[0]).toMatchObject({ verified: true, match: "exato", clause: "cl. 9.1" });
        expect(renovacao.confidence).toBe("alta");
        expect(ficha["alteracao_parte.cessao"]).toMatchObject({ confidence: "baixa", citations: [{ verified: false }] });
        expect(ficha["foro.lei_aplicavel"]).toMatchObject({ status: "ambiguo", notes: "Valor sem citação: confira no documento." });
        expect(ficha["responsabilidade.limitacao"]).toMatchObject({ status: "nao_encontrado", value: null, confidence: null });
        expect(ficha["identificacao.papel_avenia"]).toMatchObject({ status: "nao_encontrado" });
        expect(ficha["dados_pessoais.dpa"]).toMatchObject({ status: "ambiguo", confidence: "baixa" });
        expect(ficha["rescisao.imotivada"]).toMatchObject({ status: "nao_encontrado", notes: "A extração não retornou este campo." });
        expect(Object.keys(ficha)).toHaveLength(FICHA_FIELDS.length);
        expect(normalizeExtraction(null, CONTRACT)["vigencia.prazo"]?.status).toBe("nao_encontrado");
    });

    it("marks an approximate quote as normalized and drops alta to media", () => {
        const ficha = normalizeExtraction(
            {
                fields: {
                    "vigencia.prazo": {
                        status: "encontrado",
                        value: { tipo: "determinado" },
                        citations: [{ quote: "ESTE CONTRATO será renovado" }],
                        confidence: "alta",
                        notes: " nota ",
                    },
                },
            },
            CONTRACT,
        );
        expect(ficha["vigencia.prazo"]).toMatchObject({ confidence: "media", notes: "nota", citations: [{ match: "normalizado" }] });
    });
});

describe("mergeExtraction and decisions", () => {
    const at = "2026-10-20T12:00:00.000Z";

    it("never overwrites what a person confirmed or corrected", () => {
        const confirmed = applyFieldDecision(field({ regime: "vedada" }), { action: "confirmar", by: "duda@avenia.io" }, at);
        const corrected = applyFieldDecision(
            field({ jurisdicao: "US" }),
            { action: "corrigir", by: "duda@avenia.io", value: { jurisdicao: "BR" }, comment: "lei BR na cl. 20" },
            at,
        );
        expect(confirmed.review).toEqual({ state: "confirmado", by: "duda@avenia.io", at, comment: null });
        expect(corrected).toMatchObject({ origin: "humano", ai_value: { jurisdicao: "US" }, value: { jurisdicao: "BR" } });
        const previous: Ficha = {
            "alteracao_parte.cessao": confirmed,
            "foro.lei_aplicavel": corrected,
            "vigencia.prazo": field({ tipo: "determinado" }),
        };
        const next: Ficha = {
            "alteracao_parte.cessao": field({ regime: "livre" }),
            "foro.lei_aplicavel": field({ jurisdicao: "BR" }),
            "vigencia.prazo": field({ tipo: "indeterminado" }),
        };
        const merged = mergeExtraction(previous, next);
        expect(merged["alteracao_parte.cessao"]).toMatchObject({
            value: { regime: "vedada" },
            ai_value: { regime: "livre" },
            notes: "A IA leu diferente na nova versão do documento.",
        });
        expect(merged["foro.lei_aplicavel"]).toBe(corrected);
        expect(merged["vigencia.prazo"]?.value).toEqual({ tipo: "indeterminado" });
        expect(mergeExtraction(null, next)).toBe(next);
    });

    it("correcting a missing field marks it found, and clearing one marks it missing", () => {
        const missing = field(null, { status: "nao_encontrado" });
        expect(applyFieldDecision(missing, { action: "corrigir", by: "a", value: true }, at).status).toBe("encontrado");
        expect(applyFieldDecision(field(true), { action: "corrigir", by: "a", value: null }, at).status).toBe("nao_encontrado");
        const twice = applyFieldDecision(
            applyFieldDecision(field(1), { action: "corrigir", by: "a", value: 2 }, at),
            { action: "corrigir", by: "b", value: 3 },
            at,
        );
        expect(twice.ai_value).toBe(1);
    });

    it("counts verified fields, leaving out what does not apply", () => {
        expect(fichaProgress(null)).toEqual({ verified: 0, total: 0 });
        expect(
            fichaProgress({
                "vigencia.prazo": applyFieldDecision(field(1), { action: "confirmar", by: "a" }, at),
                "vigencia.renovacao": field(2),
                "foro.lei_aplicavel": field(null, { status: "nao_aplicavel" }),
            }),
        ).toEqual({ verified: 1, total: 2 });
    });

    it("asks for literal values with verbatim quotes", () => {
        const prompt = extractionPrompt("CONTRATO X");
        expect(prompt).toContain("Extraia o LITERAL");
        expect(prompt).toContain("alteracao_parte.mudanca_controle (Mudança de controle)");
        expect(prompt.endsWith("CONTRATO X")).toBe(true);
    });
});

describe("risk rules", () => {
    const ficha = (fields: Partial<Record<FichaPath, unknown>>, papel = "contratada", categoria = "prestacao_servicos"): Ficha => {
        const out: Ficha = {
            "identificacao.papel_avenia": field(papel),
            "identificacao.tipo_contrato": field({ categoria }),
            "responsabilidade.limitacao": field({ existe: true, protege: "ambas", tipo: "meses_remuneracao", meses: 12 }),
        };
        for (const [path, value] of Object.entries(fields)) out[path as FichaPath] = value === "ausente" ? field(null, { status: "nao_encontrado" }) : field(value);
        return out;
    };
    const ids = (f: Ficha) => evaluateRules(f).map((finding) => finding.rule_id);

    it("converts durations to calendar days conservatively", () => {
        expect(durationDays({ amount: 48, unit: "horas" })).toBe(2);
        expect(durationDays({ amount: 10, unit: "dias", day_count: "uteis" })).toBe(14);
        expect(durationDays({ amount: 30, unit: "dias", day_count: "corridos" })).toBe(30);
        expect(durationDays({ amount: 2, unit: "meses" })).toBe(60);
        expect(durationDays({ amount: 1, unit: "anos" })).toBe(365);
        expect(durationDays({ amount: 1, unit: "semanas" })).toBeNull();
        expect(durationDays({ amount: "x" })).toBeNull();
        expect(durationDays(null)).toBeNull();
    });

    it("fires each rule on its condition and not on the safe position", () => {
        const aviso = (amount: number) => ({ tipo: "automatica", aviso_nao_renovacao: { amount, unit: "dias", day_count: "corridos" } });
        expect(ids(ficha({ "vigencia.renovacao": aviso(30) }))).toContain("REN-01");
        expect(ids(ficha({ "vigencia.renovacao": aviso(60) }))).not.toContain("REN-01");
        expect(ids(ficha({ "vigencia.prazo": { tipo: "indeterminado" }, "rescisao.imotivada": { permitida_para: "nenhuma" } }))).toContain("REN-03");
        expect(ids(ficha({ "rescisao.imotivada": { permitida_para: "somente_contraparte" } }))).toContain("RES-01");
        expect(ids(ficha({ "rescisao.multa_rescisoria": { existe: true, devida_por: "avenia", percentual: 30 } }))).toContain("RES-02");
        expect(ids(ficha({ "rescisao.multa_rescisoria": { existe: true, devida_por: "avenia", meses: 6 } }))).toContain("RES-02");
        expect(ids(ficha({ "rescisao.multa_rescisoria": { existe: true, devida_por: "ambas", tipo: "percentual_valor_total" } }))).toContain("RES-02");
        expect(ids(ficha({ "rescisao.multa_rescisoria": { existe: true, devida_por: "contraparte", percentual: 30 } }))).not.toContain("RES-02");
        expect(ids(ficha({ "rescisao.multa_rescisoria": { existe: false } }))).not.toContain("RES-02");
        expect(ids(ficha({ "alteracao_parte.mudanca_controle": { aplica_a: "ambas", regime: "consentimento_previo", define_controle: true } }))).toEqual(["ALT-01"]);
        expect(ids(ficha({ "alteracao_parte.mudanca_controle": { aplica_a: "avenia", regime: "livre", direito_rescisao_contraparte: true } }))).toContain("ALT-01");
        expect(ids(ficha({ "alteracao_parte.mudanca_controle": { aplica_a: "contraparte", regime: "notificacao" } }))).toEqual(["ALT-02"]);
        expect(ids(ficha({ "alteracao_parte.cessao": { aplica_a: "ambas", regime: "vedada", excecoes: [] } }))).toContain("ALT-03");
        expect(ids(ficha({ "alteracao_parte.cessao": { aplica_a: "ambas", regime: "vedada", excecoes: ["afiliadas"] } }))).not.toContain("ALT-03");
        expect(ids(ficha({ "alteracao_parte.cessao": { aplica_a: "contraparte", regime: "livre" } }))).toContain("ALT-04");
        expect(ids(ficha({ "responsabilidade.multa_geral": { existe: true, devida_por: "avenia", limitada: false } }))).toContain("RSP-04");
        expect(ids(ficha({ "dados_pessoais.compartilhamento": true, "dados_pessoais.papel_avenia": "ausente" }))).toContain("LGP-01");
        expect(ids(ficha({ "dados_pessoais.compartilhamento": true, "dados_pessoais.papel_avenia": "operador" }))).not.toContain("LGP-01");
        expect(ids(ficha({ "dados_pessoais.dpa": "por_referencia" }))).toContain("LGP-02");
        expect(ids(ficha({ "dados_pessoais.transferencia_internacional": { ocorre: true } }))).toContain("LGP-03");
        expect(ids(ficha({ "regulatorio.confidencialidade": { existe: true, carve_out_autoridades: false } }))).toContain("REG-01");
        expect(ids(ficha({ "regulatorio.confidencialidade": { existe: true, carve_out_autoridades: true, exige_aviso_previo_a_contraparte: true } }))).toEqual(["REG-02"]);
        expect(ids(ficha({ "foro.lei_aplicavel": { jurisdicao: "us" } }))).toContain("FOR-01");
        expect(ids(ficha({ "foro.lei_aplicavel": { jurisdicao: "BR" } }))).not.toContain("FOR-01");
    });

    it("never fires on a theme the contract does not treat", () => {
        expect(ids(ficha({ "alteracao_parte.cessao": "ausente", "foro.lei_aplicavel": "ausente" }))).toEqual([]);
    });

    it("flags a missing liability cap only where the Avenia provides the service", () => {
        expect(ids(ficha({ "responsabilidade.limitacao": "ausente" }))).toContain("RSP-01");
        expect(ids(ficha({ "responsabilidade.limitacao": "ausente" }, "contratante"))).not.toContain("RSP-01");
        const na = ficha({});
        na["responsabilidade.limitacao"] = field(null, { status: "nao_aplicavel" });
        expect(ids(na)).not.toContain("RSP-01");
    });

    it("raises severity for a critical partner and applies the partner-only rules", () => {
        const critical = ficha(
            {
                "rescisao.imotivada": { permitida_para: "somente_contraparte", aviso_previo_contraparte: { amount: 30, unit: "dias", day_count: "corridos" } },
                "responsabilidade.limitacao": { protege: "contraparte", meses: 3 },
                "alteracao_parte.cessao": { aplica_a: "contraparte", regime: "livre" },
            },
            "contratante",
            "parceiro_bancario_baas",
        );
        const found = evaluateRules(critical);
        expect(found.map((f) => [f.rule_id, f.severidade])).toEqual([
            ["RES-01", "critica"],
            ["RES-03", "critica"],
            ["ALT-04", "alta"],
            ["RSP-03", "alta"],
        ]);
        expect(found.every((f) => f.depende_de_campo_nao_validado)).toBe(true);
        expect(overallRisk(found)).toBe("critico");
        expect(overallRisk(found.filter((f) => f.severidade === "alta"))).toBe("atencao");
        expect(overallRisk([])).toBe("ok");
    });
});

describe("drift against docs/product", () => {
    const yamlPath = path.resolve(__dirname, "../../../../../docs/product/risk-rules.v1.yaml");
    let yaml: { parametros: Record<string, unknown>; regras: { id: string; severidade: string; avaliacao: string }[] } | null = null;
    try {
        yaml = parse(readFileSync(yamlPath, "utf8"));
    } catch {
        yaml = null;
    }

    it.skipIf(!yaml)("implements only motor rules of risk-rules.v1 with their severities and parameters", () => {
        const byId = new Map(yaml!.regras.map((rule) => [rule.id, rule]));
        for (const rule of RULES) {
            expect(byId.get(rule.id), rule.id).toBeDefined();
            expect(byId.get(rule.id)!.avaliacao).toBe("motor");
            expect(byId.get(rule.id)!.severidade).toBe(rule.severidade);
        }
        for (const [key, value] of Object.entries(RISK_PARAMS)) expect(yaml!.parametros[key]).toEqual(value);
    });

    it("links each playbook rule to existing risk rules", () => {
        const ruleIds = new Set(AVENIA_PLAYBOOK_CONTENT.topics.flatMap((t) => t.rules.map((r) => r.id)));
        for (const [ruleId, risks] of Object.entries(RULE_RISK_RULES)) {
            expect(ruleIds.has(ruleId), ruleId).toBe(true);
            for (const risk of risks) expect(risk).toMatch(/^[A-Z]{3}-\d{2}$/);
        }
    });
});

describe("corrections", () => {
    it("accepts only values the rules can read", () => {
        expect(validCorrection("identificacao.papel_avenia", "contratada")).toBe(true);
        expect(validCorrection("identificacao.papel_avenia", "fornecedora")).toBe(false);
        expect(validCorrection("dados_pessoais.compartilhamento", false)).toBe(true);
        expect(validCorrection("dados_pessoais.compartilhamento", "não")).toBe(false);
        expect(validCorrection("alteracao_parte.cessao", { regime: "vedada", aplica_a: "avenia", excecoes: [] })).toBe(true);
        expect(validCorrection("alteracao_parte.cessao", { regime: "livre" })).toBe(true);
        expect(validCorrection("alteracao_parte.cessao", { regime: "x" })).toBe(false);
        expect(validCorrection("alteracao_parte.cessao", "vedada")).toBe(false);
        expect(validCorrection("alteracao_parte.cessao", ["vedada"])).toBe(false);
        expect(validCorrection("foro.lei_aplicavel", { jurisdicao: "BR" })).toBe(true);
        expect(validCorrection("foro.lei_aplicavel", [1])).toBe(false);
        expect(validCorrection("foro.lei_aplicavel", undefined)).toBe(false);
        expect(validCorrection("vigencia.prazo", null)).toBe(true);
    });

    it("describes the choices for the correction form", () => {
        expect(correctionChoices("dados_pessoais.compartilhamento")).toBe("boolean");
        expect(correctionChoices("dados_pessoais.dpa")).toEqual([{ key: "", values: ["no_corpo", "anexo", "por_referencia", "ausente"] }]);
        expect(correctionChoices("foro.lei_aplicavel")).toBeNull();
    });
});

