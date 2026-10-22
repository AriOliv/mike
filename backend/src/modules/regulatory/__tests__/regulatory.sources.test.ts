import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    brDate,
    cleanText,
    douUrl,
    parseBcbNormativos,
    parseDou,
    parseGovBrRss,
    readSource,
    SOURCES,
    type Fetcher,
} from "../regulatory.sources";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");

describe("BCB normativos", () => {
    const items = parseBcbNormativos(fixture("bcb-normativos.json"));

    it("reads the ementa as the verbatim excerpt and builds the official link", () => {
        const crypto = items.find((i) => i.external_id === "900001");
        expect(crypto).toMatchObject({
            source: "bcb_normativos",
            title: "Resolução BCB N° 999",
            act_type: "Resolução BCB",
            issuer: "Banco Central do Brasil",
            published_at: "2026-10-19",
            url: "https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Resolu%C3%A7%C3%A3o%20BCB&numero=999",
        });
        expect(crypto?.excerpt).toContain("prestadoras de serviços de ativos virtuais");
        expect(crypto?.excerpt).not.toContain("<div>");
    });

    it("skips revoked and cancelled acts", () => {
        expect(items.find((i) => i.external_id === "900002")).toBeUndefined();
        expect(items).toHaveLength(4);
    });

    it("falls back to the API date and drops rows without an id", () => {
        const [item] = parseBcbNormativos(
            JSON.stringify({ Rows: [{ title: "Comunicado 1", listItemId: "7", data: "2026-10-01T10:00:00Z" }, { title: "x" }] }),
        );
        expect(item).toMatchObject({ published_at: "2026-10-01", url: null, act_type: null });
        expect(parseBcbNormativos("{}")).toEqual([]);
    });
});

describe("DOU", () => {
    const items = parseDou(fixture("dou-leiturajornal.html"));

    it("reads every act of the edition with its issuing body", () => {
        expect(items.map((i) => i.title)).toContain("RESOLUÇÃO CD/ANPD Nº 30, DE 17 DE OUTUBRO DE 2026");
        const anpd = items.find((i) => i.title.includes("ANPD"));
        expect(anpd).toMatchObject({
            source: "dou",
            act_type: "Resolução",
            published_at: "2026-10-20",
            url: "https://www.in.gov.br/web/dou/-/resolucao-cd/anpd-n-30-de-17-de-outubro-de-2026-739000001",
        });
        expect(anpd?.issuer).toContain("Autoridade Nacional de Proteção de Dados");
    });

    it("returns nothing for a page without the embedded edition", () => {
        expect(parseDou("<html></html>")).toEqual([]);
        expect(parseDou('<script id="params" type="application/json">{"jsonArray":[{"title":"sem id"}]}</script>')).toEqual([]);
    });

    it("addresses the edition by day", () => {
        expect(douUrl(new Date("2026-10-20T12:00:00Z"))).toBe(
            "https://www.in.gov.br/leiturajornal?data=20-10-2026&secao=do1",
        );
    });
});

describe("gov.br RSS", () => {
    it("keeps news items and drops the folders Plone lists alongside them", () => {
        const items = parseGovBrRss(
            fixture("cvm-rss.xml"),
            "cvm_noticias",
            "Comissão de Valores Mobiliários",
            "https://www.gov.br/cvm/pt-br/assuntos/noticias",
        );
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            source: "cvm_noticias",
            act_type: "Notícia",
            title: "CVM adequa canais de comunicação para cumprir normas do período eleitoral",
        });
        expect(items[0].published_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("reads a feed with a single item", () => {
        const xml = `<rdf:RDF xmlns:rdf="r" xmlns:dc="d"><item><title>Receita muda IN</title><link>https://x/n/receita-muda-in</link><dc:date>2026-10-18T10:00:00Z</dc:date></item></rdf:RDF>`;
        expect(parseGovBrRss(xml, "rfb_noticias", "Receita", "https://x/n")).toMatchObject([
            { title: "Receita muda IN", excerpt: "Receita muda IN", published_at: "2026-10-18" },
        ]);
        expect(parseGovBrRss("<rdf:RDF></rdf:RDF>", "rfb_noticias", "Receita", "https://x/n")).toEqual([]);
    });
});

describe("helpers", () => {
    it("decodes an escaped entity once, never twice", () => {
        expect(cleanText("Lei &amp;lt;n.º 14.478&amp;gt; &amp;amp;")).toBe("Lei &lt;n.º 14.478&gt; &amp;");
    });

    it("cleans markup and entities", () => {
        expect(cleanText("<p>a&nbsp;&amp; b &quot;c&quot; &#39;d&#39; &lt;e&gt;</p>")).toBe(`a & b "c" 'd' <e>`);
        expect(cleanText(42)).toBe("");
    });

    it("reads Brazilian dates", () => {
        expect(brDate("string;#20/10/2026 18:30")).toBe("2026-10-20");
        expect(brDate("ontem")).toBeNull();
        expect(brDate(undefined)).toBeNull();
    });
});

describe("readSource", () => {
    const ok = (body: string) => async () => ({ ok: true, status: 200, text: async () => body });

    it("reads today's and yesterday's DOU and keeps going when one fails", async () => {
        const urls: string[] = [];
        const fetcher: Fetcher = async (url) => {
            urls.push(url);
            if (urls.length === 1) return { ok: false, status: 503, text: async () => "" };
            return ok(fixture("dou-leiturajornal.html"))();
        };
        const result = await readSource("dou", fetcher, new Date("2026-10-20T12:00:00Z"));
        expect(urls).toEqual([
            "https://www.in.gov.br/leiturajornal?data=20-10-2026&secao=do1",
            "https://www.in.gov.br/leiturajornal?data=19-10-2026&secao=do1",
        ]);
        expect(result.errors).toEqual(["Diário Oficial da União: HTTP 503"]);
        expect(result.items.length).toBeGreaterThan(0);
    });

    it("reports a source that cannot be reached", async () => {
        const result = await readSource("bcb_normativos", async () => {
            throw new Error("ECONNRESET");
        }, new Date());
        expect(result).toEqual({ items: [], errors: ["Banco Central — normativos: indisponível"] });
    });

    it("wires each registered source to a parser", () => {
        const now = new Date("2026-10-20T12:00:00Z");
        expect(SOURCES.cvm_noticias.urls(now)).toEqual(["https://www.gov.br/cvm/pt-br/assuntos/noticias/RSS"]);
        expect(SOURCES.rfb_noticias.urls(now)).toEqual(["https://www.gov.br/receitafederal/pt-br/assuntos/noticias/RSS"]);
        expect(SOURCES.rfb_noticias.parse(fixture("cvm-rss.xml"))).toEqual([]);
        expect(SOURCES.cvm_noticias.parse(fixture("cvm-rss.xml"))).toHaveLength(1);
        expect(SOURCES.bcb_normativos.urls(now)[0]).toContain("buscanormativos");
    });
});
