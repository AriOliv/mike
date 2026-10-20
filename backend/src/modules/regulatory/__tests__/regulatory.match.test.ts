import { describe, expect, it } from "vitest";
import {
    affectedContracts,
    assessImpact,
    effectiveDate,
    findTerms,
    isNormative,
    matchesScan,
    PRESETS,
    quoteAround,
    topicsOf,
} from "../regulatory.match";
import type { RegulatoryItem } from "../regulatory.sources";

const item = (over: Partial<RegulatoryItem>): RegulatoryItem => ({
    source: "bcb_normativos",
    external_id: "1",
    title: "Resolução BCB nº 999",
    act_type: "Resolução BCB",
    issuer: "Banco Central do Brasil",
    published_at: "2026-10-19",
    url: null,
    excerpt: "Dispõe sobre prestadoras de serviços de ativos virtuais.",
    ...over,
});

describe("matching", () => {
    it("ignores accents and case and matches whole words only", () => {
        expect(findTerms("Regulação do CÂMBIO e do Pix", ["cambio", "pix"])).toEqual(["cambio", "pix"]);
        expect(findTerms("pixel art", ["pix"])).toEqual([]);
        expect(findTerms("x", ["  "])).toEqual([]);
    });

    it("keeps a DOU act only when it comes from a followed issuer", () => {
        const anpd = PRESETS.find((p) => p.key === "lgpd_anpd")!;
        const fromAnpd = item({ source: "dou", issuer: "Presidência da República/Autoridade Nacional de Proteção de Dados" });
        const fromMme = item({ source: "dou", issuer: "Ministério de Minas e Energia" });
        expect(matchesScan(fromAnpd, anpd).ok).toBe(true);
        expect(matchesScan(fromMme, anpd).ok).toBe(false);
        expect(matchesScan(item({}), anpd).ok).toBe(false); // source not watched
    });

    it("requires one of the scan's keywords when it has any", () => {
        const bcb = PRESETS.find((p) => p.key === "bcb_pagamentos_cripto")!;
        expect(matchesScan(item({}), bcb)).toMatchObject({ ok: true, terms: expect.arrayContaining(["ativos virtuais"]) });
        expect(matchesScan(item({ excerpt: "Crédito rural." }), bcb).ok).toBe(false);
    });

    it("classifies the Avenia themes an act touches", () => {
        expect(topicsOf("Instituições de pagamento e câmbio")).toEqual(["psp", "cambio"]);
        expect(topicsOf("tratamento de dados pessoais")).toEqual(["lgpd"]);
    });

    it("tells rules from news and individual acts", () => {
        expect(isNormative("Resolução BCB", "x")).toBe(true);
        expect(isNormative(null, "INSTRUÇÃO NORMATIVA RFB Nº 2.300")).toBe(true);
        expect(isNormative("Notícia", "CVM adequa canais")).toBe(false);
        expect(isNormative("Despacho", "Despacho")).toBe(false);
    });
});

describe("effective date", () => {
    it("reads the date the text states", () => {
        expect(effectiveDate("Esta Resolução entra em vigor em 2 de fevereiro de 2027.", "2026-10-19")).toBe("2027-02-02");
        expect(effectiveDate("produz efeitos a partir de 1º de março de 2027", null)).toBe("2027-03-01");
    });

    it("uses the publication date when the act takes effect on publication", () => {
        expect(effectiveDate("Esta Resolução entra em vigor na data de sua publicação.", "2026-10-20")).toBe("2026-10-20");
    });

    it("never guesses", () => {
        expect(effectiveDate("Divulga condições.", "2026-10-20")).toBeNull();
    });
});

describe("impact", () => {
    const affected = [{ project_id: "p1", term: "ativos virtuais", quote: "…ativos virtuais…" }];

    it("is high for a rule on our themes, explaining why", () => {
        const v = assessImpact({ item: item({}), topics: ["cripto"], scanTopics: ["cripto"], terms: ["ativos virtuais"], affected });
        expect(v.impact).toBe("alto");
        expect(v.reason).toBe(
            'Alta: norma (Resolução BCB) que cita "ativos virtuais" — tema cripto/VASP; 1 contrato menciona "ativos virtuais".',
        );
        expect(v.action).toBe("Criar pedido para revisar o contrato afetado.");
    });

    it("is high for a payments rule even before any contract mentions it", () => {
        const v = assessImpact({ item: item({}), topics: ["psp"], scanTopics: ["psp"], terms: ["pix"], affected: [] });
        expect(v).toMatchObject({ impact: "alto", action: "Criar pedido para avaliar a adequação." });
        expect(v.reason).toContain("nenhum contrato da base menciona o tema");
    });

    it("is medium for an LGPD rule without contracts, and for news that hits contracts", () => {
        expect(
            assessImpact({ item: item({}), topics: ["lgpd"], scanTopics: ["lgpd"], terms: [], affected: [] }).impact,
        ).toBe("medio");
        const news = assessImpact({
            item: item({ act_type: "Notícia", title: "CVM publica" }),
            topics: ["cripto"],
            scanTopics: ["cripto"],
            terms: ["criptoativos"],
            affected: [...affected, { project_id: "p2", term: "x", quote: "x" }],
        });
        expect(news).toMatchObject({ impact: "medio", action: "Ler e decidir se vira pedido ou obrigação." });
        expect(news.reason).toContain("2 contratos mencionam");
    });

    it("is low for news off our themes", () => {
        const v = assessImpact({ item: item({ act_type: null, title: "Aviso" }), topics: [], scanTopics: ["psp"], terms: [], affected: [] });
        expect(v).toMatchObject({ impact: "baixo", action: "Arquivar se não se aplica." });
        expect(v.reason).toContain("(Ato)");
        expect(v.reason).toContain("não cita termo do tema");
    });

    it("counts several contracts in the action", () => {
        const two = [...affected, { project_id: "p2", term: "pix", quote: "pix" }];
        expect(
            assessImpact({ item: item({}), topics: ["cripto"], scanTopics: ["cripto"], terms: ["pix"], affected: two }).action,
        ).toBe("Criar pedido para revisar os 2 contratos afetados.");
    });
});

describe("contracts affected", () => {
    const contracts = [
        { project_id: "a", text: "Cláusula 4. A CONTRATADA presta serviços de ATIVOS VIRTUAIS nos termos da regulação." },
        { project_id: "b", text: "Contrato de locação de imóvel comercial." },
        { project_id: "c", text: "Operações de câmbio e remessa." },
    ];

    it("returns the contracts that mention a term, with the passage", () => {
        const hits = affectedContracts(contracts, ["ativos virtuais", "cambio"]);
        expect(hits.map((h) => h.project_id)).toEqual(["a", "c"]);
        expect(hits[0].quote).toContain("ATIVOS VIRTUAIS");
        expect(hits[1]).toMatchObject({ term: "cambio" });
    });

    it("stops at the limit", () => {
        expect(affectedContracts(contracts, ["ativos virtuais", "cambio"], 1)).toHaveLength(1);
    });

    it("quotes a window around the hit, marking the cut", () => {
        const long = `${"a ".repeat(200)}dados pessoais${" b".repeat(200)}`;
        const quote = quoteAround(long, "dados pessoais", 20)!;
        expect(quote.startsWith("…")).toBe(true);
        expect(quote.endsWith("…")).toBe(true);
        expect(quote).toContain("dados pessoais");
        expect(quoteAround("nada aqui", "pix")).toBeNull();
    });
});
