// Scans and their changes as the team reads them: list, create from a
// preset, triage (read / star / archive) and the one-click actions that turn
// a change into work (a request on the pipeline, a deadline on the radar).
//
// Who sees what: a scan with an org_id is visible to every member of that
// organization; a personal scan only to its creator. Contracts a change
// affects are filtered by the reader's project access, so a change never
// reveals a contract the reader cannot open.

import type { Db } from "../../lib/supabase";
import { getOrgRole, listAccessibleProjectIds } from "../../lib/access";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { createProject } from "../projects/projects.service";
import { createObligation, recordCardEvent, updatePipelineCard } from "../contracts/contracts.service";
import { PRESETS, TOPICS, type Affected } from "./regulatory.match";
import { SOURCE_IDS, SOURCE_LABELS } from "./regulatory.sources";
import { enqueueRegulatoryScan } from "./regulatory.scan";

export type Caller = { userId: string; userEmail?: string | null };

const SCAN_COLUMNS =
    "id, user_id, org_id, name, preset, sources, issuers, keywords, topics, enabled, last_run_at, last_error, created_at, updated_at";
const CHANGE_COLUMNS =
    "id, scan_id, source, external_id, title, act_type, issuer, published_at, url, excerpt, summary, summary_quote, " +
    "impact, impact_reason, effective_date, topics, matched_terms, affected, suggested_action, status, starred, " +
    "request_project_id, obligation_id, decided_by, decided_at, created_at";

export type RegulatoryScan = Record<string, unknown> & { id: string; counts: ScanCounts };
type ScanCounts = { novas: number; abertas: number; alto: number };
export type AffectedContract = { project_id: string; name: string; counterparty: string | null; term: string; quote: string };
export type RegulatoryChange = Record<string, unknown> & {
    id: string;
    scan_id: string;
    affected: AffectedContract[];
    /** How many affected contracts the reader cannot see (never their names). */
    affected_hidden: number;
};

type ScanAccessRow = { id: string; user_id: string | null; org_id: string | null; name: string };

/** The orgs the caller belongs to (any role). */
async function memberOrgIds(db: Db, userId: string): Promise<string[]> {
    const { data, error } = await db
        .from("org_members")
        .select("org_id, organizations!inner(id)")
        .is("organizations.deleted_at", null)
        .eq("user_id", userId);
    if (error) throw error;
    return ((data ?? []) as { org_id: string }[]).map((r) => r.org_id);
}

async function visibleScans(db: Db, caller: Caller): Promise<ScanAccessRow[]> {
    const orgs = await memberOrgIds(db, caller.userId);
    const scope = [`and(org_id.is.null,user_id.eq.${caller.userId})`];
    if (orgs.length > 0) scope.push(`org_id.in.(${orgs.join(",")})`);
    const { data, error } = await db
        .from("regulatory_scans")
        .select(SCAN_COLUMNS)
        .or(scope.join(","))
        .order("created_at", { ascending: true });
    if (error) throw error;
    return (data ?? []) as unknown as ScanAccessRow[];
}

/** Ids of the scans the caller sees: their personal ones and their organizations'. */
export async function visibleScanIds(db: Db, caller: Caller): Promise<string[]> {
    return (await visibleScans(db, caller)).map((s) => s.id);
}

async function canSeeScan(db: Db, caller: Caller, scan: ScanAccessRow): Promise<boolean> {
    if (scan.org_id) return (await getOrgRole(caller.userId, scan.org_id, db)) !== null;
    return scan.user_id === caller.userId;
}

async function loadScan(db: Db, caller: Caller, scanId: string): Promise<ScanAccessRow | null> {
    const { data, error } = await db.from("regulatory_scans").select(SCAN_COLUMNS).eq("id", scanId).maybeSingle();
    if (error) throw error;
    const scan = data as unknown as ScanAccessRow | null;
    if (!scan || !(await canSeeScan(db, caller, scan))) return null;
    return scan;
}

const SCAN_NOT_FOUND = failure("not_found", "Scan not found");
const CHANGE_NOT_FOUND = failure("not_found", "Change not found");

export function listPresets() {
    return {
        presets: PRESETS.map((p) => ({ ...p })),
        sources: SOURCE_IDS.map((id) => ({ id, label: SOURCE_LABELS[id] })),
        topics: [...TOPICS],
    };
}

export async function listScans(db: Db, caller: Caller): Promise<ServiceResult<RegulatoryScan[]>> {
    let scans: ScanAccessRow[];
    try {
        scans = await visibleScans(db, caller);
    } catch (error) {
        return internalFailure(error);
    }
    if (scans.length === 0) return ok([]);
    const { data, error } = await db
        .from("regulatory_changes")
        .select("scan_id, status, impact")
        .in("scan_id", scans.map((s) => s.id))
        .neq("status", "arquivada");
    if (error) return internalFailure(error);
    const counts = new Map<string, ScanCounts>();
    for (const row of (data ?? []) as { scan_id: string; status: string; impact: string }[]) {
        const c = counts.get(row.scan_id) ?? { novas: 0, abertas: 0, alto: 0 };
        c.abertas++;
        if (row.status === "nova") c.novas++;
        if (row.impact === "alto") c.alto++;
        counts.set(row.scan_id, c);
    }
    return ok(scans.map((s) => ({ ...s, counts: counts.get(s.id) ?? { novas: 0, abertas: 0, alto: 0 } })));
}

function stringList(value: unknown, max = 60): string[] | null {
    if (value === undefined) return null;
    if (!Array.isArray(value)) return null;
    const out = value
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter(Boolean)
        .slice(0, max);
    return [...new Set(out)];
}

/**
 * Create a scan, from a preset key or from explicit fields. A scan goes to the
 * caller's organization when org_id is given and they belong to it, so the
 * whole team triages one list. The first run is queued immediately: the
 * screen fills in seconds, not at the next sweep.
 */
export async function createScan(
    db: Db,
    caller: Caller,
    body: Record<string, unknown>,
): Promise<ServiceResult<RegulatoryScan>> {
    const preset = typeof body.preset === "string" ? PRESETS.find((p) => p.key === body.preset) : undefined;
    if (body.preset !== undefined && !preset) return failure("validation", "Unknown preset");

    const name = (typeof body.name === "string" ? body.name.trim() : "") || preset?.name || "";
    if (!name || name.length > 120) return failure("validation", "name is required (up to 120 characters)");

    const sources = stringList(body.sources) ?? preset?.sources ?? [];
    if (sources.length === 0 || sources.some((s) => !(SOURCE_IDS as readonly string[]).includes(s))) {
        return failure("validation", `sources must be some of: ${SOURCE_IDS.join(", ")}`);
    }
    const topics = stringList(body.topics) ?? preset?.topics ?? [];
    if (topics.some((t) => !(TOPICS as readonly string[]).includes(t))) {
        return failure("validation", `topics must be some of: ${TOPICS.join(", ")}`);
    }

    let orgId: string | null = null;
    if (typeof body.org_id === "string" && body.org_id) {
        if (!(await getOrgRole(caller.userId, body.org_id, db))) {
            return failure("forbidden", "You are not a member of that organization.");
        }
        orgId = body.org_id;
    }

    const { data, error } = await db
        .from("regulatory_scans")
        .insert({
            user_id: caller.userId,
            org_id: orgId,
            name,
            preset: preset?.key ?? null,
            sources,
            issuers: stringList(body.issuers) ?? preset?.issuers ?? [],
            keywords: stringList(body.keywords, 120) ?? preset?.keywords ?? [],
            topics,
        })
        .select(SCAN_COLUMNS)
        .single();
    if (error) return internalFailure(error);
    const scan = data as unknown as RegulatoryScan;
    try {
        await enqueueRegulatoryScan(db, scan.id);
    } catch {
        // The periodic sweep runs it anyway; creating the scan already succeeded.
    }
    return ok({ ...scan, counts: { novas: 0, abertas: 0, alto: 0 } });
}

export async function updateScan(
    db: Db,
    caller: Caller,
    scanId: string,
    body: Record<string, unknown>,
): Promise<ServiceResult<Record<string, unknown>>> {
    const scan = await loadScan(db, caller, scanId).catch(() => undefined);
    if (scan === undefined) return internalFailure(new Error("scan lookup failed"));
    if (!scan) return SCAN_NOT_FOUND;
    const patch: Record<string, unknown> = {};
    if (typeof body.name === "string") {
        const name = body.name.trim();
        if (!name || name.length > 120) return failure("validation", "name is required (up to 120 characters)");
        patch.name = name;
    }
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    const keywords = stringList(body.keywords, 120);
    if (keywords) patch.keywords = keywords;
    if (Object.keys(patch).length === 0) return failure("validation", "Nothing to update");
    patch.updated_at = new Date().toISOString();
    const { data, error } = await db.from("regulatory_scans").update(patch).eq("id", scanId).select(SCAN_COLUMNS).single();
    if (error) return internalFailure(error);
    return ok(data as Record<string, unknown>);
}

export async function deleteScan(db: Db, caller: Caller, scanId: string): Promise<ServiceResult<null>> {
    const scan = await loadScan(db, caller, scanId).catch(() => undefined);
    if (scan === undefined) return internalFailure(new Error("scan lookup failed"));
    if (!scan) return SCAN_NOT_FOUND;
    const { error } = await db.from("regulatory_scans").delete().eq("id", scanId);
    if (error) return internalFailure(error);
    return ok(null);
}

export async function runScanNow(db: Db, caller: Caller, scanId: string): Promise<ServiceResult<{ queued: boolean }>> {
    const scan = await loadScan(db, caller, scanId).catch(() => undefined);
    if (scan === undefined) return internalFailure(new Error("scan lookup failed"));
    if (!scan) return SCAN_NOT_FOUND;
    try {
        await enqueueRegulatoryScan(db, scanId);
    } catch (error) {
        return internalFailure(error);
    }
    return ok({ queued: true });
}

const TABS = ["todas", "nao_lidas", "favoritas", "arquivadas"] as const;
type Tab = (typeof TABS)[number];
const IMPACT_ORDER: Record<string, number> = { alto: 0, medio: 1, baixo: 2 };

async function resolveAffected(
    db: Db,
    caller: Caller,
    rows: Record<string, unknown>[],
): Promise<RegulatoryChange[]> {
    const ids = new Set<string>();
    for (const row of rows) for (const a of (row.affected as Affected[] | null) ?? []) ids.add(a.project_id);
    const visible = new Set(ids.size ? await listAccessibleProjectIds(caller.userId, caller.userEmail, db) : []);
    const wanted = [...ids].filter((id) => visible.has(id));
    const names = new Map<string, { name: string; counterparty: string | null }>();
    if (wanted.length > 0) {
        const { data, error } = await db.from("projects").select("id, name, counterparty").in("id", wanted);
        if (error) throw error;
        for (const p of (data ?? []) as { id: string; name: string; counterparty: string | null }[]) {
            names.set(p.id, { name: p.name, counterparty: p.counterparty });
        }
    }
    return rows.map((row) => {
        const all = (row.affected as Affected[] | null) ?? [];
        const shown: AffectedContract[] = [];
        for (const a of all) {
            const p = names.get(a.project_id);
            if (p) shown.push({ project_id: a.project_id, name: p.name, counterparty: p.counterparty, term: a.term, quote: a.quote });
        }
        return { ...(row as RegulatoryChange), affected: shown, affected_hidden: all.length - shown.length };
    });
}

/**
 * The changes of the caller's scans (or of one scan), ordered by consequence:
 * impact first, then most recent. Tabs mirror how a team triages:
 * todas (not archived) · não lidas · favoritas · arquivadas.
 */
export async function listChanges(
    db: Db,
    caller: Caller,
    query: { scan_id?: unknown; tab?: unknown; q?: unknown },
): Promise<ServiceResult<{ changes: RegulatoryChange[]; tabs: Record<Tab, number> }>> {
    let scans: ScanAccessRow[];
    try {
        scans = await visibleScans(db, caller);
    } catch (error) {
        return internalFailure(error);
    }
    let scanIds = scans.map((s) => s.id);
    if (typeof query.scan_id === "string" && query.scan_id) {
        if (!scanIds.includes(query.scan_id)) return SCAN_NOT_FOUND;
        scanIds = [query.scan_id];
    }
    const empty = { todas: 0, nao_lidas: 0, favoritas: 0, arquivadas: 0 };
    if (scanIds.length === 0) return ok({ changes: [], tabs: empty });

    const { data, error } = await db
        .from("regulatory_changes")
        .select(CHANGE_COLUMNS)
        .in("scan_id", scanIds)
        .order("published_at", { ascending: false })
        .limit(500);
    if (error) return internalFailure(error);
    const all = (data ?? []) as unknown as Record<string, unknown>[];

    const tabs = { ...empty };
    for (const c of all) {
        if (c.status === "arquivada") tabs.arquivadas++;
        else {
            tabs.todas++;
            if (c.status === "nova") tabs.nao_lidas++;
            if (c.starred) tabs.favoritas++;
        }
    }
    const tab: Tab = (TABS as readonly string[]).includes(String(query.tab)) ? (query.tab as Tab) : "todas";
    const q = typeof query.q === "string" ? query.q.trim().toLowerCase() : "";
    const picked = all
        .filter((c) =>
            tab === "arquivadas"
                ? c.status === "arquivada"
                : c.status !== "arquivada" &&
                  (tab === "todas" || (tab === "nao_lidas" ? c.status === "nova" : c.starred === true)),
        )
        .filter((c) => !q || `${c.title} ${c.issuer ?? ""} ${c.excerpt ?? ""}`.toLowerCase().includes(q))
        .sort(
            (a, b) =>
                (IMPACT_ORDER[String(a.impact)] ?? 3) - (IMPACT_ORDER[String(b.impact)] ?? 3) ||
                String(b.published_at ?? "").localeCompare(String(a.published_at ?? "")),
        );
    try {
        return ok({ changes: await resolveAffected(db, caller, picked), tabs });
    } catch (err) {
        return internalFailure(err);
    }
}

/** A change and its scan, or null when the caller cannot see the scan. */
export async function loadVisibleChange(
    db: Db,
    caller: Caller,
    changeId: string,
): Promise<{ change: Record<string, unknown>; scan: ScanAccessRow } | null> {
    const { data, error } = await db.from("regulatory_changes").select(CHANGE_COLUMNS).eq("id", changeId).maybeSingle();
    if (error) throw error;
    const change = data as Record<string, unknown> | null;
    if (!change) return null;
    const scan = await loadScan(db, caller, String(change.scan_id));
    return scan ? { change, scan } : null;
}

/** Triage: mark read / unread, star, archive or restore. */
export async function updateChange(
    db: Db,
    caller: Caller,
    changeId: string,
    body: Record<string, unknown>,
): Promise<ServiceResult<RegulatoryChange>> {
    let found: Awaited<ReturnType<typeof loadVisibleChange>>;
    try {
        found = await loadVisibleChange(db, caller, changeId);
    } catch (error) {
        return internalFailure(error);
    }
    if (!found) return CHANGE_NOT_FOUND;
    const patch: Record<string, unknown> = {};
    if ("status" in body) {
        if (!["nova", "lida", "arquivada"].includes(String(body.status))) {
            return failure("validation", "status must be one of: nova, lida, arquivada");
        }
        patch.status = body.status;
        if (body.status === "arquivada") {
            patch.decided_by = caller.userEmail ?? caller.userId;
            patch.decided_at = new Date().toISOString();
        }
    }
    if (typeof body.starred === "boolean") patch.starred = body.starred;
    if (Object.keys(patch).length === 0) return failure("validation", "Nothing to update");
    patch.updated_at = new Date().toISOString();
    const { data, error } = await db
        .from("regulatory_changes")
        .update(patch)
        .eq("id", changeId)
        .select(CHANGE_COLUMNS)
        .single();
    if (error) return internalFailure(error);
    try {
        const [resolved] = await resolveAffected(db, caller, [data as unknown as Record<string, unknown>]);
        return ok(resolved);
    } catch (err) {
        return internalFailure(err);
    }
}

/**
 * Someone acted on the change: a new change becomes read and the decision is
 * attributed. Best-effort — the action already succeeded.
 */
export async function recordChangeDecision(
    db: Db,
    changeId: string,
    change: Record<string, unknown>,
    caller: Caller,
): Promise<void> {
    await db
        .from("regulatory_changes")
        .update({
            status: change.status === "nova" ? "lida" : change.status,
            decided_by: caller.userEmail ?? caller.userId,
            decided_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        })
        .eq("id", changeId);
}

function addDays(iso: string, days: number): string {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/** The request's deadline: some room before the rule takes effect, else two weeks out. */
export function requestDeadline(effective: string | null, today: string): string {
    if (effective && effective > today) {
        const margin = addDays(effective, -7);
        return margin > today ? margin : effective;
    }
    return addDays(today, 14);
}

/**
 * "Criar pedido": a pipeline card in Entrada carrying the change, so it
 * follows the same esteira as any other request (owner, deadline, stage).
 */
export async function createRequestFromChange(
    db: Db,
    caller: Caller,
    changeId: string,
    body: Record<string, unknown>,
): Promise<ServiceResult<{ project_id: string; change: RegulatoryChange }>> {
    let found: Awaited<ReturnType<typeof loadVisibleChange>>;
    try {
        found = await loadVisibleChange(db, caller, changeId);
    } catch (error) {
        return internalFailure(error);
    }
    if (!found) return CHANGE_NOT_FOUND;
    const { change, scan } = found;
    if (change.request_project_id) return failure("conflict", "A request already exists for this change");

    const title = String(change.title);
    const created = await createProject(db, {
        userId: caller.userId,
        name: `Regulatório: ${title}`.slice(0, 200),
        practice: "Regulatório",
        org_id: scan.org_id,
        visibility: scan.org_id ? "organization" : undefined,
    });
    if (!created.ok) {
        return created.kind === "validation" ? failure("validation", created.detail) : internalFailure(created.error);
    }
    const projectId = String(created.project.id);
    const today = new Date().toISOString().slice(0, 10);
    const card = await updatePipelineCard(db, caller, projectId, {
        lane: "entrada",
        status: "a_fazer",
        priority: change.impact === "alto" ? "alta" : "media",
        deadline: requestDeadline((change.effective_date as string | null) ?? null, today),
        requester_name: "Agente regulatório",
        assignee_email: typeof body.assignee_email === "string" ? body.assignee_email : null,
    });
    if (!card.ok) return card;
    // The card's feed opens with where the request came from: the act, its
    // official link, and who turned it into work.
    await recordCardEvent(db, {
        projectId,
        orgId: scan.org_id,
        actorType: "agent",
        actorId: "agent:regulatorio@1",
        actorName: "Agente regulatório",
        onBehalfOf: caller.userEmail ?? null,
        action: "request.created",
        after: {
            // The activity feed reads `request` as the object of "criou o pedido".
            request: `Regulatório: ${title}`.slice(0, 200),
            origin: "regulatory",
            scan: scan.name,
            change_id: changeId,
            title,
            url: change.url ?? null,
            impact: change.impact,
            affected: ((change.affected as Affected[] | null) ?? []).length,
        },
        source: "agent",
    });

    const patch = {
        request_project_id: projectId,
        status: change.status === "nova" ? "lida" : change.status,
        decided_by: caller.userEmail ?? caller.userId,
        decided_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
    const { data, error } = await db.from("regulatory_changes").update(patch).eq("id", changeId).select(CHANGE_COLUMNS).single();
    if (error) return internalFailure(error);
    try {
        const [resolved] = await resolveAffected(db, caller, [data as unknown as Record<string, unknown>]);
        return ok({ project_id: projectId, change: resolved });
    } catch (err) {
        return internalFailure(err);
    }
}

/**
 * "Criar obrigação": the date the rule takes effect lands on the same
 * deadline radar as the contracts' notice periods.
 */
export async function createObligationFromChange(
    db: Db,
    caller: Caller,
    changeId: string,
    body: Record<string, unknown>,
): Promise<ServiceResult<{ obligation_id: string; change: RegulatoryChange }>> {
    let found: Awaited<ReturnType<typeof loadVisibleChange>>;
    try {
        found = await loadVisibleChange(db, caller, changeId);
    } catch (error) {
        return internalFailure(error);
    }
    if (!found) return CHANGE_NOT_FOUND;
    const { change } = found;
    if (change.obligation_id) return failure("conflict", "A deadline already exists for this change");
    const due =
        typeof body.due_date === "string" && body.due_date
            ? body.due_date
            : ((change.effective_date as string | null) ?? null);
    if (!due) return failure("validation", "due_date is required when the act does not state when it takes effect");

    const created = await createObligation(db, caller, {
        title: `Vigência: ${String(change.title)}`.slice(0, 200),
        due_date: due,
        mark: change.impact === "alto" ? "critico" : "tarefa",
        note: change.url ? `Fonte oficial: ${String(change.url)}` : null,
        source_quote: (change.summary_quote as string | null) ?? (change.excerpt as string | null),
    });
    if (!created.ok) return created;
    const obligationId = String(created.data.id);
    const { data, error } = await db
        .from("regulatory_changes")
        .update({
            obligation_id: obligationId,
            status: change.status === "nova" ? "lida" : change.status,
            updated_at: new Date().toISOString(),
        })
        .eq("id", changeId)
        .select(CHANGE_COLUMNS)
        .single();
    if (error) return internalFailure(error);
    try {
        const [resolved] = await resolveAffected(db, caller, [data as unknown as Record<string, unknown>]);
        return ok({ obligation_id: obligationId, change: resolved });
    } catch (err) {
        return internalFailure(err);
    }
}
