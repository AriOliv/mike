// Deciding what a regulatory item means for the team, without a model.
//
// Relevance, impact and the contracts affected are rules over the official
// text, so each verdict can say WHY in one sentence ("Alta: Resolução BCB que
// cita 'ativos virtuais' — tema cripto — e 4 contratos mencionam o termo").
// The model only writes the two-line summary, and only when its quote checks
// out against the official text (regulatory.scan.ts).

import type { RegulatoryItem, SourceId } from "./regulatory.sources";

export const TOPICS = ["psp", "cripto", "cambio", "lgpd", "pld"] as const;
export type Topic = (typeof TOPICS)[number];

export const TOPIC_LABELS: Record<Topic, string> = {
    psp: "pagamentos/PSP",
    cripto: "cripto/VASP",
    cambio: "câmbio",
    lgpd: "dados pessoais",
    pld: "PLD/FT",
};

/**
 * The words that put an item in an Avenia theme. Also what is looked for in
 * the contracts: a change on "ativos virtuais" affects the contracts that
 * mention ativos virtuais.
 */
export const TOPIC_TERMS: Record<Topic, string[]> = {
    psp: [
        "instituicao de pagamento",
        "instituicoes de pagamento",
        "arranjo de pagamento",
        "arranjos de pagamento",
        "conta de pagamento",
        "moeda eletronica",
        "pix",
        "iniciador de transacao de pagamento",
        "open finance",
    ],
    cripto: [
        "ativos virtuais",
        "ativo virtual",
        "prestadora de servicos de ativos virtuais",
        "prestadoras de servicos de ativos virtuais",
        "criptoativo",
        "criptoativos",
        "stablecoin",
        "tokenizacao",
    ],
    cambio: ["cambio", "moeda estrangeira", "remessa internacional", "efx", "eurodolar", "capitais estrangeiros"],
    lgpd: [
        "dados pessoais",
        "protecao de dados",
        "lgpd",
        "titular dos dados",
        "encarregado",
        "incidente de seguranca",
        "transferencia internacional de dados",
    ],
    pld: [
        "lavagem de dinheiro",
        "financiamento do terrorismo",
        "pld",
        "coaf",
        "operacoes suspeitas",
        "sancoes",
    ],
};

/** Acts that change the rules, as opposed to news, notices and individual decisions. */
const NORMATIVE_TYPES = [
    "lei",
    "lei complementar",
    "decreto",
    "medida provisoria",
    "resolucao",
    "resolucao bcb",
    "resolucao cmn",
    "resolucao conjunta",
    "resolucao cvm",
    "instrucao normativa",
    "circular",
    "portaria",
    "regulamento",
];

export type ScanPreset = {
    key: string;
    name: string;
    description: string;
    sources: SourceId[];
    issuers: string[];
    keywords: string[];
    topics: Topic[];
};

/** The four scans that come ready: nobody has to describe what to watch. */
export const PRESETS: ScanPreset[] = [
    {
        key: "bcb_pagamentos_cripto",
        name: "BCB — pagamentos, cripto e câmbio",
        description: "Resoluções, circulares e instruções do Banco Central sobre PSP, Pix, ativos virtuais (VASP) e câmbio.",
        sources: ["bcb_normativos", "dou"],
        issuers: ["Banco Central do Brasil", "Conselho Monetário Nacional"],
        keywords: [
            ...TOPIC_TERMS.psp,
            ...TOPIC_TERMS.cripto,
            ...TOPIC_TERMS.cambio,
            "lavagem de dinheiro",
        ],
        topics: ["psp", "cripto", "cambio"],
    },
    {
        key: "lgpd_anpd",
        name: "LGPD / ANPD",
        description: "Todo ato da ANPD no Diário Oficial, mais normas que tratem de dados pessoais.",
        sources: ["dou"],
        issuers: ["Autoridade Nacional de Proteção de Dados"],
        keywords: [],
        topics: ["lgpd"],
    },
    {
        key: "cvm",
        name: "CVM — ativos virtuais e ofertas",
        description: "Resoluções e notícias da CVM sobre criptoativos, tokenização e ofertas.",
        sources: ["cvm_noticias", "dou"],
        issuers: ["Comissão de Valores Mobiliários"],
        keywords: [...TOPIC_TERMS.cripto, "resolucao cvm", "oficio circular", "crowdfunding"],
        topics: ["cripto"],
    },
    {
        key: "coaf_receita",
        name: "COAF e Receita — PLD e cripto",
        description: "Atos do COAF e normas da Receita sobre criptoativos, câmbio e prevenção à lavagem.",
        sources: ["dou", "rfb_noticias"],
        issuers: ["Conselho de Controle de Atividades Financeiras", "Receita Federal do Brasil"],
        keywords: [...TOPIC_TERMS.cripto, ...TOPIC_TERMS.pld, "instrucao normativa rfb", "iof", "e-financeira", "decripto"],
        topics: ["pld", "cripto", "cambio"],
    },
];

/** Accent- and case-insensitive form used for every comparison. */
export function fold(text: string): string {
    return text
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase();
}

/** Whole-word match, so "pix" does not hit "pixel" nor "pld" hit "upld". */
function wordIndex(haystack: string, needle: string): number {
    const n = fold(needle).trim();
    if (!n) return -1;
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).exec(haystack);
    return m ? m.index + m[1].length : -1;
}

export function findTerms(text: string, terms: readonly string[]): string[] {
    const hay = fold(text);
    const hits: string[] = [];
    for (const term of terms) if (wordIndex(hay, term) >= 0 && !hits.includes(term)) hits.push(term);
    return hits;
}

export type ScanFilter = { sources: string[]; issuers: string[]; keywords: string[] };

/**
 * Does the scan want this item? The DOU carries every body of government, so
 * a DOU item must come from one of the scan's issuers; any item must mention
 * one of its keywords when it has any.
 */
export function matchesScan(item: RegulatoryItem, scan: ScanFilter): { ok: boolean; terms: string[] } {
    if (!scan.sources.includes(item.source)) return { ok: false, terms: [] };
    if (item.source === "dou" && scan.issuers.length > 0) {
        const issuer = fold(item.issuer ?? "");
        if (!scan.issuers.some((i) => issuer.includes(fold(i)))) return { ok: false, terms: [] };
    }
    const terms = findTerms(`${item.title} ${item.excerpt}`, scan.keywords);
    if (scan.keywords.length > 0 && terms.length === 0) return { ok: false, terms: [] };
    return { ok: true, terms };
}

export function topicsOf(text: string): Topic[] {
    return TOPICS.filter((t) => findTerms(text, TOPIC_TERMS[t]).length > 0);
}

export function isNormative(actType: string | null, title: string): boolean {
    const type = fold(actType ?? "");
    const head = fold(title).slice(0, 60);
    return NORMATIVE_TYPES.some((t) => type === t || type.startsWith(`${t} `) || head.startsWith(t));
}

const MONTHS: Record<string, string> = {
    janeiro: "01", fevereiro: "02", marco: "03", abril: "04", maio: "05", junho: "06",
    julho: "07", agosto: "08", setembro: "09", outubro: "10", novembro: "11", dezembro: "12",
};

/**
 * The date the act takes effect, when the text says it: "entra em vigor em
 * 1º de janeiro de 2027", "a partir de 2 de março de 2027", or "na data de
 * sua publicação" (then the publication date). Null when the text is silent;
 * the radar never guesses a deadline.
 */
export function effectiveDate(text: string, publishedAt: string | null): string | null {
    const t = fold(text);
    const m =
        /(?:entra(?:ra)? em vigor|vigora|produz(?:ira)? efeitos|a partir de)[^.]{0,40}?(\d{1,2})o? de (janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro) de (\d{4})/.exec(
            t,
        );
    if (m) return `${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, "0")}`;
    if (/entra em vigor na data de (sua )?publicacao/.test(t)) return publishedAt;
    return null;
}

export type Affected = { project_id: string; term: string; quote: string };
export type Impact = "alto" | "medio" | "baixo";

export function assessImpact(args: {
    item: Pick<RegulatoryItem, "act_type" | "title" | "issuer">;
    topics: Topic[];
    scanTopics: string[];
    terms: string[];
    affected: Affected[];
}): { impact: Impact; reason: string; action: string } {
    const normative = isNormative(args.item.act_type, args.item.title);
    const ours = args.topics.filter((t) => args.scanTopics.includes(t));
    const kind = args.item.act_type ?? "Ato";
    const cited = args.terms[0] ? `cita "${args.terms[0]}"` : "não cita termo do tema";
    const themes = ours.length ? ` — tema ${ours.map((t) => TOPIC_LABELS[t]).join(", ")}` : "";
    const n = args.affected.length;
    const contracts =
        n === 0
            ? "nenhum contrato da base menciona o tema"
            : `${n} ${n === 1 ? "contrato menciona" : "contratos mencionam"} "${args.affected[0].term}"`;

    let impact: Impact;
    if (normative && ours.length > 0 && (n > 0 || ours.some((t) => t === "cripto" || t === "psp" || t === "cambio"))) {
        impact = "alto";
    } else if (normative || (ours.length > 0 && n > 0)) {
        impact = "medio";
    } else {
        impact = "baixo";
    }

    const label = impact === "alto" ? "Alta" : impact === "medio" ? "Média" : "Baixa";
    const reason = `${label}: ${normative ? "norma" : "informativo"} (${kind}) que ${cited}${themes}; ${contracts}.`;
    const action =
        impact === "alto"
            ? n > 0
                ? `Criar pedido para revisar ${n === 1 ? "o contrato afetado" : `os ${n} contratos afetados`}.`
                : "Criar pedido para avaliar a adequação."
            : impact === "medio"
              ? "Ler e decidir se vira pedido ou obrigação."
              : "Arquivar se não se aplica.";
    return { impact, reason, action };
}

/** A short verbatim window around the first hit of a term, for the citation. */
export function quoteAround(text: string, term: string, radius = 160): string | null {
    // On composed (NFC) text, folding drops each accent together with the
    // letter's decomposition, so it keeps the length and the index found in
    // the folded copy points at the same place in the original.
    const source = text.normalize("NFC");
    const at = wordIndex(fold(source), term);
    if (at < 0) return null;
    const start = Math.max(0, at - radius);
    const end = Math.min(source.length, at + term.length + radius);
    const slice = source.slice(start, end).replace(/\s+/g, " ").trim();
    return `${start > 0 ? "…" : ""}${slice}${end < text.length ? "…" : ""}`;
}

export type ContractText = { project_id: string; text: string };

/** The contracts whose text mentions one of the change's terms, with the passage. */
export function affectedContracts(
    contracts: ContractText[],
    terms: readonly string[],
    limit = 50,
): Affected[] {
    const out: Affected[] = [];
    for (const contract of contracts) {
        for (const term of terms) {
            const quote = quoteAround(contract.text, term);
            if (quote) {
                out.push({ project_id: contract.project_id, term, quote });
                break;
            }
        }
        if (out.length >= limit) break;
    }
    return out;
}
