// The intake agent: reads the contract attached to a request and fills in
// what it can of the checklist, each answer marked "inferido, confirme" with
// the contract's own words it came from. It never answers what the contract
// cannot say (whether the requester agrees, who approved), never overwrites a
// person's answer, and an answer whose quote is not in the text is dropped.

import type { Db } from "../../lib/supabase";
import { completeText } from "../../lib/llm";
import { NonRetryableJobError } from "../../lib/dbq/runner";
import { safeError } from "../../lib/safeError";
import { readStoredDocumentText } from "../documents/documents.service";
import { finishAgentRun, recordCardEvent, startAgentRun } from "../contracts/contracts.service";
import { REQUEST_COLUMNS, type RequestRow } from "./requests.access";
import {
    effectiveTemplate,
    mergeInferred,
    readAnswers,
    type IntakeItem,
} from "./requests.intake";
import { teamOwner, triageModel } from "./requests.triage";
import { readDate, readMonths, type InferredTerms } from "./requests.terms";

export const PREFILL_JOB_KIND = "request.intake_prefill";
export const PREFILL_AGENT = "intake";
export const PREFILL_AGENT_VERSION = "2";
export const PREFILL_AGENT_NAME = "Agente de intake";

/** Contract text sent to the model: the head of a long contract carries the parties, object and price. */
const MAX_TEXT = 60_000;
/** Room for nine answers with their quotes; at 1500 a small model's JSON came back cut off. */
const MAX_OUTPUT_TOKENS = 4000;

type Inferred = Record<string, { value: string; quote?: string | null; choice?: "sim" | "nao" | null }>;

function systemPrompt(items: IntakeItem[]): string {
    const list = items
        .map(
            (i) =>
                `- "${i.key}": ${i.label}${i.kind === "yes_no" ? ` (sim/não${i.detail_label ? `; e ${i.detail_label}` : ""})` : ""}`,
        )
        .join("\n");
    return `Você prepara o checklist de intake de um pedido ao time jurídico, lendo o contrato anexado.

Perguntas do checklist:
${list}

Regras:
- Responda SOMENTE o que o contrato diz de forma explícita. Se o contrato não responde a pergunta, deixe-a de fora.
- Nunca responda o que só quem pediu sabe: se aprovou, se concorda com a proposta, a intenção comercial.
- Para cada resposta, copie em "quote" o trecho LITERAL do contrato de onde ela saiu: a menor frase que prova a resposta (até 200 caracteres), sem alterar uma palavra.
- Perguntas de sim/não: "choice" é "sim" ou "nao", e "value" é a resposta curta com o detalhe ("Sim. As duas partes trocam informações sobre clientes.").
- Português do Brasil, objetivo. Valores e datas como estão no contrato.
- Além das perguntas, leia os dados do contrato em "terms", cada um só se o contrato disser de forma explícita, com o mesmo "quote" literal: "counterparty" (nome da outra parte, não a Avenia nem empresa do grupo), "term_start" (data de início da vigência, como AAAA-MM-DD) e "term_months" (prazo em meses, só o número; converta anos em meses).
- Responda apenas com JSON válido, sem cercas de código: {"answers": {"<chave>": {"value": "...", "quote": "...", "choice": "sim"|"nao"|null}}, "terms": {"counterparty": {"value": "...", "quote": "..."}, "term_start": {"value": "AAAA-MM-DD", "quote": "..."}, "term_months": {"value": "12", "quote": "..."}}}.`;
}

/**
 * Normalizes what a Word file and a model write differently, so a quote
 * matches the text it came from: quotes, dashes, soft hyphens and
 * zero-width characters, and spacing.
 */
function squash(s: string): string {
    return s
        .normalize("NFKC")
        .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "")
        .replace(/[“”«»„]/g, '"')
        .replace(/[‘’‚]/g, "'")
        .replace(/[‐‑‒–—―]/g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

/** The `{...}` that starts at `from` (a "{"), or null when the text ends first. */
function objectAt(text: string, from: number): string | null {
    let depth = 0;
    let inString = false;
    for (let i = from; i < text.length; i += 1) {
        const c = text[i];
        if (inString) {
            if (c === "\\") i += 1;
            else if (c === '"') inString = false;
        } else if (c === '"') inString = true;
        else if (c === "{") depth += 1;
        else if (c === "}" && (depth -= 1) === 0) return text.slice(from, i + 1);
    }
    return null;
}

/**
 * The model's answers as an object. When its JSON was cut off (it ran out
 * of room), the answers that did arrive whole are kept; null when there is
 * nothing to read.
 */
function readAnswerObjects(raw: string): Record<string, unknown> | null {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    try {
        const parsed = JSON.parse(start !== -1 && end > start ? cleaned.slice(start, end + 1) : cleaned) as { answers?: unknown };
        return parsed && typeof parsed.answers === "object" && parsed.answers ? (parsed.answers as Record<string, unknown>) : {};
    } catch {
        const body = cleaned.indexOf("{", cleaned.search(/"answers"\s*:/) + 1);
        if (cleaned.search(/"answers"\s*:/) === -1 || body === -1) return null;
        const salvaged: Record<string, unknown> = {};
        const entry = /"([A-Za-z0-9_]+)"\s*:\s*\{/g;
        entry.lastIndex = body + 1;
        for (let m = entry.exec(cleaned); m; m = entry.exec(cleaned)) {
            const object = objectAt(cleaned, m.index + m[0].length - 1);
            if (!object) break;
            try {
                salvaged[m[1]] = JSON.parse(object);
            } catch {
                break;
            }
            entry.lastIndex = m.index + m[0].length - 1 + object.length;
        }
        return Object.keys(salvaged).length ? salvaged : null;
    }
}

/**
 * The model's answers, kept only for questions of the checklist and only
 * with a quote that is really in the contract.
 */
export function parsePrefill(
    raw: string,
    items: IntakeItem[],
    contractText: string,
): { inferred: Inferred; dropped: number; unparsed: boolean } {
    const answers = readAnswerObjects(raw);
    if (!answers) return { inferred: {}, dropped: 0, unparsed: true };
    const haystack = squash(contractText);
    const keys = new Set(items.map((i) => i.key));
    const inferred: Inferred = {};
    let dropped = 0;
    for (const [key, raw] of Object.entries(answers)) {
        if (!keys.has(key) || !raw || typeof raw !== "object") continue;
        const a = raw as Record<string, unknown>;
        const value = typeof a.value === "string" ? a.value.trim() : "";
        const quote = typeof a.quote === "string" ? a.quote.trim() : "";
        if (!value) continue;
        if (!quote || squash(quote).length < 4 || !haystack.includes(squash(quote))) {
            dropped += 1;
            continue;
        }
        inferred[key] = {
            value,
            quote,
            choice: a.choice === "sim" || a.choice === "nao" ? a.choice : null,
        };
    }
    return { inferred, dropped, unparsed: false };
}

/**
 * The terms the model read: each only with a quote that is literally in the
 * contract, and a value that normalizes (a date as AAAA-MM-DD, months as a
 * whole number in range). Anything else is dropped, never guessed.
 */
export function parseTermsInferred(raw: string, contractText: string): { terms: InferredTerms; dropped: number } {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    let block: Record<string, unknown> = {};
    try {
        const parsed = JSON.parse(start !== -1 && end > start ? cleaned.slice(start, end + 1) : cleaned) as { terms?: unknown };
        if (parsed && typeof parsed.terms === "object" && parsed.terms) block = parsed.terms as Record<string, unknown>;
    } catch {
        return { terms: {}, dropped: 0 };
    }
    const haystack = squash(contractText);
    const terms: InferredTerms = {};
    let dropped = 0;
    for (const key of ["counterparty", "term_start", "term_months"] as const) {
        const entry = block[key];
        if (!entry || typeof entry !== "object") continue;
        const a = entry as Record<string, unknown>;
        const value = typeof a.value === "string" ? a.value.trim() : typeof a.value === "number" ? String(a.value) : "";
        const quote = typeof a.quote === "string" ? a.quote.trim() : "";
        if (!value) continue;
        const normalized = key === "term_start" ? readDate(value) : key === "term_months" ? (readMonths(value) === null ? null : String(readMonths(value))) : value.slice(0, 200);
        if (!normalized || !quote || squash(quote).length < 4 || !haystack.includes(squash(quote))) {
            dropped += 1;
            continue;
        }
        terms[key] = { value: normalized, quote };
    }
    return { terms, dropped };
}

/** The newest document on the card and its current version. */
async function latestDocument(db: Db, projectId: string): Promise<{ id: string; version_id: string } | null> {
    const { data, error } = await db
        .from("documents")
        .select("id, current_version_id, created_at")
        .eq("project_id", projectId)
        .is("archived_at", null)
        .order("created_at", { ascending: false })
        .limit(5);
    if (error) throw error;
    const doc = ((data ?? []) as { id: string; current_version_id: string | null }[]).find((d) => d.current_version_id);
    return doc ? { id: doc.id, version_id: doc.current_version_id! } : null;
}

export async function handleIntakePrefill(
    db: Db,
    job: { payload: Record<string, unknown>; id?: string },
): Promise<Record<string, unknown>> {
    const requestId = String(job.payload.request_id ?? "");
    const { data, error } = await db
        .from("legal_requests")
        .select(REQUEST_COLUMNS)
        .eq("id", requestId)
        .maybeSingle();
    if (error) throw error;
    const row = data as unknown as RequestRow | null;
    if (!row || !row.project_id) return { skipped: "missing" };
    if (row.status === "entregue" || row.status === "cancelado") return { skipped: "closed" };

    const { data: team } = await db.from("legal_teams").select("intake_template").eq("org_id", row.org_id).maybeSingle();
    const template = effectiveTemplate((team as { intake_template?: unknown } | null)?.intake_template);
    const stored = readAnswers(row.intake);
    const open = template.filter((i) => !stored[i.key]);
    const termsOpen = !row.counterparty || !row.term_start || row.term_months == null;
    if (open.length === 0 && !termsOpen) return { skipped: "answered" };

    const doc = await latestDocument(db, row.project_id);
    if (!doc) return { skipped: "no_document" };
    // Before waiting on the contract's text: with no model there is nothing
    // to wait for, and the checklist should say so at once.
    const selected = await triageModel(db, row.org_id);
    if (!selected) return { skipped: "no_model" };
    // The card lives in the team's organization; its owner reads it the way
    // the team does (the requester may no longer reach a file moved there).
    const owner = await teamOwner(db, row.org_id);
    if (!owner) return { skipped: "no_owner" };
    const text = await readStoredDocumentText(db, {
        userId: owner.user_id,
        userEmail: owner.email,
        documentId: doc.id,
        versionId: doc.version_id,
    });
    if (!text || text.status === "pending" || text.status === "processing") {
        // The text is still being extracted: the runner retries with backoff.
        throw new Error("contract text not ready");
    }
    if (text.status === "failed" || !text.text?.trim()) {
        throw new NonRetryableJobError("contract text unavailable");
    }

    const runId = await startAgentRun(db, {
        projectId: row.project_id,
        orgId: row.org_id,
        agent: PREFILL_AGENT,
        agentVersion: PREFILL_AGENT_VERSION,
        jobId: job.id ?? null,
    });
    const started = Date.now();
    let result: ReturnType<typeof parsePrefill> = { inferred: {}, dropped: 0, unparsed: false };
    let rawReply = "";
    try {
        const raw = await completeText({
            model: selected.model,
            systemPrompt: systemPrompt(open),
            user: `Contrato:\n${text.text.slice(0, MAX_TEXT)}`,
            maxTokens: MAX_OUTPUT_TOKENS,
            apiKeys: selected.apiKeys,
        });
        rawReply = raw;
        result = parsePrefill(raw, open, text.text);
        if (result.unparsed) {
            // Logged, not retried: the same contract would get the same answer.
            console.error("[requests] intake prefill unreadable answer", { requestId, length: raw.length });
        }
    } catch (err) {
        console.error("[requests] intake prefill model failed", { requestId, error: safeError(err) });
        await finishAgentRun(db, runId, { status: "failed", error: "model_failed", modelResolved: selected.model, latencyMs: Date.now() - started });
        // No key for the model is not going to fix itself between retries:
        // fail now, so the checklist stops saying it is reading the contract.
        if (err instanceof Error && /\bnot configured\b/i.test(err.message)) throw new NonRetryableJobError("model_not_configured");
        throw err;
    }

    // Re-read: the requester may have answered while the model ran.
    const { data: fresh } = await db.from("legal_requests").select("intake").eq("id", row.id).maybeSingle();
    const now = new Date().toISOString();
    const merged = mergeInferred(template, readAnswers((fresh as { intake?: unknown } | null)?.intake), result.inferred, now);
    if (merged.filled.length) {
        const { error: updateError } = await db
            .from("legal_requests")
            .update({ intake: merged.answers, updated_at: now })
            .eq("id", row.id);
        if (updateError) throw updateError;
    }
    // The contract's own terms: kept apart, only where the requester has not answered.
    let termsFound = 0;
    if (!result.unparsed) {
        const read = parseTermsInferred(rawReply, text.text);
        const { data: current } = await db
            .from("legal_requests")
            .select("counterparty, term_start, term_months, terms_inferred")
            .eq("id", row.id)
            .maybeSingle();
        const c = (current ?? {}) as { counterparty?: string | null; term_start?: string | null; term_months?: number | null; terms_inferred?: InferredTerms | null };
        const taken: InferredTerms = { ...(c.terms_inferred ?? {}) };
        if (read.terms.counterparty && !c.counterparty) taken.counterparty = read.terms.counterparty;
        if (read.terms.term_start && !c.term_start) taken.term_start = read.terms.term_start;
        if (read.terms.term_months && c.term_months == null) taken.term_months = read.terms.term_months;
        termsFound = Object.keys(taken).length - Object.keys(c.terms_inferred ?? {}).length;
        if (termsFound > 0) {
            const { error: termsError } = await db.from("legal_requests").update({ terms_inferred: taken, updated_at: now }).eq("id", row.id);
            if (termsError) throw termsError;
        }
        result.dropped += read.dropped;
    }
    await finishAgentRun(db, runId, {
        status: "succeeded",
        modelResolved: selected.model,
        latencyMs: Date.now() - started,
        output: { filled: merged.filled, terms: termsFound, dropped: result.dropped, unparsed: result.unparsed },
    });
    await recordCardEvent(db, {
        projectId: row.project_id,
        orgId: row.org_id,
        actorType: "agent",
        actorId: `agent:${PREFILL_AGENT}@${PREFILL_AGENT_VERSION}`,
        actorName: PREFILL_AGENT_NAME,
        action: "intake.prefilled",
        after: { filled: merged.filled.length, pending: template.filter((i) => i.required && !merged.answers[i.key]).length },
        runId,
        source: "agent",
    });
    return { filled: merged.filled.length, terms: termsFound, dropped: result.dropped, ...(result.unparsed ? { unparsed: true } : {}) };
}
