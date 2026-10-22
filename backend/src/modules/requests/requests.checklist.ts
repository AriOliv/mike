// The intake checklist on a request, for the screens and the MCP tools:
// read where it stands, answer or confirm items (the requester, or the team
// on their behalf), and the organization's own checklist (the Head edits it).
//
// When the last required item is confirmed the checklist closes: the request
// records when, and the card's activity says so. What happens next (the
// contract analysis) hangs off that moment.

import type { Db } from "../../lib/supabase";
import { enqueueDbJob } from "../../lib/dbq/enqueue";
import { safeError } from "../../lib/safeError";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { getOrgRole } from "../../lib/access";
import { recordCardEvent } from "../contracts/contracts.service";
import {
    isTeam,
    loadLegalTeam,
    loadRequestFor,
    NO_LEGAL_TEAM,
    type Caller,
    type RequestRow,
} from "./requests.access";
import {
    applyAnswers,
    effectiveTemplate,
    intakeStatus,
    parseIntakeTemplate,
    readAnswers,
    type IntakeItem,
    type IntakeStatus,
} from "./requests.intake";
import { PREFILL_JOB_KIND } from "./requests.prefill";
import { applyAssignmentRules } from "./requests.rules";

/**
 * The job kind requests.analysis.ts handles. Named here, not imported, so the
 * checklist does not pull contract-review in for a string.
 */
export const ANALYSIS_START_JOB = "request.analysis_start";

async function enqueueAnalysis(db: Db, requestId: string): Promise<void> {
    try {
        await enqueueDbJob(db, {
            kind: ANALYSIS_START_JOB,
            payload: { request_id: requestId },
            dedupeKey: `analysis-start:${requestId}`,
            maxAttempts: 3,
        });
    } catch (error) {
        console.error("[requests] analysis enqueue failed", { requestId, error: safeError(error) });
    }
}

/**
 * Where the intake agent stands on this request: reading the contract,
 * done, or unable to (no model, unreadable text). Null when it never ran
 * or had nothing to do (no contract, nothing left to answer).
 */
export type PrefillState = "lendo" | "concluido" | "falhou" | null;

export type RequestIntake = IntakeStatus & {
    request_id: string;
    completed_at: string | null;
    prefill: PrefillState;
    /** The requester or the team may answer; a viewer or a stranger may not. */
    can_answer: boolean;
    /** The organization's own checklist, or the generic one. */
    template_source: "org" | "padrao";
};

export async function loadTemplate(db: Db, orgId: string): Promise<{ items: IntakeItem[]; source: "org" | "padrao" }> {
    const { data, error } = await db.from("legal_teams").select("intake_template").eq("org_id", orgId).maybeSingle();
    if (error) throw error;
    const stored = (data as { intake_template?: unknown } | null)?.intake_template;
    const own = parseIntakeTemplate(stored);
    return own.ok && own.items.length ? { items: own.items, source: "org" } : { items: effectiveTemplate(null), source: "padrao" };
}

/** Skips that mean the agent could not do its job, as opposed to having none. */
const PREFILL_UNABLE = new Set(["no_model", "no_owner"]);

/** The agent's state, from its newest job for this request. */
export async function prefillState(db: Db, requestId: string): Promise<PrefillState> {
    const { data, error } = await db
        .from("db_jobs")
        .select("status, result, created_at")
        .eq("dedupe_key", `intake-prefill:${requestId}`)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error || !data) return null;
    const job = data as { status: string; result: { skipped?: unknown } | null };
    if (job.status === "pending" || job.status === "running") return "lendo";
    if (job.status === "failed") return "falhou";
    const skipped = job.result?.skipped;
    if (typeof skipped === "string") return PREFILL_UNABLE.has(skipped) ? "falhou" : null;
    return "concluido";
}

function view(
    row: RequestRow,
    template: { items: IntakeItem[]; source: "org" | "padrao" },
    canAnswer: boolean,
    prefill: PrefillState,
): RequestIntake {
    return {
        ...intakeStatus(template.items, readAnswers(row.intake)),
        request_id: row.id,
        completed_at: row.intake_completed_at,
        prefill,
        can_answer: canAnswer,
        template_source: template.source,
    };
}

function mayAnswer(row: RequestRow, audience: Awaited<ReturnType<typeof loadRequestFor>>): boolean {
    if (!audience.ok) return false;
    if (row.status === "entregue" || row.status === "cancelado") return false;
    return audience.audience.kind === "requester" || isTeam(audience.audience);
}

/** The request's checklist: each item, its answer and state, and what is still open. */
export async function getIntake(db: Db, caller: Caller, requestId: string): Promise<ServiceResult<RequestIntake>> {
    const loaded = await loadRequestFor(db, caller, requestId);
    if (!loaded.ok) return loaded;
    if (loaded.audience.kind === "guest") return failure("forbidden", "O checklist do pedido é de quem pediu e do time do Legal.");
    try {
        const template = await loadTemplate(db, loaded.row.org_id);
        return ok(view(loaded.row, template, mayAnswer(loaded.row, loaded), await prefillState(db, loaded.row.id)));
    } catch (error) {
        return internalFailure(error);
    }
}

/**
 * Answer items (`answers: {key: value | {value, detail}}`) and confirm
 * inferred ones (`confirm: [key]`). Every answer given here is a person's,
 * so it counts as confirmed. Closing the checklist is logged once.
 */
export async function answerIntake(
    db: Db,
    caller: Caller,
    requestId: string,
    body: { answers?: unknown; confirm?: unknown },
): Promise<ServiceResult<RequestIntake>> {
    const loaded = await loadRequestFor(db, caller, requestId);
    if (!loaded.ok) return loaded;
    const row = loaded.row;
    if (!mayAnswer(row, loaded)) {
        if (row.status === "entregue" || row.status === "cancelado") return failure("conflict", "Este pedido já foi encerrado.");
        return failure("forbidden", "O checklist do pedido é de quem pediu e do time do Legal.");
    }
    let template;
    try {
        template = await loadTemplate(db, row.org_id);
    } catch (error) {
        return internalFailure(error);
    }
    const now = new Date().toISOString();
    const applied = applyAnswers(template.items, readAnswers(row.intake), body, now);
    if (!applied.ok) return failure("validation", applied.detail);
    const prefill = await prefillState(db, row.id);
    if (applied.changed.length === 0) return ok(view(row, template, true, prefill));

    const status = intakeStatus(template.items, applied.answers);
    const closing = status.complete && !row.intake_completed_at;
    const { data, error } = await db
        .from("legal_requests")
        .update({
            intake: applied.answers,
            ...(closing ? { intake_completed_at: now } : {}),
            ...(!status.complete && row.intake_completed_at ? { intake_completed_at: null } : {}),
            updated_at: now,
        })
        .eq("id", row.id)
        .select("id, intake, intake_completed_at")
        .single();
    if (error || !data) return internalFailure(error);
    const updated = { ...row, ...(data as Partial<RequestRow>) } as RequestRow;

    if (row.project_id) {
        await recordCardEvent(db, {
            projectId: row.project_id,
            orgId: row.org_id,
            actorType: "user",
            actorId: caller.userId,
            actorName: caller.userEmail ?? null,
            action: closing ? "intake.completed" : "intake.answered",
            after: { answered: status.answered, total: status.total, pending: status.pending.length },
        });
    }
    // The checklist just closed: the contract's analysis runs for the team.
    if (closing && row.project_id) await enqueueAnalysis(db, row.id);
    // The checklist may carry the contract value a rule is waiting for.
    if (closing) await applyAssignmentRules(db, updated);
    return ok(view(updated, template, true, prefill));
}

/** Queue the intake agent for a request whose card has a contract. Never fails the caller. */
export async function queueIntakePrefill(db: Db, requestId: string): Promise<void> {
    try {
        await enqueueDbJob(db, {
            kind: PREFILL_JOB_KIND,
            payload: { request_id: requestId },
            dedupeKey: `intake-prefill:${requestId}`,
            maxAttempts: 6,
        });
    } catch (error) {
        console.error("[requests] intake prefill enqueue failed", { requestId, error: safeError(error) });
    }
}

/** The organization's checklist, for whoever is on the legal team. */
export async function getIntakeTemplate(
    db: Db,
    caller: Caller,
): Promise<ServiceResult<{ items: IntakeItem[]; source: "org" | "padrao" }>> {
    let team;
    try {
        team = await loadLegalTeam(db);
    } catch (error) {
        return internalFailure(error);
    }
    if (!team) return NO_LEGAL_TEAM;
    const role = await getOrgRole(caller.userId, team.org_id, db);
    if (!role) return failure("forbidden", "Só o time do Legal pode fazer isso.");
    try {
        return ok(await loadTemplate(db, team.org_id));
    } catch (error) {
        return internalFailure(error);
    }
}

/**
 * Replace the organization's checklist (the Head only). An empty list goes
 * back to the generic one. Answers already given stay on their requests.
 */
export async function setIntakeTemplate(
    db: Db,
    caller: Caller,
    body: { items?: unknown },
): Promise<ServiceResult<{ items: IntakeItem[]; source: "org" | "padrao" }>> {
    let team;
    try {
        team = await loadLegalTeam(db);
    } catch (error) {
        return internalFailure(error);
    }
    if (!team) return NO_LEGAL_TEAM;
    const role = await getOrgRole(caller.userId, team.org_id, db);
    if (role !== "owner" && role !== "admin") return failure("forbidden", "Só a liderança do Legal pode fazer isso.");
    const parsed = parseIntakeTemplate(body.items);
    if (!parsed.ok) return failure("validation", parsed.detail);
    const { error } = await db
        .from("legal_teams")
        .update({ intake_template: parsed.items, updated_at: new Date().toISOString() })
        .eq("org_id", team.org_id);
    if (error) return internalFailure(error);
    return ok(parsed.items.length ? { items: parsed.items, source: "org" } : { items: effectiveTemplate(null), source: "padrao" });
}
