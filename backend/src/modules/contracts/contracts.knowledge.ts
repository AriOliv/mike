// Text helpers behind "Perguntar" (the corpus Q&A in contracts.acervo.ts):
// which phrases to search for, which passages of a contract to show the
// model, and whether a quote the model returned is really in the contract.
//
// Everything here is pure, so the rules that keep an answer honest — a quote
// either is in the text or is flagged — are tested without a database.

// ── folding ──────────────────────────────────────────────────────────────────
// Lowercase, accents stripped, typographic quotes and dashes made plain — one
// character in, one character out, so an index into the folded text is an
// index into the original.
const PLAIN: Record<string, string> = {
    "“": '"', "”": '"', "„": '"', "«": '"', "»": '"',
    "‘": "'", "’": "'", "–": "-", "—": "-", " ": " ",
};

function foldChar(ch: string): string {
    const plain = PLAIN[ch];
    if (plain) return plain;
    const base = ch.normalize("NFD")[0] ?? ch;
    const lower = base.toLowerCase();
    return lower.length === 1 ? lower : base;
}

export function fold(text: string): string {
    let out = "";
    for (let i = 0; i < text.length; i++) out += foldChar(text[i]);
    return out;
}

// ── what to search for ───────────────────────────────────────────────────────
const STOPWORDS = new Set([
    "a","o","as","os","de","da","do","das","dos","e","em","um","uma","uns","umas","que","qual","quais",
    "para","por","com","no","na","nos","nas","ao","aos","se","sobre","the","of","and","in","to","for",
    "is","are","what","which","contrato","contratos","clausula","clausulas","tem","existe","existem",
    "algum","alguma","alguns","algumas","preve","preveem","possui","possuem","como","onde","quando",
    "nosso","nossa","nossos","nossas","base","acervo","todos","todas","esse","essa","este","esta",
    "isso","isto","qualquer","cada","entre","pelo","pela","pelos","pelas","mais","menos","quanto",
    "quantos","quantas","ha","sao","ser","estar","esta","estao","foi","sim","nao","contem","prever",
    "trata","tratam","fala","falam","dizem","diz","lista","liste","mostre","quero","saber","favor",
]);

/**
 * Legal concepts a question names in different words than the contract does.
 * `trigger` runs on the folded question; `phrases` are searched in the stored
 * text, which matches literally and only ignores case — so they keep their
 * accents, the way Brazilian contracts are written.
 */
const CONCEPTS: { trigger: RegExp; phrases: string[] }[] = [
    {
        trigger: /\b(mudanca|alteracao|troca|transferencia) (de|do) controle\b|change of control|controle societario/,
        phrases: ["mudança de controle", "alteração de controle", "change of control", "controle societário"],
    },
    { trigger: /\bcess(ao|oes|ionari)|\bceder\b|\bcede\b|\bcedid/, phrases: ["cessão", "ceder", "cessionári"] },
    { trigger: /\bforo\b|jurisdi|\bcomarca/, phrases: ["foro", "jurisdição", "comarca"] },
    { trigger: /\bmultas?\b|penalidade|clausula penal/, phrases: ["multa", "penalidade", "cláusula penal"] },
    {
        trigger: /aviso previo|antecedencia|notificacao previa/,
        phrases: ["aviso prévio", "antecedência", "notificação prévia"],
    },
    {
        trigger: /renova|prorroga/,
        phrases: ["renovação automática", "renovado automaticamente", "prorrogação automática", "renovação"],
    },
    {
        trigger: /\blgpd\b|dados pessoais|protecao de dados|13\.?709/,
        phrases: ["LGPD", "dados pessoais", "proteção de dados", "13.709"],
    },
    {
        trigger: /limit\w* (de |da )?responsabilidade|responsabilidade limitada|teto de responsabilidade|limitation of liability|liability cap/,
        phrases: [
            "limitação de responsabilidade",
            "responsabilidade limitada",
            "limite de responsabilidade",
            "limitação da responsabilidade",
        ],
    },
    { trigger: /rescis|rescind|resili/, phrases: ["rescisão", "rescindir", "resilição"] },
    { trigger: /exclusiv/, phrases: ["exclusividade", "exclusivo"] },
    { trigger: /confidencial|sigilo/, phrases: ["confidencialidade", "sigilo", "confidenciais"] },
    {
        trigger: /lei aplicavel|legislacao aplicavel|governing law/,
        phrases: ["lei aplicável", "legislação aplicável", "regido pelas leis"],
    },
    {
        trigger: /reajust|\bipca\b|igp-?m|correcao monetaria/,
        phrases: ["reajuste", "IPCA", "IGP-M", "correção monetária"],
    },
];

export const MAX_TERMS = 5;

/** The question's words that carry meaning, in order, folded. */
export function keywords(text: string): string[] {
    return fold(text)
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * The phrases to search the contracts for, most telling first: the legal
 * concepts the question names (with their synonyms, interleaved so two
 * concepts both get searched), then the question's own salient words.
 */
export function questionTerms(question: string, max = MAX_TERMS): string[] {
    const folded = fold(question);
    const groups = CONCEPTS.map((c) => ({ c, at: folded.search(c.trigger) }))
        .filter((g) => g.at >= 0)
        .sort((a, b) => a.at - b.at)
        .map((g) => g.c.phrases);

    const out: string[] = [];
    const seen = new Set<string>();
    const push = (term: string) => {
        const key = fold(term);
        if (key.length < 2 || seen.has(key) || out.length >= max) return;
        seen.add(key);
        out.push(term);
    };
    const longest = Math.max(0, ...groups.map((g) => g.length));
    for (let i = 0; i < longest; i++) for (const g of groups) if (g[i]) push(g[i]);

    // The question's own words, as typed (accents kept). A word already
    // covered by a concept phrase adds nothing.
    const covered = groups.flat().map(fold);
    const original = question.toLowerCase().split(/[^\p{L}\p{N}]+/u);
    for (const word of original) {
        const w = fold(word);
        if (w.length < 4 || STOPWORDS.has(w)) continue;
        if (covered.some((p) => p.includes(w) || w.startsWith(p))) continue;
        push(word);
    }
    return out;
}

// ── which passages to read ───────────────────────────────────────────────────
export type Occurrence = { start: number; end: number; term: string };

/** Every place a term appears, accents and case ignored, in text order. */
export function findOccurrences(text: string, terms: string[], max = 60): Occurrence[] {
    const haystack = fold(text);
    const out: Occurrence[] = [];
    for (const term of terms) {
        const needle = fold(term);
        if (needle.length < 2) continue;
        let from = 0;
        while (out.length < max) {
            const at = haystack.indexOf(needle, from);
            if (at === -1) break;
            out.push({ start: at, end: at + needle.length, term });
            from = at + needle.length;
        }
    }
    return out.sort((a, b) => a.start - b.start);
}

export type Span = { start: number; end: number };

/**
 * Generous windows around the hits — a clause needs its neighbours to be
 * understood — merged where they overlap, keeping the windows with the most
 * hits within the character budget.
 */
export function passageWindows(
    textLength: number,
    hits: Span[],
    { radius = 1200, maxWindows = 4, maxChars = 12000 } = {},
): Span[] {
    const raw = hits
        .map((h) => ({ start: Math.max(0, h.start - radius), end: Math.min(textLength, h.end + radius) }))
        .sort((a, b) => a.start - b.start);
    const merged: (Span & { hits: number })[] = [];
    for (const w of raw) {
        const last = merged[merged.length - 1];
        if (last && w.start <= last.end) {
            last.end = Math.max(last.end, w.end);
            last.hits++;
        } else merged.push({ ...w, hits: 1 });
    }
    const kept: Span[] = [];
    let used = 0;
    for (const w of [...merged].sort((a, b) => b.hits - a.hits || a.start - b.start)) {
        if (kept.length >= maxWindows) break;
        const room = maxChars - used;
        if (room <= 0) break;
        const end = Math.min(w.end, w.start + room);
        kept.push({ start: w.start, end });
        used += end - w.start;
    }
    return kept.sort((a, b) => a.start - b.start);
}

// ── is the quote really there ────────────────────────────────────────────────
function normalizeWithMap(text: string): { norm: string; map: number[] } {
    let norm = "";
    const map: number[] = [];
    for (let i = 0; i < text.length; i++) {
        const c = foldChar(text[i]);
        if (/\s/.test(c)) {
            if (norm.length === 0 || norm.endsWith(" ")) continue;
            norm += " ";
        } else norm += c;
        map.push(i);
    }
    return { norm, map };
}

const ELLIPSIS = /\s*(?:\[\s*(?:\.\.\.|…)\s*\]|\(\s*(?:\.\.\.|…)\s*\)|\.\.\.|…)\s*/;
const MIN_FRAGMENT = 8;
/** At least this much of the quote must match: a word or two proves nothing. */
const MIN_MATCHED = 20;
/** Elided fragments must sit close together, in one passage of the contract. */
const MAX_GAP = 600;

/**
 * Where the quote sits in the text: verbatim first, then ignoring case,
 * accents and whitespace. A quote that elides with "..." must have every
 * fragment present, in order and close together; a fragment too short to
 * check (a "Não" before an ellipsis) rejects the quote rather than being
 * dropped, since dropping it can invert the clause. Null when it is not in
 * the text — the caller flags the source instead of trusting it.
 */
export function locateQuote(text: string, quote: string): Span | null {
    const cleaned = quote
        .trim()
        .replace(/^["'“”«»‘’]+|["'“”«»‘’]+$/g, "")
        .replace(/^(?:\.\.\.|…)\s*|\s*(?:\.\.\.|…)$/g, "")
        .trim();
    const fragments = cleaned
        .split(ELLIPSIS)
        .map((f) => f.trim())
        .filter(Boolean);
    if (fragments.length === 0) return null;
    if (fragments.length > 1 && fragments.some((f) => f.length < MIN_FRAGMENT)) return null;
    if (fragments.reduce((sum, f) => sum + f.length, 0) < MIN_MATCHED) return null;

    if (fragments.length === 1) {
        const at = text.indexOf(fragments[0]);
        if (at !== -1) return { start: at, end: at + fragments[0].length };
    }

    const { norm, map } = normalizeWithMap(text);
    let cursor = 0;
    let first: number | null = null;
    let last = 0;
    for (const fragment of fragments) {
        const needle = normalizeWithMap(fragment).norm.trim();
        const at = norm.indexOf(needle, cursor);
        if (at === -1) return null;
        if (first !== null && at - cursor > MAX_GAP) return null;
        if (first === null) first = map[at];
        last = map[at + needle.length - 1] + 1;
        cursor = at + needle.length;
    }
    return { start: first!, end: last };
}

// ── official Brazilian legal sources ─────────────────────────────────────────
// Statute answers must carry a link to the official text, so only these sites
// count as a source, whatever the search service returns.
const OFFICIAL_SOURCES: { host: string; subdomains: boolean; path?: string }[] = [
    { host: "planalto.gov.br", subdomains: true },
    { host: "bcb.gov.br", subdomains: true },
    { host: "cvm.gov.br", subdomains: true },
    // gov.br hosts every federal body: only the ANPD's own section counts.
    { host: "gov.br", subdomains: false, path: "/anpd" },
];

export function isOfficialLawUrl(url: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    return OFFICIAL_SOURCES.some(
        (s) =>
            (host === s.host || host === `www.${s.host}` || (s.subdomains && host.endsWith(`.${s.host}`))) &&
            (!s.path || path === s.path || path.startsWith(`${s.path}/`)),
    );
}

export function lawSearchQuery(question: string): string {
    return `${question.slice(0, 250)} (site:planalto.gov.br OR site:bcb.gov.br OR site:cvm.gov.br OR site:gov.br/anpd)`;
}
