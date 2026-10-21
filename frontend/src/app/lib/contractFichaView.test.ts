import { describe, expect, it } from "vitest";
import type { FichaField } from "./mikeApi";
import { correctedValue, correctionDraft, correctionForm, fichaGroups, fieldSummary } from "./contractFichaView";

const field = (value: unknown, status: FichaField["status"] = "encontrado"): FichaField => ({
    status,
    value,
    citations: [],
    confidence: "alta",
    origin: "ia",
    notes: null,
    review: { state: "pendente", by: null, at: null, comment: null },
});

describe("fieldSummary", () => {
    it("says plain values in words", () => {
        expect(fieldSummary(field(null))).toBe("");
        expect(fieldSummary(field(true))).toBe("Sim");
        expect(fieldSummary(field(false))).toBe("Não");
        expect(fieldSummary(field("por_referencia"))).toBe("só por referência (documento externo)");
        expect(fieldSummary(field("algo_novo"))).toBe("algo novo");
        expect(fieldSummary(field(3))).toBe("3");
    });

    it("says structured values in one line", () => {
        expect(
            fieldSummary(field({ tipo: "automatica", aviso_nao_renovacao: { amount: 30, unit: "dias", day_count: "corridos" } })),
        ).toBe("Automática, aviso de 30 dias corridos");
        expect(fieldSummary(field({ tipo: "determinado", duracao: { amount: 12, unit: "meses", day_count: "nao_especificado" } }))).toBe(
            "Determinado, 12 meses",
        );
        expect(
            fieldSummary(
                field({
                    permitida_para: "ambas",
                    aviso_previo_avenia: { amount: 10, unit: "dias", day_count: "uteis" },
                    aviso_previo_contraparte: { amount: 60, unit: "dias", day_count: "nao_especificado" },
                }),
            ),
        ).toBe("Ambas as partes, aviso da Avenia: 10 dias úteis, aviso da contraparte: 60 dias");
        expect(fieldSummary(field({ regime: "vedada", aplica_a: "avenia", excecoes: ["afiliadas", "outro"] }))).toBe(
            "Vedada, para Avenia, exceto afiliadas, outro",
        );
        expect(fieldSummary(field({ regime: "notificacao", direito_rescisao_contraparte: true, define_controle: false }))).toBe(
            "Mediante notificação, contraparte pode rescindir, sem definição de controle",
        );
        expect(fieldSummary(field({ existe: true, tipo: "percentual_saldo", percentual: 20, meses: 3, devida_por: "avenia" }))).toBe(
            "% do saldo, 20%, 3 meses, devida por Avenia",
        );
        expect(fieldSummary(field({ existe: true, protege: "ambas", limitada: false }))).toBe("Sim, protege ambas as partes, sem teto");
        expect(fieldSummary(field({ existe: false }))).toBe("Não");
        expect(fieldSummary(field({ existe: true }))).toBe("Sim");
        expect(fieldSummary(field({ existe: true, carve_out_autoridades: true }))).toBe("Sim, com exceção para autoridades");
        expect(fieldSummary(field({ existe: true, carve_out_autoridades: false, exige_aviso_previo_a_contraparte: true }))).toBe(
            "Sim, sem exceção para autoridades, exige avisar a contraparte antes",
        );
        expect(fieldSummary(field({ ocorre: true, mecanismo: "cláusulas-padrão" }))).toBe("Sim, cláusulas-padrão");
        expect(fieldSummary(field({ jurisdicao: "BR" }))).toBe("Brasil");
        expect(fieldSummary(field({ ocorre: false }))).toBe("Não");
        expect(fieldSummary(field({ regime: "livre", excecoes: [3] }))).toBe("Livre, exceto ");
        expect(fieldSummary(field({ jurisdicao: "US-NY" }))).toBe("US-NY");
        expect(fieldSummary(field({ nome: "Polaris Tecnologia Ltda." }))).toBe("Polaris Tecnologia Ltda.");
        expect(fieldSummary(field({ categoria: "parceiro_bancario_baas" }))).toBe("Parceiro bancário / BaaS");
        expect(fieldSummary(field({ duracao: { amount: "x", unit: "dias" } }))).toBe('{"duracao":{"amount":"x","unit":"dias"}}');
        expect(fieldSummary(field({ duracao: null, aviso_nao_renovacao: 3 }))).toBe('{"duracao":null,"aviso_nao_renovacao":3}');
    });
});

describe("fichaGroups", () => {
    it("keeps the spreadsheet's order and leaves out what does not apply", () => {
        const groups = fichaGroups({
            "foro.lei_aplicavel": field({ jurisdicao: "BR" }),
            "vigencia.renovacao": field({ tipo: "automatica" }),
            "vigencia.prazo": field(null, "nao_aplicavel"),
        });
        expect(groups.map((g) => g.title)).toEqual(["Vigência e rescisão", "Responsabilidade, confidencialidade e foro"]);
        expect(groups[0].fields.map((f) => f.label)).toEqual(["Renovação"]);
    });
});

describe("corrections", () => {
    it("builds the form from the field's choices", () => {
        expect(correctionForm("dados_pessoais.compartilhamento", "boolean")).toEqual({ kind: "boolean" });
        expect(correctionForm("alteracao_parte.cessao", [{ key: "regime", values: ["livre", "vedada"] }, { key: "aplica_a", values: ["avenia"] }])).toEqual({
            kind: "choice",
            key: "regime",
            options: [
                { value: "livre", label: "livre" },
                { value: "vedada", label: "vedada" },
            ],
        });
        expect(correctionForm("foro.lei_aplicavel", null)).toEqual({ kind: "text", key: "jurisdicao" });
        expect(correctionForm("foro.lei_aplicavel", [])).toEqual({ kind: "text", key: "jurisdicao" });
        expect(correctionForm("vigencia.renovacao", undefined)).toBeNull();
    });

    it("shows the current value and keeps the rest of the structure on save", () => {
        expect(correctionDraft({ kind: "boolean" }, true)).toBe("true");
        expect(correctionDraft({ kind: "boolean" }, false)).toBe("false");
        expect(correctionDraft({ kind: "boolean" }, null)).toBe("");
        const regime = { kind: "choice" as const, key: "regime", options: [] };
        expect(correctionDraft(regime, { regime: "vedada", aplica_a: "avenia" })).toBe("vedada");
        expect(correctionDraft(regime, null)).toBe("");
        const plain = { kind: "choice" as const, key: "", options: [] };
        expect(correctionDraft(plain, "anexo")).toBe("anexo");
        expect(correctedValue({ kind: "boolean" }, true, "false")).toBe(false);
        expect(correctedValue({ kind: "boolean" }, true, "true")).toBe(true);
        expect(correctedValue({ kind: "boolean" }, true, "")).toBeNull();
        expect(correctedValue(regime, { regime: "vedada", aplica_a: "avenia" }, "livre")).toEqual({ regime: "livre", aplica_a: "avenia" });
        expect(correctedValue(regime, null, "livre")).toEqual({ regime: "livre" });
        expect(correctedValue(regime, ["x"], "livre")).toEqual({ regime: "livre" });
        expect(correctedValue(plain, "anexo", "no_corpo")).toBe("no_corpo");
        expect(correctedValue(plain, "anexo", " ")).toBeNull();
    });
});
