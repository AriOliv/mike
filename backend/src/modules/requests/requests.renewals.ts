// A contract's end opens its own renewal request (L-18).
//
// When a contract's term ends within `renewal_lead_days`, the legal team gets
// a request of kind "aditivo" for it, so the renewal enters the same queue,
// with the same SLA, as anything a person asks. One request per contract and
// per term: contract_renewal_requests has (project_id, term_end) as its key,
// so a sweep that runs twice, or on two replicas, never opens it twice, and a
// renewed contract (a later term_end) opens a new one.
//
// A job has no person signed in, so the request is made in the name of the
// team's first owner or admin (as the other team jobs do) and says in its
// context that the system opened it. It starts with the team's own triage,
// notices and card like any other request.

import type { Db } from "../../lib/supabase";
import { enqueueDbJob } from "../../lib/dbq/enqueue";
import { safeError } from "../../lib/safeError";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { getOrgRole } from "../../lib/access";
import { loadLegalTeam, NO_LEGAL_TEAM, teamRole, type Caller } from "./requests.access";
import { createRequest } from "./requests.core";
import { OPEN_STATUSES } from "./requests.shared";
import { teamOwner } from "./requests.triage";

export const RENEWAL_JOB_KIND = "request.renewals";
export const DEFAULT_RENEWAL_LEAD_DAYS = 60;

export type RenewalSettings = { enabled: boolean; lead_days: number };

const DENIED = failure("forbidden", "Só a liderança do Legal pode fazer isso.");

function isLeadDays(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 365;
}

/** Whether the renewal request opens by itself, and how early. Anyone on the team reads it. */
export async function getRenewalSettings(db: Db, caller: Caller): Promise<ServiceResult<RenewalSettings>> {
    try {
        const team = await loadLegalTeam(db);
        if (!team) return NO_LEGAL_TEAM;
        if (!(await teamRole(db, caller, team.org_id))) return failure("forbidden", "Só o time do Legal pode ver isso.");
        const { data, error } = await db
            .from("legal_teams")
            .select("renewal_enabled, renewal_lead_days")
            .eq("org_id", team.org_id)
            .maybeSingle();
        if (error) throw error;
        const row = data as { renewal_enabled: boolean; renewal_lead_days: number } | null;
        return ok({
            enabled: row?.renewal_enabled ?? false,
            lead_days: row?.renewal_lead_days ?? DEFAULT_RENEWAL_LEAD_DAYS,
        });
    } catch (error) {
        return internalFailure(error);
    }
}

/** The Head turns it on or off and sets the lead time. */
export async function setRenewalSettings(
    db: Db,
    caller: Caller,
    body: { enabled?: unknown; lead_days?: unknown },
): Promise<ServiceResult<RenewalSettings>> {
    let team;
    try {
        team = await loadLegalTeam(db);
    } catch (error) {
        return internalFailure(error);
    }
    if (!team) return NO_LEGAL_TEAM;
    const role = await getOrgRole(caller.userId, team.org_id, db);
    if (role !== "owner" && role !== "admin") return DENIED;

    const patch: Record<string, unknown> = {};
    if ("enabled" in body) {
        if (typeof body.enabled !== "boolean") return failure("validation", "Diga se o pedido de renovação abre sozinho ou não.");
        patch.renewal_enabled = body.enabled;
    }
    if ("lead_days" in body) {
        if (!isLeadDays(body.lead_days)) return failure("validation", "A antecedência é um número de dias entre 1 e 365.");
        patch.renewal_lead_days = body.lead_days;
    }
    if (Object.keys(patch).length === 0) return failure("validation", "Nada para mudar.");
    const { error } = await db
        .from("legal_teams")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("org_id", team.org_id);
    if (error) return internalFailure(error);
    return getRenewalSettings(db, caller);
}

/** São Paulo's calendar date, as YYYY-MM-DD, `days` days from `now`. */
function dateAhead(now: Date, days: number): string {
    const base = new Date(now.getTime() + days * 86_400_000);
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(base);
}

type DueTerm = { project_id: string; term_end: string };

/** Contracts whose term ends from today to `horizon`, that have no renewal request for that term yet. */
async function dueTerms(db: Db, today: string, horizon: string): Promise<DueTerm[]> {
    const { data, error } = await db
        .from("contract_terms")
        .select("project_id, term_end")
        .gte("term_end", today)
        .lte("term_end", horizon)
        .order("term_end", { ascending: true })
        .limit(500);
    if (error) throw error;
    const terms = (data ?? []) as DueTerm[];
    if (terms.length === 0) return [];
    const { data: done, error: doneError } = await db
        .from("contract_renewal_requests")
        .select("project_id, term_end")
        .in("project_id", terms.map((t) => t.project_id));
    if (doneError) throw doneError;
    const seen = new Set(((done ?? []) as DueTerm[]).map((d) => `${d.project_id}|${d.term_end}`));
    return terms.filter((t) => !seen.has(`${t.project_id}|${t.term_end}`));
}

function dateLabel(date: string): string {
    const [y, m, d] = date.split("-");
    return `${d}/${m}/${y}`;
}

export type RenewalSweep = { opened: number; skipped: number; failed: number };

/**
 * Opens the renewal requests due today. Off by default per team; each term is
 * claimed in contract_renewal_requests first, and the claim is released when
 * the request cannot be made, so the next sweep tries it again.
 */
export async function runRenewalSweep(db: Db, now: Date = new Date()): Promise<RenewalSweep> {
    const sweep: RenewalSweep = { opened: 0, skipped: 0, failed: 0 };
    const team = await loadLegalTeam(db);
    if (!team) return sweep;
    const { data: settings, error: settingsError } = await db
        .from("legal_teams")
        .select("renewal_enabled, renewal_lead_days")
        .eq("org_id", team.org_id)
        .maybeSingle();
    if (settingsError) throw settingsError;
    const config = settings as { renewal_enabled: boolean; renewal_lead_days: number } | null;
    if (!config?.renewal_enabled) return sweep;

    const owner = await teamOwner(db, team.org_id);
    if (!owner?.email) return sweep;
    const caller: Caller = { userId: owner.user_id, userEmail: owner.email };

    const today = dateAhead(now, 0);
    const due = await dueTerms(db, today, dateAhead(now, config.renewal_lead_days));
    for (const term of due) {
        const { data: card, error: cardError } = await db
            .from("projects")
            .select("name, counterparty, org_id")
            .eq("id", term.project_id)
            .is("archived_at", null)
            .maybeSingle();
        if (cardError) throw cardError;
        const project = card as { name: string; counterparty: string | null; org_id: string | null } | null;
        // Only the team's own contracts: a personal or other organization's card is not its queue.
        if (!project || project.org_id !== team.org_id) {
            sweep.skipped++;
            continue;
        }

        // An amendment already open for this contract is the renewal being handled: no second request.
        const { data: open, error: openError } = await db
            .from("legal_requests")
            .select("id")
            .eq("parent_project_id", term.project_id)
            .eq("kind", "aditivo")
            .in("status", OPEN_STATUSES as unknown as string[])
            .limit(1);
        if (openError) throw openError;
        if ((open ?? []).length > 0) {
            sweep.skipped++;
            continue;
        }

        const { error: claimError } = await db
            .from("contract_renewal_requests")
            .insert({ project_id: term.project_id, term_end: term.term_end });
        if (claimError) {
            // 23505: another sweep claimed it first.
            if ((claimError as { code?: string }).code === "23505") sweep.skipped++;
            else sweep.failed++;
            continue;
        }

        const created = await createRequest(db, caller, {
            kind: "aditivo",
            title: `Renovação · ${project.counterparty ?? project.name}`,
            counterparty: project.counterparty,
            context:
                `Aberto automaticamente: a vigência de "${project.name}" termina em ${dateLabel(term.term_end)}. ` +
                "Decidir se renova, renegocia ou encerra.",
            urgency: "normal",
            needed_by: term.term_end,
            requester_name: "Mike (renovação automática)",
            source: { channel: "sistema", bot: "renovacao" },
            idempotency_key: `renewal:${term.project_id}:${term.term_end}`,
        });
        if (!created.ok) {
            console.error("[renewals] request not opened", { project: term.project_id, kind: created.kind });
            await db.from("contract_renewal_requests").delete().eq("project_id", term.project_id).eq("term_end", term.term_end);
            sweep.failed++;
            continue;
        }
        await db
            .from("contract_renewal_requests")
            .update({ request_id: created.data.request.id })
            .eq("project_id", term.project_id)
            .eq("term_end", term.term_end);
        sweep.opened++;
    }
    return sweep;
}

/** The job's handler. */
export async function handleRenewalSweep(db: Db): Promise<Record<string, unknown>> {
    return { ...(await runRenewalSweep(db)) };
}

/** Queue the sweep; one live job at a time, however many sweeps or replicas ask. */
export async function enqueueRenewalSweep(db: Db): Promise<void> {
    try {
        await enqueueDbJob(db, { kind: RENEWAL_JOB_KIND, payload: {}, dedupeKey: "renewal-sweep" });
    } catch (error) {
        console.error("[renewals] enqueue failed", { error: safeError(error) });
    }
}
