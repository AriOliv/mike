// The contract analysis a request unlocks, and the alert it may raise.
//
// When the intake checklist closes and the card has a contract, the
// analyst's analysis (contract-review) runs with the checklist's answers.
// It runs for the team: the requester has no access to the card, so the
// start is a job that acts as the team's owner. The team may also ask for it
// from the panel; a checklist with open items answers with what is missing.
//
// When the analysis is done, contract-review queues request.analysis_ready
// with the counts. A critical risk alerts the Head inside the app, once per
// request: the request is marked, the card's activity says so, and the home
// screen and the Pedidos badge list it while the request is open. Nothing
// leaves the app.

import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { getOrgRole } from "../../lib/access";
import {
    getLatestAnalysis,
    startAnalystAnalysis,
    type ContractAnalysis,
} from "../contract-review/contractReview.service";
import { recordCardEvent } from "../contracts/contracts.service";
import {
    isTeam,
    loadLegalTeam,
    loadRequestFor,
    NO_LEGAL_TEAM,
    REQUEST_COLUMNS,
    TEAM_ONLY,
    type Caller,
    type RequestRow,
} from "./requests.access";
import { ANALYSIS_START_JOB, loadTemplate } from "./requests.checklist";
import { intakeForAnalysis, intakeStatus, readAnswers } from "./requests.intake";
import { requestCode } from "./requests.shared";
import { teamOwner } from "./requests.triage";

export const ANALYSIS_START_JOB_KIND = ANALYSIS_START_JOB;

export const ALERT_AGENT_NAME = "Agente analista";

/** The checklist flattened for the analysis, or the keys still open. */
async function analysisInput(
    db: Db,
    row: RequestRow,
): Promise<{ ok: true; intake: ReturnType<typeof intakeForAnalysis> } | { ok: false; pending: string[] }> {
    const template = await loadTemplate(db, row.org_id);
    const answers = readAnswers(row.intake);
    const status = intakeStatus(template.items, answers);
    if (!status.complete) {
        const labels = new Map(template.items.map((i) => [i.key, i.label]));
        return { ok: false, pending: status.pending.map((k) => labels.get(k) ?? k) };
    }
    return { ok: true, intake: intakeForAnalysis(template.items, answers) };
}

/** request.analysis_start: start the analyst's analysis as the team's owner. */
export async function handleRequestAnalysisStart(
    db: Db,
    job: { payload: Record<string, unknown> },
): Promise<Record<string, unknown>> {
    const requestId = String(job.payload.request_id ?? "");
    const { data, error } = await db.from("legal_requests").select(REQUEST_COLUMNS).eq("id", requestId).maybeSingle();
    if (error) throw error;
    const row = data as unknown as RequestRow | null;
    if (!row || !row.project_id) return { skipped: "missing" };
    if (row.status === "entregue" || row.status === "cancelado") return { skipped: "closed" };
    const input = await analysisInput(db, row);
    if (!input.ok) return { skipped: "intake_open" };
    const owner = await teamOwner(db, row.org_id);
    if (!owner) return { skipped: "no_owner" };
    const started = await startAnalystAnalysis(
        db,
        { userId: owner.user_id, userEmail: owner.email },
        row.project_id,
        { request_id: row.id, intake: input.intake },
    );
    if (!started.ok) {
        // No contract on the card yet: the team starts it once one arrives.
        if (started.kind === "validation") return { skipped: started.code ?? "invalid" };
        if (started.kind === "error") throw started.error;
        return { skipped: started.kind };
    }
    return started.data;
}

/**
 * The team asks for the analysis from the panel. A checklist with open items
 * answers 409 with what is missing, in the checklist's own words.
 */
export async function requestAnalysis(
    db: Db,
    caller: Caller,
    requestId: string,
): Promise<ServiceResult<{ analysis_id: string; queued: boolean }>> {
    const loaded = await loadRequestFor(db, caller, requestId);
    if (!loaded.ok) return loaded;
    if (!isTeam(loaded.audience)) return TEAM_ONLY;
    const row = loaded.row;
    if (!row.project_id) return failure("conflict", "Este pedido não tem card na esteira.");
    let input;
    try {
        input = await analysisInput(db, row);
    } catch (error) {
        return internalFailure(error);
    }
    if (!input.ok) {
        return failure("conflict", `Falta completar o checklist: ${input.pending.join("; ")}.`, "intake_incomplete");
    }
    return startAnalystAnalysis(db, caller, row.project_id, { request_id: row.id, intake: input.intake });
}

/** The request's latest analysis, for the team (the requester never sees the draft). */
export async function getRequestAnalysis(
    db: Db,
    caller: Caller,
    requestId: string,
): Promise<ServiceResult<ContractAnalysis | null>> {
    const loaded = await loadRequestFor(db, caller, requestId);
    if (!loaded.ok) return loaded;
    if (!isTeam(loaded.audience)) return TEAM_ONLY;
    if (!loaded.row.project_id) return ok(null);
    return getLatestAnalysis(db, caller, loaded.row.project_id);
}

/**
 * request.analysis_ready (queued by contract-review with the counts): a
 * critical risk alerts the Head once per request. Marks the request, logs it
 * on the card's activity; the home screen and the badge read the mark.
 */
export async function handleAnalysisReady(
    db: Db,
    job: { payload: Record<string, unknown> },
): Promise<Record<string, unknown>> {
    const requestId = String(job.payload.request_id ?? "");
    const critical = Number(job.payload.critical ?? 0);
    const attention = Number(job.payload.attention ?? 0);
    const analysisId = String(job.payload.analysis_id ?? "");
    if (!(critical > 0)) return { alerted: false, reason: "no_critical" };

    const now = new Date().toISOString();
    // Mark once, atomically: a second ready job for the same request finds
    // the mark set and changes nothing.
    const { data, error } = await db
        .from("legal_requests")
        .update({ critical_alert_at: now })
        .eq("id", requestId)
        .is("critical_alert_at", null)
        .select("id, number, org_id, project_id, title")
        .maybeSingle();
    if (error) throw error;
    const row = data as { id: string; number: number; org_id: string; project_id: string | null; title: string } | null;
    if (!row) return { alerted: false, reason: "already_alerted" };
    if (row.project_id) {
        await recordCardEvent(db, {
            projectId: row.project_id,
            orgId: row.org_id,
            actorType: "agent",
            actorId: "agent:analista@1",
            actorName: ALERT_AGENT_NAME,
            action: "request.critical_alert",
            after: { code: requestCode(row.number), analysis_id: analysisId, critical, attention },
            source: "agent",
        });
    }
    return { alerted: true, critical };
}

export type CriticalAlert = {
    request_id: string;
    code: string;
    title: string;
    project_id: string | null;
    alerted_at: string;
    critical: number;
    assignee_name: string | null;
};

/**
 * Open critical alerts, for the Head: requests whose analysis found a
 * critical risk and are still open, newest first. The home screen shows
 * them; the Pedidos badge counts them.
 */
export async function listCriticalAlerts(db: Db, caller: Caller): Promise<ServiceResult<{ alerts: CriticalAlert[] }>> {
    let team;
    try {
        team = await loadLegalTeam(db);
    } catch (error) {
        return internalFailure(error);
    }
    if (!team) return NO_LEGAL_TEAM;
    const role = await getOrgRole(caller.userId, team.org_id, db);
    if (role !== "owner" && role !== "admin") return ok({ alerts: [] });
    const { data, error } = await db
        .from("legal_requests")
        .select("id, number, title, project_id, critical_alert_at, assignee_id, status")
        .eq("org_id", team.org_id)
        .not("critical_alert_at", "is", null)
        .in("status", ["novo", "em_triagem", "em_andamento", "aguardando_solicitante"])
        .order("critical_alert_at", { ascending: false })
        .limit(20);
    if (error) return internalFailure(error);
    const rows = (data ?? []) as {
        id: string;
        number: number;
        title: string;
        project_id: string | null;
        critical_alert_at: string;
        assignee_id: string | null;
    }[];
    const projectIds = rows.map((r) => r.project_id).filter((p): p is string => !!p);
    const assigneeIds = [...new Set(rows.map((r) => r.assignee_id).filter((a): a is string => !!a))];
    const [events, profiles] = await Promise.all([
        projectIds.length
            ? db
                  .from("card_events")
                  .select("project_id, after")
                  .eq("action", "request.critical_alert")
                  .in("project_id", projectIds)
            : Promise.resolve({ data: [] as unknown[] }),
        assigneeIds.length
            ? db.from("user_profiles").select("user_id, display_name, email").in("user_id", assigneeIds)
            : Promise.resolve({ data: [] as unknown[] }),
    ]);
    const criticalOf = new Map<string, number>();
    for (const e of (events.data ?? []) as { project_id: string; after: { critical?: number } | null }[]) {
        criticalOf.set(e.project_id, Number(e.after?.critical ?? 0));
    }
    const nameOf = new Map<string, string>();
    for (const p of (profiles.data ?? []) as { user_id: string; display_name: string | null; email: string | null }[]) {
        nameOf.set(p.user_id, p.display_name?.trim() || p.email?.split("@")[0] || "Legal");
    }
    return ok({
        alerts: rows.map((r) => ({
            request_id: r.id,
            code: requestCode(r.number),
            title: r.title,
            project_id: r.project_id,
            alerted_at: r.critical_alert_at,
            critical: r.project_id ? (criticalOf.get(r.project_id) ?? 0) : 0,
            assignee_name: r.assignee_id ? (nameOf.get(r.assignee_id) ?? null) : null,
        })),
    });
}
