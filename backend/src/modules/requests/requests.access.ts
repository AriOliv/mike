// Who sees a request, and as what.
//
// Three audiences, decided here and nowhere else:
//   team       a member of the legal team's organization — the whole queue;
//   requester  whoever asked — their own requests, through the narrow view;
//   guest      an invited participant (an outside firm, a colleague) — that
//              one request, until the invitation expires or is revoked.
// The requester and the guest never receive access to the card's project, so
// the team's portfolio, drafts and internal activity stay inside the team.

import type { Db } from "../../lib/supabase";
import { getOrgRole, normalizeEmail, type OrgRole } from "../../lib/access";
import { failure, type ServiceFailure } from "../../lib/serviceResult";

export type Caller = { userId: string; userEmail?: string | null };

export type Audience =
    | { kind: "team"; orgRole: OrgRole }
    | { kind: "requester" }
    | { kind: "guest"; role: "external" | "viewer" };

export type LegalTeam = { org_id: string; sla_days: Record<string, unknown> };

/**
 * The legal team. A deployment has one; LEGAL_TEAM_ORG_ID pins it when
 * there could be ambiguity, otherwise the single registered team is used.
 */
export async function loadLegalTeam(db: Db): Promise<LegalTeam | null> {
    const pinned = process.env.LEGAL_TEAM_ORG_ID?.trim();
    let query = db.from("legal_teams").select("org_id, sla_days");
    if (pinned) query = query.eq("org_id", pinned);
    const { data, error } = await query.order("created_at", { ascending: true }).limit(1);
    if (error) throw error;
    const row = (data ?? [])[0] as LegalTeam | undefined;
    return row ? { org_id: row.org_id, sla_days: row.sla_days ?? {} } : null;
}

export const NO_LEGAL_TEAM = failure(
    "unavailable",
    "O time do Legal ainda não foi configurado.",
    "legal_team_missing",
);

/** The caller's role in the legal team's organization, or null for everyone else. */
export async function teamRole(db: Db, caller: Caller, orgId: string): Promise<OrgRole | null> {
    return getOrgRole(caller.userId, orgId, db);
}

export type RequestRow = {
    id: string;
    number: number;
    org_id: string;
    project_id: string | null;
    requester_id: string | null;
    requester_email: string;
    requester_name: string | null;
    requester_area: string | null;
    requester_area_source: string | null;
    kind: string;
    title: string;
    counterparty: string | null;
    context: string;
    urgency: string;
    needed_by: string | null;
    due_at: string;
    status: string;
    paused_at: string | null;
    paused_seconds: number;
    assignee_id: string | null;
    assigned_at: string | null;
    /** How the owner was set: a rule, the triage agent's suggestion, or a person. */
    assigned_by: string | null;
    summary: string | null;
    triage: Record<string, unknown> | null;
    delivery: Record<string, unknown> | null;
    delivered_at: string | null;
    source: Record<string, unknown>;
    intake: Record<string, unknown>;
    intake_completed_at: string | null;
    critical_alert_at: string | null;
    counterparty_email: string | null;
    term_start: string | null;
    term_months: number | null;
    created_at: string;
    updated_at: string;
};

export const REQUEST_COLUMNS =
    "id, number, org_id, project_id, requester_id, requester_email, requester_name, requester_area, " +
    "requester_area_source, kind, title, " +
    "counterparty, context, urgency, needed_by, due_at, status, paused_at, paused_seconds, " +
    "assignee_id, assigned_at, assigned_by, summary, triage, delivery, delivered_at, source, intake, intake_completed_at, " +
    "critical_alert_at, counterparty_email, term_start, term_months, created_at, updated_at";

const NOT_FOUND = failure("not_found", "Pedido não encontrado.");

/**
 * Load one request and decide the caller's audience. A request the caller
 * may not see answers exactly like one that does not exist.
 */
export async function loadRequestFor(
    db: Db,
    caller: Caller,
    requestId: string,
): Promise<{ ok: true; row: RequestRow; audience: Audience } | ServiceFailure> {
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) return NOT_FOUND;
    const { data, error } = await db
        .from("legal_requests")
        .select(REQUEST_COLUMNS)
        .eq("id", requestId)
        .maybeSingle();
    if (error) return { ok: false, kind: "error", error };
    const row = data as unknown as RequestRow | null;
    if (!row) return NOT_FOUND;

    const orgRole = await teamRole(db, caller, row.org_id);
    if (orgRole) return { ok: true, row, audience: { kind: "team", orgRole } };

    const email = normalizeEmail(caller.userEmail);
    if (row.requester_id === caller.userId || (email && email === row.requester_email)) {
        return { ok: true, row, audience: { kind: "requester" } };
    }
    if (email) {
        const { data: guest, error: guestError } = await db
            .from("legal_request_participants")
            .select("role, expires_at, revoked_at")
            .eq("request_id", row.id)
            .eq("email", email)
            .maybeSingle();
        if (guestError) return { ok: false, kind: "error", error: guestError };
        const g = guest as { role: "external" | "viewer"; expires_at: string; revoked_at: string | null } | null;
        if (g && !g.revoked_at && new Date(g.expires_at).getTime() > Date.now()) {
            return { ok: true, row, audience: { kind: "guest", role: g.role } };
        }
    }
    return NOT_FOUND;
}

export function isTeam(audience: Audience): audience is { kind: "team"; orgRole: OrgRole } {
    return audience.kind === "team";
}

/** Only the team's owners and admins (the Head) decide triage and invite outsiders. */
export function isHead(audience: Audience): boolean {
    return audience.kind === "team" && (audience.orgRole === "owner" || audience.orgRole === "admin");
}

export const TEAM_ONLY = failure("forbidden", "Só o time do Legal pode fazer isso.");
export const HEAD_ONLY = failure("forbidden", "Só a liderança do Legal pode fazer isso.");
