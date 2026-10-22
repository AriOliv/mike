// "Perguntar": ask a question across the contract corpus ("acervo").
//
// 1. Retrieve. The question becomes a few literal phrases (legal synonyms
//    included) searched in the indexed full text of every contract in scope,
//    under a hard budget of search calls. A contract that contains a phrase
//    is a candidate; the excerpt is evidence.
// 2. Read. The best few contracts are shown to the model as numbered
//    passages — generous windows around each hit, wherever in the contract
//    they are — instead of the first and last pages.
// 3. Answer and check. The model answers with inline markers [1], [2] and a
//    verbatim quote per marker. Code then looks for every quote in the
//    contract text: a source is "verified" only when the quote is really
//    there. An answer with no verified source is not an answer (found=false),
//    because nobody could check it.
//
// Besides the prose, every contract in scope gets a row (`matches`) so the
// screen can say "7 de 52 contratos" for list-like questions, and the index
// coverage is returned so it can say how many are still being indexed —
// zero matches in an unindexed contract proves nothing.

import { workspaceMatches, type WorkspaceFilter } from "../../lib/workspace";
import type { Db } from "../../lib/supabase";
import { listAccessibleProjectIds } from "../../lib/access";
import { mapWithConcurrency } from "../../lib/concurrency";
import { completeText } from "../../lib/llm";
import { safeError } from "../../lib/safeError";
import {
    failure,
    internalFailure,
    ok,
    type ServiceResult,
} from "../../lib/serviceResult";
import {
    readWebPage,
    searchWeb,
    webSearchAccountFor,
    webSearchPlanFor,
    type WebSearchAccount,
    type WebSearchKeys,
    type WebSearchSettings,
} from "../../lib/webSearch";
import {
    findDocumentText,
    readStoredDocumentText,
} from "../documents/documents.service";
import {
    analysisModel,
    contractFileText,
    latestContractFiles,
    parseModelJson,
    type Caller,
} from "./contracts.shared";
import {
    findOccurrences,
    fold,
    isOfficialLawUrl,
    keywords,
    lawSearchQuery,
    locateQuote,
    passageWindows,
    questionTerms,
    type Span,
} from "./contracts.knowledge";

/** Contracts read in depth per question. */
export const CONTRACTS_READ = 6;
/** Hard cap on full-text search calls per question. */
export const SEARCH_BUDGET = 60;
const SEARCH_CONCURRENCY = 6;
const DOCS_READ_PER_CONTRACT = 2;
const CHARS_PER_CONTRACT = 12000;
/** When a contract cannot be searched, its head and tail stand in. */
const FALLBACK_HEAD = 6000;
const FALLBACK_TAIL = 6000;
const LAW_RESULTS = 3;
const LAW_PAGES_READ = 2;
const LAW_CHARS = 4000;
const QUOTE_PREVIEW = 280;

// ── types ────────────────────────────────────────────────────────────────────
export type AcervoScope =
    | "todos"
    | { counterparty?: string; contract_type?: string; project_ids?: string[] };

export type AcervoSource = {
    /** The marker number used in the answer: [n]. */
    n: number;
    project_id: string | null;
    document_id: string | null;
    contract: string;
    ref: string | null;
    quote: string;
    /** The quote was found in the contract text by code, not just claimed. */
    verified: boolean;
    start_char: number | null;
    end_char: number | null;
};

export type AcervoMatchBasis =
    /** Read in depth; the model judged it. */
    | "lido"
    /** Not read; a search phrase occurs in its text. */
    | "busca"
    /** Its text is still being indexed (or the index could not be used). */
    | "pendente"
    /** Left out by the search budget. */
    | "nao_buscado";

export type AcervoMatch = {
    project_id: string;
    contract: string;
    counterparty: string | null;
    contract_type: string | null;
    hit: boolean;
    quote: string | null;
    verified: boolean;
    basis: AcervoMatchBasis;
};

export type AcervoCoverage = {
    total_versions: number;
    indexed_versions: number;
    pending_versions: number;
    failed_versions: number;
    versions_needing_ocr: number;
    /** Contracts with at least one document not indexed yet. */
    contracts_pending: number;
    /** Contracts the search budget did not reach. */
    contracts_not_searched: number;
};

export type AcervoLawSource = {
    n: number;
    title: string;
    url: string;
    quote: string;
    verified: boolean;
};

export type AcervoAnswer = {
    answer: string;
    found: boolean;
    sources: AcervoSource[];
    /** How many contracts were read in depth to produce the answer. */
    searched: number;
    /** Contracts in scope. */
    total: number;
    /** One row per contract in scope, hits first. */
    matches: AcervoMatch[];
    /** The question asks for a list or a count ("quais", "quantos"…). */
    aggregate: boolean;
    coverage: AcervoCoverage;
    /** The phrases searched for. */
    terms: string[];
    /** A configured search service can look up official legislation. */
    law_available: boolean;
    law_sources: AcervoLawSource[];
};

type Project = {
    id: string;
    name: string;
    counterparty: string | null;
    contract_type: string | null;
    org_id: string | null;
};

type DocHit = { version_id: string; starts: Span[]; excerpt: string; excerpt_start: number };

type SearchState = {
    searched: boolean;
    unavailable: boolean;
    pending: boolean;
    termsHit: Set<string>;
    docs: Map<string, DocHit>;
};

/** `offset`: where `text` starts in the document (non-zero for an excerpt). */
type ContractText = { document_id: string | null; text: string; spans: Span[]; offset: number };

type Passage = {
    id: string;
    project_id: string | null;
    document_id: string | null;
    label: string;
    start: number;
    end: number;
    text: string;
    url?: string;
};

// ── request parsing ──────────────────────────────────────────────────────────
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseScope(raw: unknown): { ok: true; scope: AcervoScope } | { ok: false } {
    if (raw === undefined || raw === null || raw === "todos") return { ok: true, scope: "todos" };
    if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
    const r = raw as Record<string, unknown>;
    const scope: Exclude<AcervoScope, "todos"> = {};
    for (const key of ["counterparty", "contract_type"] as const) {
        if (r[key] === undefined || r[key] === null) continue;
        if (typeof r[key] !== "string" || (r[key] as string).length > 200) return { ok: false };
        const value = (r[key] as string).trim();
        if (value) scope[key] = value;
    }
    if (r.project_ids !== undefined && r.project_ids !== null) {
        const ids = r.project_ids;
        if (!Array.isArray(ids) || ids.length > 500 || !ids.every((id) => typeof id === "string" && UUID.test(id))) {
            return { ok: false };
        }
        scope.project_ids = ids as string[];
    }
    return { ok: true, scope };
}

function inScope(p: Project, scope: AcervoScope): boolean {
    if (scope === "todos") return true;
    if (scope.counterparty) {
        const wanted = fold(scope.counterparty);
        const haystack = fold(`${p.counterparty ?? ""} ${p.name}`);
        if (!haystack.includes(wanted)) return false;
    }
    if (scope.contract_type && fold(p.contract_type ?? "") !== fold(scope.contract_type)) return false;
    return true;
}

const AGGREGATE = /^\s*(quais|quantos|quantas|qual(?:is)? (?:dos|das) |algum|alguma|existe|existem|h[aá] (?:algum|contratos?)|liste|listar|lista|todos|todas|que contratos)/i;

// ── ranking by what is indexed cheaply ───────────────────────────────────────
export function scoreCandidate(question: string, haystack: string): number {
    const wanted = new Set(keywords(question));
    if (wanted.size === 0) return 0;
    const found = new Set(keywords(haystack));
    let hits = 0;
    for (const w of wanted) if (found.has(w)) hits++;
    return hits / wanted.size;
}

// ── prompt ───────────────────────────────────────────────────────────────────
const SYSTEM = `Você é um analista jurídico respondendo perguntas sobre o acervo de
contratos de uma empresa brasileira.

Regras invioláveis:
- Responda SOMENTE com base nos trechos fornecidos. Nunca invente cláusula, número, lei ou dado.
- Toda afirmação leva um marcador numerado inline, [1], [2]…, e cada marcador tem uma fonte
  com um trecho VERBATIM copiado do trecho indicado (sem parafrasear, sem juntar trechos).
- Legislação só pode ser citada a partir dos trechos [L…] fornecidos; sem eles, não cite lei.
- Se os trechos não respondem, diga que não encontrou (found=false) e não cite nada.
- Português do Brasil, objetivo, sem floreio.
- Responda apenas com JSON válido, sem cercas de código.`;

function buildPrompt(question: string, passages: Passage[], contracts: { id: string; label: string }[]) {
    const blocks = passages
        .map((p) =>
            p.url
                ? `[${p.id}] fonte oficial: ${p.label} (${p.url})\n${p.text}`
                : `[${p.id}] contrato id=${p.project_id} · ${p.label} · caracteres ${p.start}–${p.end}\n${p.text}`,
        )
        .join("\n\n---\n\n");
    const schema = {
        answer: "resposta objetiva (1-5 frases) com marcadores [1], [2] após cada afirmação",
        found: "true se respondida a partir dos trechos; false se não achou",
        sources: [
            {
                n: "número do marcador usado na resposta (1, 2, …)",
                passage: "id do trecho de onde a citação foi copiada (ex.: 'P3' ou 'L1')",
                project_id: "id do contrato (o id= do cabeçalho do trecho), ou null para legislação",
                ref: "cláusula/artigo, se identificável (ex.: 'cl. 11.1', 'art. 7º')",
                quote: "trecho VERBATIM, copiado letra por letra do trecho indicado",
            },
        ],
        matches: [
            {
                project_id: "id de cada contrato lido",
                hit: "true se ESTE contrato atende/contém o que a pergunta procura",
                quote: "trecho VERBATIM que comprova, ou null",
            },
        ],
    };
    const list = contracts.map((c) => `- id=${c.id} · ${c.label}`).join("\n");
    return `Pergunta sobre o acervo:
"${question}"

Cite só o que é realmente relevante. Em "matches", inclua UMA linha para cada contrato lido:
${list}

Schema de saída (JSON):
${JSON.stringify(schema, null, 2)}

TRECHOS:
${blocks}`;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function labelOf(p: Project): string {
    return `${p.name}${p.counterparty ? ` — contraparte: ${p.counterparty}` : ""}`;
}

function preview(text: string): string {
    const collapsed = text.replace(/\s+/g, " ").trim();
    return collapsed.length > QUOTE_PREVIEW ? `${collapsed.slice(0, QUOTE_PREVIEW - 1)}…` : collapsed;
}

function str(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function emptyCoverage(): AcervoCoverage {
    return {
        total_versions: 0,
        indexed_versions: 0,
        pending_versions: 0,
        failed_versions: 0,
        versions_needing_ocr: 0,
        contracts_pending: 0,
        contracts_not_searched: 0,
    };
}

/** Mike's own search service, when the caller configured one (Settings › Web search). */
function lawAccount(
    settings: WebSearchSettings | undefined,
    model: string,
    keys: WebSearchKeys | undefined,
): WebSearchAccount | null {
    if (!settings) return null;
    return webSearchAccountFor(webSearchPlanFor(settings, model, keys), keys);
}

// ── the service ──────────────────────────────────────────────────────────────
export async function askAcervo(
    db: Db,
    caller: Caller,
    body: Record<string, unknown>,
    /** Only contracts in this workspace (the home screen's cut); null = every contract the caller sees. */
    workspace: WorkspaceFilter = null,
): Promise<ServiceResult<AcervoAnswer>> {
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) return failure("validation", "Escreva uma pergunta.");
    if (question.length > 2000) return failure("validation", "A pergunta está longa demais. Resuma em até 2.000 caracteres.");
    const parsedScope = parseScope(body.scope);
    if (!parsedScope.ok) return failure("validation", "Não entendi o filtro de contratos. Escolha o escopo de novo.");
    const scope = parsedScope.scope;
    const includeLaw = body.include_law === true;

    const terms = questionTerms(question);
    const base: AcervoAnswer = {
        answer: "",
        found: false,
        sources: [],
        searched: 0,
        total: 0,
        matches: [],
        aggregate: AGGREGATE.test(question),
        coverage: emptyCoverage(),
        terms,
        law_available: false,
        law_sources: [],
    };

    // ── the contracts in scope ──────────────────────────────────────────────
    let ids: string[];
    try {
        ids = await listAccessibleProjectIds(caller.userId, caller.userEmail, db);
    } catch (error) {
        return internalFailure(error);
    }
    if (scope !== "todos" && scope.project_ids) {
        const wanted = new Set(scope.project_ids);
        ids = ids.filter((id) => wanted.has(id));
    }
    const projects: Project[] = [];
    for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await db
            .from("projects")
            .select("id, name, counterparty, contract_type, org_id")
            .in("id", ids.slice(i, i + 200))
            .not("lane", "is", null)
            .is("archived_at", null);
        if (error) return internalFailure(error);
        for (const p of (data ?? []) as Project[])
            if (inScope(p, scope) && workspaceMatches(workspace, p.org_id)) projects.push(p);
    }
    if (projects.length === 0) return ok(base);
    base.total = projects.length;

    const summaryByProject = new Map<string, string>();
    for (let i = 0; i < projects.length; i += 200) {
        const { data: dossiers, error: dossiersError } = await db
            .from("dossiers")
            .select("project_id, payload")
            .in("project_id", projects.slice(i, i + 200).map((p) => p.id));
        if (dossiersError) return internalFailure(dossiersError);
        for (const d of (dossiers ?? []) as { project_id: string; payload: unknown }[]) {
            summaryByProject.set(d.project_id, JSON.stringify(d.payload ?? {}).slice(0, 4000));
        }
    }

    const selected = await analysisModel(db, caller.userId);
    if (!selected.ok) return selected;
    const account = lawAccount(selected.settings.web_search, selected.model, selected.settings.api_keys);
    base.law_available = account !== null;

    const keywordScore = new Map(
        projects.map((p) => [
            p.id,
            scoreCandidate(question, `${p.name} ${p.counterparty ?? ""} ${p.contract_type ?? ""} ${summaryByProject.get(p.id) ?? ""}`),
        ]),
    );
    const ordered = [...projects].sort((a, b) => keywordScore.get(b.id)! - keywordScore.get(a.id)!);

    // ── retrieve: literal search in the indexed text, under a budget ────────
    const state = new Map<string, SearchState>(
        projects.map((p) => [
            p.id,
            { searched: false, unavailable: false, pending: false, termsHit: new Set(), docs: new Map() },
        ]),
    );
    const coverage = emptyCoverage();
    let calls = 0;
    let indexDown = false;
    for (const [index, term] of terms.entries()) {
        if (indexDown || calls >= SEARCH_BUDGET) break;
        // The first phrase is searched everywhere; later ones (often synonyms)
        // only where nothing was found yet, so the budget buys coverage.
        const targets = ordered
            .filter((p) => {
                const s = state.get(p.id)!;
                if (s.unavailable) return false;
                return index === 0 || s.termsHit.size === 0;
            })
            .slice(0, SEARCH_BUDGET - calls);
        calls += targets.length;
        await mapWithConcurrency(targets, SEARCH_CONCURRENCY, async (p) => {
            const s = state.get(p.id)!;
            if (indexDown) return;
            const result = await findDocumentText(db, {
                userId: caller.userId,
                userEmail: caller.userEmail,
                workspace: p.org_id ?? "personal",
                scope: "project",
                projectId: p.id,
                query: term,
                limit: 5,
            }).catch(internalFailure);
            if (!result.ok) {
                s.unavailable = true;
                if (result.kind === "error") {
                    // Most likely the search migration is missing: stop
                    // spending calls and read the files instead.
                    indexDown = true;
                    console.warn(`[acervo] text search unavailable (${safeError(result.error).category})`);
                }
                return;
            }
            const c = result.data.coverage;
            if (!s.searched) {
                coverage.total_versions += c.total_versions;
                coverage.indexed_versions += c.indexed_versions;
                coverage.pending_versions += c.pending_versions;
                coverage.failed_versions += c.failed_versions;
                coverage.versions_needing_ocr += c.versions_needing_ocr;
                s.pending = c.indexed_versions < c.total_versions;
                if (s.pending) coverage.contracts_pending++;
            }
            s.searched = true;
            for (const m of result.data.matches) {
                s.termsHit.add(term);
                const doc = s.docs.get(m.document_id) ?? {
                    version_id: m.version_id,
                    starts: [],
                    excerpt: m.excerpt,
                    excerpt_start: m.excerpt_start_char,
                };
                doc.starts.push({ start: m.start_char, end: m.end_char });
                s.docs.set(m.document_id, doc);
            }
        });
    }
    for (const s of state.values()) if (!s.searched && !s.unavailable) coverage.contracts_not_searched++;
    base.coverage = coverage;

    // ── choose what to read ─────────────────────────────────────────────────
    const hitCount = (p: Project) => state.get(p.id)!.termsHit.size;
    const withHits = ordered
        .filter((p) => hitCount(p) > 0)
        .sort((a, b) => hitCount(b) - hitCount(a) || keywordScore.get(b.id)! - keywordScore.get(a.id)!);
    const unsearchable = (p: Project) => {
        const s = state.get(p.id)!;
        return s.unavailable || s.pending || !s.searched;
    };
    // Fill the remaining reads with contracts the search could not judge
    // but whose name or analysis matches; with no index at all, any contract.
    const fill = ordered.filter(
        (p) => hitCount(p) === 0 && unsearchable(p) && (keywordScore.get(p.id)! > 0 || indexDown || terms.length === 0),
    );
    const chosen = [...withHits, ...fill].slice(0, CONTRACTS_READ);

    // ── read the chosen contracts ───────────────────────────────────────────
    const texts = new Map<string, ContractText[]>();
    const needFile: Project[] = [];
    for (const p of chosen) {
        const s = state.get(p.id)!;
        const docs = [...s.docs.entries()].slice(0, DOCS_READ_PER_CONTRACT);
        const read: ContractText[] = [];
        for (const [documentId, doc] of docs) {
            try {
                const stored = await readStoredDocumentText(db, {
                    userId: caller.userId,
                    userEmail: caller.userEmail,
                    documentId,
                    versionId: doc.version_id,
                });
                if (stored?.status === "ready" && stored.text) {
                    read.push({ document_id: documentId, text: stored.text, spans: doc.starts, offset: 0 });
                    continue;
                }
            } catch (error) {
                console.warn(`[acervo] stored text unreadable (${safeError(error).category})`);
            }
            // The excerpt is still real text from the index.
            read.push({
                document_id: documentId,
                text: doc.excerpt,
                spans: [{ start: 0, end: doc.excerpt.length }],
                offset: doc.excerpt_start,
            });
        }
        if (read.length > 0) texts.set(p.id, read);
        else needFile.push(p);
    }
    if (needFile.length > 0) {
        try {
            const files = await latestContractFiles(db, needFile.map((p) => p.id));
            for (const p of needFile) {
                const file = files.get(p.id);
                if (!file) continue;
                try {
                    const text = await contractFileText(file);
                    if (text) texts.set(p.id, [{ document_id: file.document_id, text, spans: [], offset: 0 }]);
                } catch (error) {
                    console.warn(`[acervo] contract unreadable (${safeError(error).category})`);
                }
            }
        } catch (error) {
            return internalFailure(error);
        }
    }

    const passages: Passage[] = [];
    const read: Project[] = [];
    for (const p of chosen) {
        const docs = texts.get(p.id);
        if (!docs) continue;
        read.push(p);
        const budget = Math.floor(CHARS_PER_CONTRACT / docs.length);
        for (const doc of docs) {
            const hits = [...doc.spans, ...findOccurrences(doc.text, terms)];
            const windows =
                hits.length > 0
                    ? passageWindows(doc.text.length, hits, { maxChars: budget })
                    : doc.text.length <= FALLBACK_HEAD + FALLBACK_TAIL
                      ? [{ start: 0, end: doc.text.length }]
                      : [
                            { start: 0, end: FALLBACK_HEAD },
                            { start: doc.text.length - FALLBACK_TAIL, end: doc.text.length },
                        ];
            for (const w of windows) {
                passages.push({
                    id: `P${passages.length + 1}`,
                    project_id: p.id,
                    document_id: doc.document_id,
                    label: labelOf(p),
                    start: doc.offset + w.start,
                    end: doc.offset + w.end,
                    text: doc.text.slice(w.start, w.end),
                });
            }
        }
    }

    // ── official legislation, only with a real source ───────────────────────
    const lawPages: { title: string; url: string; text: string }[] = [];
    if (includeLaw && account) {
        try {
            const results = (await searchWeb(lawSearchQuery(question), { account }))
                .filter((r) => isOfficialLawUrl(r.url))
                .slice(0, LAW_RESULTS);
            for (const [i, r] of results.entries()) {
                let text = r.snippet;
                if (i < LAW_PAGES_READ) {
                    try {
                        const page = await readWebPage(r.url, { account });
                        // A redirect may leave the official site: keep the snippet then.
                        if (!isOfficialLawUrl(page.url ?? r.url)) throw new Error("left the official site");
                        const hits = findOccurrences(page.text, [...terms, ...keywords(question)]);
                        text = hits.length
                            ? passageWindows(page.text.length, hits, { radius: 600, maxWindows: 3, maxChars: LAW_CHARS })
                                  .map((w) => page.text.slice(w.start, w.end))
                                  .join("\n[…]\n")
                            : page.text.slice(0, LAW_CHARS);
                    } catch {
                        // The snippet still came from the official page.
                    }
                }
                if (text.trim()) lawPages.push({ title: r.title || r.url, url: r.url, text });
            }
        } catch (error) {
            console.warn(`[acervo] law search failed (${safeError(error).category})`);
        }
    }
    lawPages.forEach((page, i) =>
        passages.push({
            id: `L${i + 1}`,
            project_id: null,
            document_id: null,
            label: page.title,
            start: 0,
            end: page.text.length,
            text: page.text,
            url: page.url,
        }),
    );

    // Rows for every contract, refined below with what the model read.
    const matchRow = (p: Project): AcervoMatch => {
        const s = state.get(p.id)!;
        const firstDoc = [...s.docs.values()][0];
        if (firstDoc) {
            return {
                project_id: p.id,
                contract: p.name,
                counterparty: p.counterparty,
                contract_type: p.contract_type,
                hit: true,
                quote: preview(firstDoc.excerpt),
                verified: true,
                basis: "busca",
            };
        }
        return {
            project_id: p.id,
            contract: p.name,
            counterparty: p.counterparty,
            contract_type: p.contract_type,
            hit: false,
            quote: null,
            verified: false,
            basis: s.unavailable || s.pending ? "pendente" : s.searched ? "busca" : "nao_buscado",
        };
    };
    const matches = new Map(projects.map((p) => [p.id, matchRow(p)]));
    const sortedMatches = () =>
        [...matches.values()].sort((a, b) => Number(b.hit) - Number(a.hit));

    if (read.length === 0) {
        return ok({ ...base, matches: sortedMatches() });
    }

    // ── answer, with citations ──────────────────────────────────────────────
    let parsed: Record<string, unknown>;
    try {
        const raw = await completeText({
            model: selected.model,
            systemPrompt: SYSTEM,
            user: buildPrompt(question, passages, read.map((p) => ({ id: p.id, label: labelOf(p) }))),
            // Generous: a reasoning model spends part of this budget thinking,
            // and a JSON answer cut mid-object is unusable.
            maxTokens: 8000,
            apiKeys: selected.settings.api_keys,
        });
        try {
            parsed = parseModelJson(raw);
        } catch {
            // Log the size only: the answer quotes contract text, and so would
            // the parser's own error message.
            console.warn(`[acervo] unparseable answer (${raw.length} chars)`);
            throw new Error("model did not return JSON");
        }
    } catch (error) {
        return internalFailure(error);
    }

    // ── verify every quote by code ──────────────────────────────────────────
    const byPassage = new Map(passages.map((p) => [p.id, p]));
    const readIds = new Set(read.map((p) => p.id));
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const locateIn = (projectId: string, quote: string) => {
        for (const doc of texts.get(projectId) ?? []) {
            const span = locateQuote(doc.text, quote);
            if (span) {
                return {
                    document_id: doc.document_id,
                    span: { start: doc.offset + span.start, end: doc.offset + span.end },
                };
            }
        }
        return null;
    };

    const sources: AcervoSource[] = [];
    const lawSources: AcervoLawSource[] = [];
    const usedN = new Set<number>();
    const rawSources = Array.isArray(parsed.sources) ? parsed.sources : [];
    for (const [i, rawSource] of rawSources.entries()) {
        if (!rawSource || typeof rawSource !== "object") continue;
        const s = rawSource as Record<string, unknown>;
        const quote = str(s.quote);
        if (!quote) continue;
        const nValue = Number(s.n);
        // The answer's markers point at these numbers: a duplicate is dropped,
        // never renumbered, so a marker can't open the wrong source.
        const n = Number.isInteger(nValue) && nValue > 0 ? nValue : i + 1;
        if (usedN.has(n)) continue;
        usedN.add(n);
        const passage = byPassage.get(str(s.passage) ?? "");

        if (passage?.url) {
            lawSources.push({
                n,
                title: passage.label,
                url: passage.url,
                quote,
                verified: locateQuote(passage.text, quote) !== null,
            });
            continue;
        }

        const claimed = passage?.project_id ?? str(s.project_id);
        let projectId = claimed && readIds.has(claimed) ? claimed : null;
        let found = projectId ? locateIn(projectId, quote) : null;
        if (!found) {
            // The quote may be real but attributed to the wrong contract.
            for (const other of read) {
                if (other.id === projectId) continue;
                const elsewhere = locateIn(other.id, quote);
                if (elsewhere) {
                    projectId = other.id;
                    found = elsewhere;
                    break;
                }
            }
        }
        const project = projectId ? projectById.get(projectId) : undefined;
        sources.push({
            n,
            project_id: project?.id ?? null,
            document_id: found?.document_id ?? passage?.document_id ?? null,
            contract: project?.name ?? "Contrato não identificado",
            ref: str(s.ref),
            quote,
            verified: found !== null,
            start_char: found?.span.start ?? null,
            end_char: found?.span.end ?? null,
        });
    }

    const rawMatches = Array.isArray(parsed.matches) ? parsed.matches : [];
    const judged = new Map<string, Record<string, unknown>>();
    for (const m of rawMatches) {
        if (m && typeof m === "object") {
            const id = str((m as Record<string, unknown>).project_id);
            if (id && readIds.has(id)) judged.set(id, m as Record<string, unknown>);
        }
    }
    for (const p of read) {
        const m = judged.get(p.id);
        const row = matches.get(p.id)!;
        if (!m) continue; // not judged: keep what the search said
        const quote = str(m.quote);
        const modelHit = m.hit === true || m.hit === "true";
        const checked = modelHit && quote ? locateIn(p.id, quote) !== null : false;
        // A hit counts only when its quote is in the contract. A judgement that
        // can't be checked leaves the literal search result standing.
        if (modelHit && !checked) continue;
        matches.set(p.id, {
            ...row,
            hit: checked,
            quote: checked ? quote : null,
            verified: checked,
            basis: "lido",
        });
    }

    const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
    // Every source the answer cites must check out; one trivial quote beside an
    // unverifiable one does not make the answer found.
    const cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    const all = [...sources, ...lawSources];
    const relied = cited.size ? all.filter((s) => cited.has(s.n)) : all;
    const verified = relied.length > 0 && relied.every((s) => s.verified);
    const claimedFound = parsed.found === true || parsed.found === "true";
    return ok({
        ...base,
        answer,
        // A claim nobody can check is not an answer.
        found: claimedFound && verified,
        sources,
        searched: read.length,
        matches: sortedMatches(),
        law_sources: lawSources,
    });
}
