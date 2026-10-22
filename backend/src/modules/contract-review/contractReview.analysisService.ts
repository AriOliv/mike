// The analyst's analysis as a service: start one (idempotent per document
// version), the job that writes it, and reading it back. The pure parts — the
// prompt, the verifier, the playbook yardstick — are in contractReview.analysis.ts.
//
// The analysis is a draft for the legal team: only people who can edit the
// contract read it, and the requester of a legal request never does. When it
// finishes it is announced on the card (card_events "analysis.completed") and,
// for a request, a "request.analysis_ready" job carries the counts to the
// requests module, which decides whether to alert; this module never imports
// requests.

import { createHash } from "node:crypto";
import type { Db } from "../../lib/supabase";
import type { DbJob } from "../../lib/dbq/types";
import { enqueueDbJob } from "../../lib/dbq/enqueue";
import { NonRetryableJobError } from "../../lib/dbq/runner";
import { completeText, type TokenUsage } from "../../lib/llm";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { getUserModelSettings } from "../user/user.service";
import { finishAgentRun, recordCardEvent, startAgentRun } from "../contracts/contracts.service";
import { findPlaybookForContractType, startPlaybookReview } from "../playbooks/playbooks.service";
import { contractText } from "./contractReview.fichaService";
import { contractDocument, parseModelJson, requireContractEdit, type Caller } from "./contractReview.shared";
import {
    analysisCounts,
    analysisPrompt,
    ANALYSIS_PROMPT_VERSION,
    estimateUsage,
    normalizeAnalysis,
    withMissingIntake,
    type AnalysisResult,
    type DroppedCitation,
    type IntakeAnswer,
    type RuleFinding,
} from "./contractReview.analysis";

export const ANALYST_ANALYSIS_JOB = "contract.analyst_analysis";
/** The requests module's handler; named here only as a string, so no import. */
export const ANALYSIS_READY_JOB = "request.analysis_ready";
export const ANALYST = { id: "agent:analista@1", name: "Agente analista", agent: "analista", version: "1" };
/** The default when the organization set none: the playbook-sized review needs it (Haiku left rules out). */
export const DEFAULT_ANALYSIS_MODEL = "claude-sonnet-5-5";

export type AnalysisStatus = "queued" | "running" | "done" | "failed";
export type ContractAnalysis = {
    id: string;
    project_id: string;
    request_id: string | null;
    document_id: string | null;
    version_id: string | null;
    playbook_id: string | null;
    playbook_run_id: string | null;
    intake: IntakeAnswer[];
    model: string | null;
    status: AnalysisStatus;
    result: AnalysisResult | null;
    dropped_citations: DroppedCitation[];
    usage: ReturnType<typeof estimateUsage> | null;
    error: string | null;
    created_at: string;
    finished_at: string | null;
};

const COLUMNS =
    "id, org_id, project_id, request_id, document_id, version_id, playbook_id, playbook_run_id, intake, model, status, result, dropped_citations, usage, error, requested_by, created_at, finished_at";
type Row = ContractAnalysis & { org_id: string | null; requested_by: string | null };

function publicView(row: Row): ContractAnalysis {
    const { org_id: _org, requested_by: _by, ...view } = row;
    return { ...view, intake: view.intake ?? [], dropped_citations: view.dropped_citations ?? [] };
}

/** The intake answers in the flat form the analysis reads: label and readable value. */
export function cleanIntake(value: unknown): IntakeAnswer[] | null {
    if (value == null) return [];
    if (!Array.isArray(value)) return null;
    const out: IntakeAnswer[] = [];
    for (const entry of value.slice(0, 60)) {
        if (!entry || typeof entry !== "object") return null;
        const item = entry as Record<string, unknown>;
        const key = typeof item.key === "string" ? item.key.trim().slice(0, 100) : "";
        const label = typeof item.label === "string" ? item.label.trim().slice(0, 300) : "";
        const answer = typeof item.value === "string" ? item.value.trim().slice(0, 2_000) : "";
        if (!key || !label) return null;
        if (!answer) continue;
        out.push({ key, label, value: answer, source: typeof item.source === "string" ? item.source.slice(0, 40) : null });
    }
    return out;
}

/**
 * Queue an analysis of the contract's current document. Asking again for the
 * same version returns the analysis already queued, running or done; a failed
 * one is queued again.
 */
export async function startAnalystAnalysis(
    db: Db,
    caller: Caller,
    projectId: string,
    input: { request_id?: string | null; intake?: unknown },
): Promise<ServiceResult<{ analysis_id: string; queued: boolean }>> {
    const allowed = await requireContractEdit(db, caller, projectId);
    if (!allowed.ok) return allowed;
    const intake = cleanIntake(input.intake);
    if (!intake) return failure("validation", "O checklist de intake veio num formato inválido.", "invalid_intake");
    const requestId =
        typeof input.request_id === "string" && /^[0-9a-f-]{36}$/i.test(input.request_id) ? input.request_id : null;
    try {
        const doc = await contractDocument(db, projectId);
        if (!doc) return failure("validation", "Envie o contrato antes de pedir a análise.", "no_document");
        const { data: existing, error } = await db
            .from("contract_analyses")
            .select("id, status")
            .eq("version_id", doc.versionId)
            .maybeSingle();
        if (error) return internalFailure(error);
        const current = existing as { id: string; status: AnalysisStatus } | null;
        if (current && current.status !== "failed") return ok({ analysis_id: current.id, queued: false });

        const row = {
            org_id: allowed.access.project?.org_id ?? null,
            project_id: projectId,
            request_id: requestId,
            document_id: doc.documentId,
            version_id: doc.versionId,
            intake,
            status: "queued" as const,
            error: null,
            result: null,
            dropped_citations: [],
            requested_by: caller.userId,
            updated_at: new Date().toISOString(),
        };
        const saved = current
            ? await db.from("contract_analyses").update(row).eq("id", current.id).select("id").single()
            : await db.from("contract_analyses").insert(row).select("id").single();
        if (saved.error) return internalFailure(saved.error);
        const analysisId = (saved.data as { id: string }).id;
        await enqueueDbJob(db, {
            kind: ANALYST_ANALYSIS_JOB,
            payload: { analysisId },
            dedupeKey: `${ANALYST_ANALYSIS_JOB}:${analysisId}:${current ? "retry" : "first"}`,
            maxAttempts: 2,
        });
        return ok({ analysis_id: analysisId, queued: true });
    } catch (error) {
        return internalFailure(error);
    }
}

async function loadRow(db: Db, id: string): Promise<Row | null> {
    const { data, error } = await db.from("contract_analyses").select(COLUMNS).eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as Row | null) ?? null;
}

async function setRow(db: Db, id: string, patch: Record<string, unknown>) {
    const { error } = await db
        .from("contract_analyses")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", id);
    if (error) throw error;
}

/** The organization's playbook for the contract's type, run over the text; null without one. */
async function playbookYardstick(
    db: Db,
    row: Row,
    caller: Caller,
    model: string,
    documentText: string,
    documentName: string,
): Promise<{ id: string; name: string; runId: string; findings: RuleFinding[] } | null> {
    if (!row.org_id) return null;
    const { data, error } = await db.from("projects").select("contract_type").eq("id", row.project_id).maybeSingle();
    if (error) throw error;
    const contractType = (data as { contract_type: string | null } | null)?.contract_type ?? null;
    const playbook = await findPlaybookForContractType(db, { userId: caller.userId, orgId: row.org_id, contractType });
    if (!playbook) return null;
    // Without a documentId the run writes no tracked changes: a redline reaches
    // the document only when a person accepts it.
    const { run, done } = await startPlaybookReview({
        db,
        userId: caller.userId,
        playbookId: playbook.id,
        documentText,
        documentName,
        model,
        reviewMode: "strict",
        reviewScope: "full",
        instructions: "Responda em português do Brasil. Direito brasileiro. A parte representada é a Avenia.",
    });
    const result = await done;
    return { id: playbook.id, name: playbook.name, runId: run.id, findings: result.findings as RuleFinding[] };
}

/** The job: read the contract, weigh it against the playbook when there is one, write the analysis. */
export async function handleAnalystAnalysis(db: Db, job: DbJob): Promise<Record<string, unknown>> {
    const analysisId = String(job.payload.analysisId ?? "");
    const row = await loadRow(db, analysisId);
    if (!row) throw new NonRetryableJobError("analysis_not_found");
    if (row.status === "done") return { skipped: true };
    if (!row.requested_by) throw new NonRetryableJobError("analysis_has_no_requester");
    const caller: Caller = { userId: row.requested_by };

    const started = Date.now();
    const runId = await startAgentRun(db, {
        projectId: row.project_id,
        orgId: row.org_id,
        agent: ANALYST.agent,
        agentVersion: ANALYST.version,
        jobId: job.id,
        inputDocSha: createHash("sha256").update(row.version_id ?? row.id).digest("hex").slice(0, 16),
    });
    await setRow(db, row.id, { status: "running", error: null });
    try {
        const settings = await getUserModelSettings(caller.userId, db, { orgId: row.org_id });
        const model = settings.tabular_model ?? DEFAULT_ANALYSIS_MODEL;
        const doc = await contractDocument(db, row.project_id);
        if (!doc) throw new NonRetryableJobError("no_document");
        const documentText = await contractText(doc);
        if (!documentText.trim()) throw new NonRetryableJobError("unreadable_document");

        const yardstick = await playbookYardstick(db, row, caller, model, documentText, doc.filename);
        const prompt = analysisPrompt({
            documentText,
            documentName: doc.filename,
            intake: row.intake ?? [],
            playbook: yardstick ? { name: yardstick.name, findings: yardstick.findings } : null,
        });
        let reported: TokenUsage | null = null;
        const raw = await completeText({
            model,
            systemPrompt: "Você é um analista jurídico brasileiro revisando um contrato para o time jurídico da Avenia. Responda apenas com JSON válido.",
            user: prompt,
            maxTokens: 16_000,
            apiKeys: settings.api_keys,
            onUsage: (usage) => {
                reported = usage;
            },
        });
        const { result, dropped } = normalizeAnalysis(parseModelJson(raw), documentText, yardstick?.findings ?? []);
        const final = withMissingIntake(result, row.intake ?? []);
        if (dropped.length)
            // Counts only: the quotes are contract text.
            console.warn(`[analysis] ${row.id}: ${dropped.length} citation(s) not found in the document were dropped`);
        const usage = estimateUsage(model, [{ input: prompt.length, output: raw.length, reported }]);
        const counts = analysisCounts(final);
        const finished = new Date().toISOString();
        await setRow(db, row.id, {
            status: "done",
            model,
            result: final,
            dropped_citations: dropped,
            usage: { ...usage, prompt_version: ANALYSIS_PROMPT_VERSION, playbook_review: yardstick ? "separate run" : null },
            playbook_id: yardstick?.id ?? null,
            playbook_run_id: yardstick?.runId ?? null,
            finished_at: finished,
        });
        await finishAgentRun(db, runId, {
            status: "succeeded",
            output: { analysis_id: row.id, ...counts, dropped: dropped.length },
            modelResolved: model,
            latencyMs: Date.now() - started,
            tokensIn: usage.input_tokens,
            tokensOut: usage.output_tokens,
            costUsd: usage.estimated_cost_usd,
        });
        await recordCardEvent(db, {
            projectId: row.project_id,
            orgId: row.org_id,
            actorType: "agent",
            actorId: ANALYST.id,
            actorName: ANALYST.name,
            onBehalfOf: caller.userId,
            action: "analysis.completed",
            runId,
            after: { analysis_id: row.id, request_id: row.request_id, ...counts },
        });
        if (row.request_id)
            await enqueueDbJob(db, {
                kind: ANALYSIS_READY_JOB,
                payload: { analysis_id: row.id, project_id: row.project_id, request_id: row.request_id, ...counts },
                dedupeKey: `analysis-ready:${row.id}`,
            });
        return { analysisId: row.id, ...counts, dropped: dropped.length };
    } catch (error) {
        const permanent = error instanceof NonRetryableJobError;
        const lastAttempt = permanent || job.attempts >= job.max_attempts;
        await finishAgentRun(db, runId, { status: "failed", error: permanent ? error.message : "error", latencyMs: Date.now() - started });
        await setRow(db, row.id, {
            status: lastAttempt ? "failed" : "queued",
            error: lastAttempt ? analysisFailureText(error) : null,
        });
        if (lastAttempt)
            await recordCardEvent(db, {
                projectId: row.project_id,
                orgId: row.org_id,
                actorType: "agent",
                actorId: ANALYST.id,
                actorName: ANALYST.name,
                action: "analysis.failed",
                runId,
                after: { analysis_id: row.id, request_id: row.request_id },
            });
        throw error;
    }
}

function analysisFailureText(error: unknown): string {
    const code = error instanceof NonRetryableJobError ? error.message : "";
    if (code === "no_document") return "O contrato não tem documento para analisar.";
    if (code === "unreadable_document") return "Não consegui ler o texto do contrato.";
    return "A análise falhou. Tente de novo.";
}

/** Failure hook: the runner gave up, so the row must not stay "running". */
export async function markAnalystAnalysisFailed(db: Db, job: DbJob): Promise<void> {
    const analysisId = String(job.payload.analysisId ?? "");
    if (!analysisId) return;
    await db
        .from("contract_analyses")
        .update({ status: "failed", error: "A análise falhou. Tente de novo.", updated_at: new Date().toISOString() })
        .eq("id", analysisId)
        .in("status", ["queued", "running"]);
}

/** The contract's latest analysis, for the legal team; null when there is none. */
export async function getLatestAnalysis(
    db: Db,
    caller: Caller,
    projectId: string,
): Promise<ServiceResult<ContractAnalysis | null>> {
    const allowed = await requireContractEdit(db, caller, projectId);
    if (!allowed.ok) return allowed;
    const { data, error } = await db
        .from("contract_analyses")
        .select(COLUMNS)
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(1);
    if (error) return internalFailure(error);
    const row = ((data ?? []) as Row[])[0];
    return ok(row ? publicView(row) : null);
}

/** One analysis by id, for the legal team of its contract. */
export async function getAnalysisById(
    db: Db,
    caller: Caller,
    analysisId: string,
): Promise<ServiceResult<ContractAnalysis>> {
    if (!/^[0-9a-f-]{36}$/i.test(analysisId)) return failure("not_found", "Análise não encontrada.");
    try {
        const row = await loadRow(db, analysisId);
        if (!row) return failure("not_found", "Análise não encontrada.");
        const allowed = await requireContractEdit(db, caller, row.project_id);
        if (!allowed.ok) return failure("not_found", "Análise não encontrada.");
        return ok(publicView(row));
    } catch (error) {
        return internalFailure(error);
    }
}
