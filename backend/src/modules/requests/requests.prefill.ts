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

export const PREFILL_JOB_KIND = "request.intake_prefill";
export const PREFILL_AGENT = "intake";
export const PREFILL_AGENT_VERSION = "1";
export const PREFILL_AGENT_NAME = "Agente de intake";

/** Contract text sent to the model: the head of a long contract carries the parties, object and price. */
const MAX_TEXT = 60_000;

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
- Para cada resposta, copie em "quote" o trecho LITERAL do contrato de onde ela saiu (até 300 caracteres), sem alterar uma palavra.
- Perguntas de sim/não: "choice" é "sim" ou "nao", e "value" é a resposta curta com o detalhe ("Sim. As duas partes trocam informações sobre clientes.").
- Português do Brasil, objetivo. Valores e datas como estão no contrato.
- Responda apenas com JSON válido, sem cercas de código: {"answers": {"<chave>": {"value": "...", "quote": "...", "choice": "sim"|"nao"|null}}}.`;
}

/** Normalizes spacing and quotes so a quote matches the text it came from. */
function squash(s: string): string {
    return s
        .normalize("NFKC")
        .replace(/[“”«»]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

/**
 * The model's answers, kept only for questions of the checklist and only
 * with a quote that is really in the contract.
 */
export function parsePrefill(raw: string, items: IntakeItem[], contractText: string): { inferred: Inferred; dropped: number } {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    let parsed: { answers?: Record<string, unknown> };
    try {
        parsed = JSON.parse(start !== -1 && end > start ? cleaned.slice(start, end + 1) : cleaned);
    } catch {
        return { inferred: {}, dropped: 0 };
    }
    const haystack = squash(contractText);
    const keys = new Set(items.map((i) => i.key));
    const inferred: Inferred = {};
    let dropped = 0;
    for (const [key, raw] of Object.entries(parsed.answers ?? {})) {
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
    return { inferred, dropped };
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
    if (open.length === 0) return { skipped: "answered" };

    const doc = await latestDocument(db, row.project_id);
    if (!doc) return { skipped: "no_document" };
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

    const selected = await triageModel(db, row.org_id);
    if (!selected) return { skipped: "no_model" };

    const runId = await startAgentRun(db, {
        projectId: row.project_id,
        orgId: row.org_id,
        agent: PREFILL_AGENT,
        agentVersion: PREFILL_AGENT_VERSION,
        jobId: job.id ?? null,
    });
    const started = Date.now();
    let result: { inferred: Inferred; dropped: number } = { inferred: {}, dropped: 0 };
    try {
        const raw = await completeText({
            model: selected.model,
            systemPrompt: systemPrompt(open),
            user: `Contrato:\n${text.text.slice(0, MAX_TEXT)}`,
            maxTokens: 1500,
            apiKeys: selected.apiKeys,
        });
        result = parsePrefill(raw, open, text.text);
    } catch (err) {
        console.error("[requests] intake prefill model failed", { requestId, error: safeError(err) });
        await finishAgentRun(db, runId, { status: "failed", error: "model_failed", modelResolved: selected.model, latencyMs: Date.now() - started });
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
    await finishAgentRun(db, runId, {
        status: "succeeded",
        modelResolved: selected.model,
        latencyMs: Date.now() - started,
        output: { filled: merged.filled, dropped: result.dropped },
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
    return { filled: merged.filled.length, dropped: result.dropped };
}
