// Public Brazilian sources the regulatory radar reads, behind one interface.
//
// Each source turns one HTTP response into RegulatoryItems; it never decides
// relevance (that is the scan's filter) and never calls a model. Fetching is
// injected, so tests feed recorded fixtures and CI never touches the network.
//
// Verified on 2026-10-20:
// - BCB: the normativos search API returns JSON; its RSS endpoints do not work.
// - DOU: the "leitura do jornal" page embeds every act of the day as JSON in
//   <script id="params">, with the issuing body's hierarchy. That is how the
//   radar follows ANPD, COAF and the Receita, whose own RSS feeds are gone.
// - CVM and Receita news: Plone RSS 1.0 (RDF) feeds.

import { XMLParser } from "fast-xml-parser";

export type RegulatoryItem = {
    source: SourceId;
    /** The source's own id for the item, stable across runs (dedupe key). */
    external_id: string;
    title: string;
    act_type: string | null;
    issuer: string | null;
    /** YYYY-MM-DD */
    published_at: string | null;
    url: string | null;
    /** Verbatim official text: the ementa, the DOU opening, the RSS description. */
    excerpt: string;
};

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export const SOURCE_IDS = ["bcb_normativos", "dou", "cvm_noticias", "rfb_noticias"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export const SOURCE_LABELS: Record<SourceId, string> = {
    bcb_normativos: "Banco Central — normativos",
    dou: "Diário Oficial da União",
    cvm_noticias: "CVM — notícias",
    rfb_noticias: "Receita Federal — notícias",
};

const UA = "Mozilla/5.0 (compatible; MikeRadar/1.0; +https://github.com/open-legal-products/mike)";
const MAX_EXCERPT = 1200;

export function cleanText(value: unknown): string {
    if (typeof value !== "string") return "";
    return value
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        // Last, so "&amp;lt;" reads "&lt;" and is not decoded twice into "<".
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();
}

function clip(text: string): string {
    return text.length > MAX_EXCERPT ? `${text.slice(0, MAX_EXCERPT - 1)}…` : text;
}

/** "20/10/2026" or "20/10/2026 18:30" → "2026-10-20". */
export function brDate(value: unknown): string | null {
    const m = typeof value === "string" ? /(\d{2})\/(\d{2})\/(\d{4})/.exec(value) : null;
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function isoDay(value: unknown): string | null {
    const m = typeof value === "string" ? /^(\d{4}-\d{2}-\d{2})/.exec(value) : null;
    return m ? m[1] : null;
}

// ── BCB normativos (JSON search API) ─────────────────────────────────────────

const BCB_SEARCH =
    "https://www.bcb.gov.br/api/search/app/normativos/buscanormativos" +
    "?querytext=ContentType:normativo%20AND%20contentSource:normativos" +
    "&rowlimit=50&startrow=0&sortlist=Data1OWSDATE:descending";

type BcbRow = Record<string, unknown>;

export function parseBcbNormativos(body: string): RegulatoryItem[] {
    const json = JSON.parse(body) as { Rows?: BcbRow[] };
    const out: RegulatoryItem[] = [];
    for (const row of json.Rows ?? []) {
        const title = cleanText(row.title);
        const type = cleanText(row.TipodoNormativoOWSCHCS) || null;
        const number = Number.parseFloat(String(row.NumeroOWSNMBR ?? ""));
        const id = cleanText(row.listItemId);
        if (!title || !id) continue;
        if (row.RevogadoOWSBOOL === "1" || row.CanceladoOWSBOOL === "1") continue;
        const url =
            type && Number.isFinite(number)
                ? `https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=${encodeURIComponent(type)}&numero=${Math.trunc(number)}`
                : null;
        out.push({
            source: "bcb_normativos",
            external_id: id,
            title,
            act_type: type,
            issuer: "Banco Central do Brasil",
            published_at: brDate(String(row.RefinableString01 ?? "")) ?? isoDay(row.data),
            url,
            excerpt: clip(cleanText(row.AssuntoNormativoOWSMTXT) || cleanText(row.HitHighlightedSummary)),
        });
    }
    return out;
}

// ── DOU (leitura do jornal, embedded JSON) ───────────────────────────────────

function douDate(day: Date): string {
    const dd = String(day.getUTCDate()).padStart(2, "0");
    const mm = String(day.getUTCMonth() + 1).padStart(2, "0");
    return `${dd}-${mm}-${day.getUTCFullYear()}`;
}

export function douUrl(day: Date, section: "do1" | "do2" | "do3" = "do1"): string {
    return `https://www.in.gov.br/leiturajornal?data=${douDate(day)}&secao=${section}`;
}

type DouAct = {
    urlTitle?: string;
    title?: string;
    pubDate?: string;
    content?: string;
    artType?: string;
    hierarchyStr?: string;
};

export function parseDou(body: string): RegulatoryItem[] {
    const m = /<script id="params" type="application\/json">([\s\S]*?)<\/script>/.exec(body);
    if (!m) return [];
    const json = JSON.parse(m[1]) as { jsonArray?: DouAct[] };
    const out: RegulatoryItem[] = [];
    for (const act of json.jsonArray ?? []) {
        const id = cleanText(act.urlTitle);
        const title = cleanText(act.title);
        if (!id || !title) continue;
        out.push({
            source: "dou",
            external_id: id,
            title,
            act_type: cleanText(act.artType) || null,
            issuer: cleanText(act.hierarchyStr) || null,
            published_at: brDate(act.pubDate),
            url: `https://www.in.gov.br/web/dou/-/${id}`,
            excerpt: clip(cleanText(act.content)),
        });
    }
    return out;
}

// ── gov.br news (Plone RSS 1.0 / RDF) ────────────────────────────────────────

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

type RdfItem = { title?: unknown; link?: unknown; description?: unknown; "dc:date"?: unknown };

/** Plone lists folders (years, "Carrossel") as items too; a news item has a slug, not a bare folder. */
function isNewsLink(link: string, feedBase: string): boolean {
    if (!link.startsWith(feedBase)) return false;
    const slug = link.slice(feedBase.length).replace(/^\/+|\/+$/g, "");
    return slug.length > 0 && slug.includes("-") && !/^\d{4}(-\d+)?$/.test(slug);
}

export function parseGovBrRss(body: string, source: SourceId, issuer: string, feedBase: string): RegulatoryItem[] {
    const doc = xml.parse(body) as { "rdf:RDF"?: { item?: RdfItem | RdfItem[] } };
    const raw = doc["rdf:RDF"]?.item;
    const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const out: RegulatoryItem[] = [];
    for (const item of items) {
        const link = cleanText(item.link);
        const title = cleanText(item.title);
        if (!title || !isNewsLink(link, feedBase)) continue;
        out.push({
            source,
            external_id: link,
            title,
            act_type: "Notícia",
            issuer,
            published_at: isoDay(item["dc:date"]),
            url: link,
            excerpt: clip(cleanText(item.description) || title),
        });
    }
    return out;
}

// ── registry ─────────────────────────────────────────────────────────────────

type SourceDef = {
    /** URLs to read on a run; the DOU reads today's and yesterday's editions. */
    urls: (now: Date) => string[];
    parse: (body: string) => RegulatoryItem[];
};

const CVM_BASE = "https://www.gov.br/cvm/pt-br/assuntos/noticias";
const RFB_BASE = "https://www.gov.br/receitafederal/pt-br/assuntos/noticias";

export const SOURCES: Record<SourceId, SourceDef> = {
    bcb_normativos: { urls: () => [BCB_SEARCH], parse: parseBcbNormativos },
    dou: {
        urls: (now) => [douUrl(now), douUrl(new Date(now.getTime() - 86_400_000))],
        parse: parseDou,
    },
    cvm_noticias: {
        urls: () => [`${CVM_BASE}/RSS`],
        parse: (body) => parseGovBrRss(body, "cvm_noticias", "Comissão de Valores Mobiliários", CVM_BASE),
    },
    rfb_noticias: {
        urls: () => [`${RFB_BASE}/RSS`],
        parse: (body) => parseGovBrRss(body, "rfb_noticias", "Receita Federal do Brasil", RFB_BASE),
    },
};

export const defaultFetcher: Fetcher = (url) =>
    fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json, text/html, application/xml;q=0.9" },
        signal: AbortSignal.timeout(20_000),
    });

export type SourceReadResult = { items: RegulatoryItem[]; errors: string[] };

/**
 * Read every URL of a source. One URL failing (the DOU edition of a day with
 * no paper, a feed that is down) does not lose the others; the error is
 * reported so the scan can say "BCB fora do ar" instead of finding nothing.
 */
export async function readSource(id: SourceId, fetcher: Fetcher, now: Date): Promise<SourceReadResult> {
    const def = SOURCES[id];
    const items: RegulatoryItem[] = [];
    const errors: string[] = [];
    for (const url of def.urls(now)) {
        try {
            const res = await fetcher(url);
            if (!res.ok) {
                errors.push(`${SOURCE_LABELS[id]}: HTTP ${res.status}`);
                continue;
            }
            items.push(...def.parse(await res.text()));
        } catch {
            errors.push(`${SOURCE_LABELS[id]}: indisponível`);
        }
    }
    return { items, errors };
}
