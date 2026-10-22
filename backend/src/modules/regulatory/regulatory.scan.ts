// One run of a regulatory scan: read its sources, keep what it watches, drop
// what it already found, cross the rest with the contract base, and store the
// changes for the team to triage.
//
// Runs as the durable job "regulatory.scan" (at-least-once, so it is
// idempotent: the unique (scan_id, source, external_id) key and the
// already-seen check make a re-run insert nothing new).

import type { Db } from "../../lib/supabase";
import type { DbJob } from "../../lib/dbq/types";
import { enqueueDbJob } from "../../lib/dbq/enqueue";
import { completeText } from "../../lib/llm";
import { contractCorpus, type ContractCorpusEntry } from "../contracts/contracts.service";
import { getUserModelSettings } from "../user/user.service";
import {
    affectedContracts,
    assessImpact,
    effectiveDate,
    findTerms,
    fold,
    matchesScan,
    TOPIC_TERMS,
    topicsOf,
} from "./regulatory.match";
import {
    defaultFetcher,
    readSource,
    SOURCE_IDS,
    type Fetcher,
    type RegulatoryItem,
    type SourceId,
} from "./regulatory.sources";

export type ScanRow = {
    id: string;
    user_id: string | null;
    org_id: string | null;
    name: string;
    sources: string[];
    issuers: string[];
    keywords: string[];
    topics: string[];
    enabled: boolean;
};

/** How many changes of one run get a model-written summary. */
const SUMMARIES_PER_RUN = 10;
/** Already-seen window: older items are no longer returned by any source. */
const SEEN_WINDOW_DAYS = 45;

export type Summarizer = (args: { scan: ScanRow; item: RegulatoryItem }) => Promise<{ summary: string; quote: string } | null>;

export type ScanDeps = {
    fetcher?: Fetcher;
    now?: Date;
    summarize?: Summarizer;
};

/**
 * "Resolução BCB nº 456" and "RESOLUÇÃO BCB Nº 456, DE 16 DE OUTUBRO" are the
 * same act seen by two sources. The key is the act's kind and number.
 */
export function actKey(title: string): string | null {
    const t = fold(title);
    const m =
        /(resolucao conjunta|resolucao|circular|instrucao normativa|portaria|carta circular|comunicado|decreto|lei complementar|lei|medida provisoria)\s*(bcb|cmn|cvm|rfb|anpd|coaf)?[^0-9]{0,12}?n?\s*[o°º.]*\s*([\d.]+)/.exec(
            t,
        );
    if (!m) return null;
    return `${m[1]}|${m[2] ?? ""}|${m[3].replace(/\./g, "")}`;
}

const SUMMARY_SYSTEM = `Você resume mudanças regulatórias brasileiras para o jurídico de uma
fintech (PSP, ativos virtuais, câmbio).

Regras invioláveis:
- Use SOMENTE o texto oficial fornecido. Nunca invente número, prazo ou obrigação.
- "quote" é um trecho VERBATIM do texto oficial que sustenta o resumo.
- Português do Brasil, no máximo 2 frases, sem floreio.
- Responda apenas com JSON válido: {"summary": "...", "quote": "..."}.`;

function parseJson(raw: string): Record<string, unknown> | null {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
        return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
        return null;
    }
}

const squash = (s: string) => fold(s).replace(/[^a-z0-9]+/g, " ").trim();

/** A summary is kept only when its quote is really in the official text. */
export function quoteChecksOut(quote: string, official: string): boolean {
    const q = squash(quote.replace(/…/g, " "));
    return q.length >= 12 && squash(official).includes(q);
}

/**
 * The scan owner's model writes the summary. No model configured is a normal
 * state: the change shows the official excerpt instead.
 */
export function modelSummarizer(db: Db): Summarizer {
    return async ({ scan, item }) => {
        if (!scan.user_id) return null;
        const settings = await getUserModelSettings(scan.user_id, db, { orgId: scan.org_id });
        const model = settings.tabular_model ?? settings.last_selected_chat_model;
        if (!model) return null;
        const raw = await completeText({
            model,
            systemPrompt: SUMMARY_SYSTEM,
            user: `Ato: ${item.title}\nÓrgão: ${item.issuer ?? "-"}\n\nTexto oficial:\n${item.excerpt}`,
            maxTokens: 600,
            apiKeys: settings.api_keys,
        });
        const parsed = parseJson(raw);
        const summary = typeof parsed?.summary === "string" ? parsed.summary.trim() : "";
        const quote = typeof parsed?.quote === "string" ? parsed.quote.trim() : "";
        if (!summary || !quote) return null;
        return { summary, quote };
    };
}

export type ScanRunSummary = {
    read: number;
    matched: number;
    inserted: number;
    errors: string[];
    contracts_searched: number;
};

export async function runRegulatoryScan(db: Db, scanId: string, deps: ScanDeps = {}): Promise<ScanRunSummary> {
    const now = deps.now ?? new Date();
    const fetcher = deps.fetcher ?? defaultFetcher;
    const summarize = deps.summarize ?? modelSummarizer(db);

    const { data: scanData, error: scanError } = await db
        .from("regulatory_scans")
        .select("id, user_id, org_id, name, sources, issuers, keywords, topics, enabled")
        .eq("id", scanId)
        .maybeSingle();
    if (scanError) throw scanError;
    const scan = scanData as ScanRow | null;
    if (!scan || !scan.enabled) return { read: 0, matched: 0, inserted: 0, errors: [], contracts_searched: 0 };

    // ── read ────────────────────────────────────────────────────────────────
    const items: RegulatoryItem[] = [];
    const errors: string[] = [];
    for (const source of scan.sources) {
        if (!(SOURCE_IDS as readonly string[]).includes(source)) continue;
        const result = await readSource(source as SourceId, fetcher, now);
        items.push(...result.items);
        errors.push(...result.errors);
    }

    // ── filter + dedupe (within the run, and against what was found before) ──
    const since = new Date(now.getTime() - SEEN_WINDOW_DAYS * 86_400_000).toISOString();
    const { data: seenRows, error: seenError } = await db
        .from("regulatory_changes")
        .select("source, external_id, title")
        .eq("scan_id", scan.id)
        .gte("created_at", since);
    if (seenError) throw seenError;
    const seenIds = new Set<string>();
    const seenActs = new Set<string>();
    for (const row of (seenRows ?? []) as { source: string; external_id: string; title: string }[]) {
        seenIds.add(`${row.source}|${row.external_id}`);
        const key = actKey(row.title);
        if (key) seenActs.add(key);
    }

    const fresh: { item: RegulatoryItem; terms: string[] }[] = [];
    for (const item of items) {
        const id = `${item.source}|${item.external_id}`;
        if (seenIds.has(id)) continue;
        const match = matchesScan(item, scan);
        if (!match.ok) continue;
        const key = actKey(item.title);
        if (key && seenActs.has(key)) continue;
        seenIds.add(id);
        if (key) seenActs.add(key);
        fresh.push({ item, terms: match.terms });
    }

    // ── cross with the contract base ────────────────────────────────────────
    let corpus: ContractCorpusEntry[] = [];
    if (fresh.length > 0) corpus = await contractCorpus(db, { orgId: scan.org_id, userId: scan.user_id });

    let summaries = 0;
    const rows: Record<string, unknown>[] = [];
    for (const { item, terms } of fresh) {
        const text = `${item.title} ${item.excerpt}`;
        const topics = topicsOf(text);
        const topicTerms = topics.flatMap((t) => findTerms(text, TOPIC_TERMS[t]));
        const searchTerms = [...new Set([...terms, ...topicTerms])];
        const affected = affectedContracts(corpus, searchTerms);
        const verdict = assessImpact({ item, topics, scanTopics: scan.topics, terms: searchTerms, affected });

        let summary: string | null = null;
        let summaryQuote: string | null = null;
        if (verdict.impact !== "baixo" && summaries < SUMMARIES_PER_RUN) {
            summaries++;
            try {
                const s = await summarize({ scan, item });
                if (s && quoteChecksOut(s.quote, item.excerpt)) {
                    summary = s.summary;
                    summaryQuote = s.quote;
                }
            } catch {
                // A provider error costs the summary, never the change.
            }
        }

        rows.push({
            scan_id: scan.id,
            source: item.source,
            external_id: item.external_id,
            title: item.title,
            act_type: item.act_type,
            issuer: item.issuer,
            published_at: item.published_at,
            url: item.url,
            excerpt: item.excerpt,
            summary,
            summary_quote: summaryQuote,
            impact: verdict.impact,
            impact_reason: verdict.reason,
            effective_date: effectiveDate(item.excerpt, item.published_at),
            topics,
            matched_terms: searchTerms,
            affected,
            suggested_action: verdict.action,
        });
    }

    if (rows.length > 0) {
        const { error: insertError } = await db.from("regulatory_changes").insert(rows);
        if (insertError) throw insertError;
    }

    const { error: touchError } = await db
        .from("regulatory_scans")
        .update({
            last_run_at: now.toISOString(),
            // Every source failing is worth showing; one feed down among several is noise.
            last_error: errors.length > 0 && items.length === 0 ? errors.join(" · ") : null,
            updated_at: now.toISOString(),
        })
        .eq("id", scan.id);
    if (touchError) throw touchError;

    return {
        read: items.length,
        matched: fresh.length,
        inserted: rows.length,
        errors,
        contracts_searched: corpus.length,
    };
}

export async function handleRegulatoryScan(db: Db, job: DbJob): Promise<Record<string, unknown>> {
    const scanId = job.payload.scanId;
    if (typeof scanId !== "string") return { skipped: "malformed" };
    return await runRegulatoryScan(db, scanId);
}

export function enqueueRegulatoryScan(db: Db, scanId: string) {
    return enqueueDbJob(db, {
        kind: "regulatory.scan",
        payload: { scanId },
        dedupeKey: `regulatory.scan:${scanId}`,
        maxAttempts: 3,
    });
}

/** How stale a scan may get before the sweep runs it again. */
export const SCAN_INTERVAL_MS = (() => {
    const raw = Number(process.env.REGULATORY_SCAN_INTERVAL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 6 * 60 * 60 * 1000;
})();

/** Queue every enabled scan not run within the interval. */
export async function enqueueDueRegulatoryScans(db: Db, now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - SCAN_INTERVAL_MS).toISOString();
    const { data, error } = await db
        .from("regulatory_scans")
        .select("id")
        .eq("enabled", true)
        .or(`last_run_at.is.null,last_run_at.lt.${cutoff}`);
    if (error) throw error;
    const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
    for (const id of ids) await enqueueRegulatoryScan(db, id);
    return ids.length;
}
