// Two-way sync between an organization's cards and its Notion board.
//
// Push (Mike → Notion), on change: card_events queue a linked card in
// notion_sync_outbox (trigger, migration 20261022_94); handleNotionPush writes
// pending cards to their pages. The legal team's fields go when Mike changed
// them last; Mike's derived fields (risk, renewal, extracted counterparty,
// type) always go; the app link always points at this deployment.
//
// Pull (Notion → Mike), by polling: handleNotionPull reads pages edited since
// the connection's cursor. Per field, by owner:
//   legal  last edit wins: applied to the card when the page changed after
//          Mike's own last change to it, logged in the card's activity
//   mike   never taken from Notion; the next push writes Mike's value back
//   key    never taken from Notion
// A page whose last_edited_time the card has already seen (our own push) is
// skipped. Pages not linked yet come in as new cards, as the import does.
//
// Nothing here writes to Notion unless the organization turned the sync on.

import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { getOrgRole, isOrgAdmin } from "../../lib/access";
import { recordAudit } from "../../lib/audit";
import { enqueueDbJob } from "../../lib/dbq/enqueue";
import { recordCardEvent } from "../contracts/contracts.service";
import { notionErrorMessage, type Fetch, type NotionClient } from "./notion.client";
import { clientForOrg, type Caller, type Row } from "./notion.connection";
import { MIKE_FIELDS, readPage, writePage, type CardFields, type FieldMap, type MikeField, type StageMap } from "./notion.mapping";

/** One job per organization: pull the board, then push the queued cards. */
export const SYNC_JOB = "notion.sync";
const MAX_ATTEMPTS = 5;
const PUSH_BATCH = 50;

const LEGAL_FIELDS = new Set(
    (Object.entries(MIKE_FIELDS) as [MikeField, (typeof MIKE_FIELDS)[MikeField]][]).filter(([, s]) => s.owner === "legal").map(([f]) => f),
);
// The legal team's fields that live on the card row (name is the title).
const CARD_COLUMN: Partial<Record<MikeField, string>> = {
    name: "name",
    lane: "lane",
    status: "status",
    priority: "priority",
    deadline: "deadline",
    completed_at: "completed_at",
    requester_name: "requester_name",
};

type Card = {
    id: string;
    org_id: string;
    name: string;
    lane: CardFields["lane"] | null;
    notion_stage: string | null;
    status: CardFields["status"];
    priority: CardFields["priority"];
    assignee_email: string | null;
    deadline: string | null;
    completed_at: string | null;
    requester_name: string | null;
    counterparty: string | null;
    risk_level: CardFields["risk_level"];
    contract_type: string | null;
    notion_page_id: string | null;
    notion_seen_at: string | null;
};
const CARD_COLUMNS =
    "id, org_id, name, lane, notion_stage, status, priority, assignee_email, deadline, completed_at, requester_name, counterparty, risk_level, contract_type, notion_page_id, notion_seen_at";

function appBase(): string {
    return (process.env.APP_BASE_URL?.trim() || process.env.FRONTEND_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");
}

/** Notion users by e-mail and back, read once per run (needs the "read user e-mails" capability). */
async function notionPeople(client: NotionClient): Promise<{ idOf: Map<string, string>; emailOf: Map<string, string> }> {
    const idOf = new Map<string, string>();
    const emailOf = new Map<string, string>();
    let cursor: string | undefined;
    do {
        const result = await client.request("GET", `/users?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`);
        for (const user of (result.results ?? []) as { id: string; type?: string; person?: { email?: string } }[]) {
            const email = user.person?.email?.toLowerCase();
            if (user.type === "person" && email) {
                idOf.set(email, user.id);
                emailOf.set(user.id, email);
            }
        }
        cursor = result.has_more ? (result.next_cursor as string) : undefined;
    } while (cursor);
    return { idOf, emailOf };
}

/** When Mike itself last changed each card (any event the sync did not cause). */
async function lastMikeChange(db: Db, projectIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!projectIds.length) return out;
    const { data, error } = await db
        .from("card_events")
        .select("project_id, at")
        .in("project_id", projectIds)
        .neq("source", "notion")
        .order("at", { ascending: false });
    if (error) throw error;
    for (const row of (data ?? []) as { project_id: string; at: string }[]) if (!out.has(row.project_id)) out.set(row.project_id, row.at);
    return out;
}

async function renewals(db: Db, projectIds: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (!projectIds.length) return out;
    const { data, error } = await db.from("contract_terms").select("project_id, notice_deadline").in("project_id", projectIds);
    if (error) throw error;
    for (const row of (data ?? []) as { project_id: string; notice_deadline: string | null }[]) out.set(row.project_id, row.notice_deadline);
    return out;
}

type Connection = { client: NotionClient; row: Row; fieldMap: FieldMap; stageMap: StageMap };

async function connectionFor(db: Db, orgId: string, fetchImpl?: Fetch): Promise<Connection | null> {
    const conn = await clientForOrg(db, orgId, fetchImpl);
    if (!conn || !conn.row.sync_enabled || !conn.row.database_id) return null;
    return { client: conn.client, row: conn.row, fieldMap: (conn.row.field_map ?? {}) as FieldMap, stageMap: (conn.row.stage_map ?? {}) as StageMap };
}

async function stamp(db: Db, orgId: string, patch: { last_sync_at?: string; last_sync_error?: string | null; pull_cursor?: string }) {
    const { error } = await db.from("notion_connections").update(patch).eq("org_id", orgId);
    if (error) throw error;
}

// ── push ────────────────────────────────────────────────────────────────────

/** Writes one organization's pending cards to their pages. */
export async function pushOrg(db: Db, orgId: string, fetchImpl?: Fetch): Promise<{ sent: number; failed: number }> {
    const { data, error } = await db
        .from("notion_sync_outbox")
        .select("project_id, attempts")
        .eq("org_id", orgId)
        .eq("status", "pending")
        .order("queued_at", { ascending: true })
        .limit(PUSH_BATCH);
    if (error) throw error;
    const queue = (data ?? []) as { project_id: string; attempts: number }[];
    if (!queue.length) return { sent: 0, failed: 0 };
    const conn = await connectionFor(db, orgId, fetchImpl);
    if (!conn) {
        // Sync turned off or disconnected since queuing: drop the queue quietly.
        const { error: clearError } = await db.from("notion_sync_outbox").delete().eq("org_id", orgId).eq("status", "pending");
        if (clearError) throw clearError;
        return { sent: 0, failed: 0 };
    }
    const ids = queue.map((q) => q.project_id);
    const { data: cardRows, error: cardError } = await db.from("projects").select(CARD_COLUMNS).in("id", ids).eq("org_id", orgId);
    if (cardError) throw cardError;
    const cards = new Map(((cardRows ?? []) as Card[]).map((c) => [c.id, c]));
    const renewal = await renewals(db, ids);
    const people = Object.values(conn.fieldMap).includes("assignee") ? await notionPeople(conn.client) : null;
    const every = new Set(Object.keys(MIKE_FIELDS) as MikeField[]);
    every.delete("project_id");

    let sent = 0;
    let failed = 0;
    for (const item of queue) {
        const card = cards.get(item.project_id);
        if (!card?.notion_page_id) {
            await db.from("notion_sync_outbox").delete().eq("project_id", item.project_id);
            continue;
        }
        try {
            const props = writePage(
                {
                    ...card,
                    lane: card.lane ?? undefined,
                    renewal: renewal.get(card.id) ?? null,
                    app_link: `${appBase()}/projects/${card.id}`,
                    assignee_notion_ids: card.assignee_email && people?.idOf.get(card.assignee_email) ? [people.idOf.get(card.assignee_email)!] : [],
                },
                conn.fieldMap,
                conn.stageMap,
                every,
                (conn.row.field_types ?? {}) as Record<string, string>,
            );
            const page = await conn.client.request("PATCH", `/pages/${encodeURIComponent(card.notion_page_id)}`, { properties: props });
            // What we just wrote is not someone's edit: remember its timestamp.
            await db.from("projects").update({ notion_seen_at: (page.last_edited_time as string) ?? null }).eq("id", card.id);
            await db.from("notion_sync_outbox").update({ status: "sent", sent_at: new Date().toISOString(), attempts: item.attempts + 1, last_error: null }).eq("project_id", card.id);
            sent += 1;
        } catch (err) {
            failed += 1;
            const attempts = item.attempts + 1;
            await db
                .from("notion_sync_outbox")
                .update({ status: attempts >= MAX_ATTEMPTS ? "failed" : "pending", attempts, last_error: notionErrorMessage(err) })
                .eq("project_id", item.project_id);
        }
    }
    return { sent, failed };
}

// ── pull ────────────────────────────────────────────────────────────────────

type Page = { id: string; url?: string; last_edited_time: string; archived?: boolean; in_trash?: boolean; properties: Record<string, { type?: string; [k: string]: unknown }> };

export type PullResult = { read: number; updated: number; created: number; unchanged: number };

const LEGAL_LABEL: Partial<Record<MikeField, string>> = {
    name: "Nome",
    lane: "Etapa",
    status: "Progresso",
    priority: "Prioridade",
    assignee: "Responsável",
    deadline: "Prazo",
    completed_at: "Conclusão",
    requester_name: "Solicitante",
};

/** Reads pages edited since the cursor and applies the legal team's edits. */
export async function pullOrg(db: Db, orgId: string, fetchImpl?: Fetch, now: Date = new Date()): Promise<PullResult> {
    const conn = await connectionFor(db, orgId, fetchImpl);
    if (!conn) return { read: 0, updated: 0, created: 0, unchanged: 0 };
    const cursor = conn.row.pull_cursor ?? null;
    const pages: Page[] = [];
    let next: string | undefined;
    do {
        const body: Record<string, unknown> = {
            page_size: 100,
            sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
        };
        if (cursor) body.filter = { timestamp: "last_edited_time", last_edited_time: { on_or_after: cursor } };
        if (next) body.start_cursor = next;
        const result = await conn.client.request("POST", `/databases/${encodeURIComponent(conn.row.database_id!)}/query`, body);
        for (const page of (result.results ?? []) as Page[]) if (!page.archived && !page.in_trash) pages.push(page);
        next = result.has_more ? (result.next_cursor as string) : undefined;
    } while (next);

    const out: PullResult = { read: pages.length, updated: 0, created: 0, unchanged: 0 };
    const pageIds = pages.map((p) => p.id);
    const { data: linked, error } = pageIds.length
        ? await db.from("projects").select(CARD_COLUMNS).eq("org_id", orgId).in("notion_page_id", pageIds)
        : { data: [], error: null };
    if (error) throw error;
    const byPage = new Map(((linked ?? []) as Card[]).map((c) => [c.notion_page_id!, c]));
    const mikeAt = await lastMikeChange(db, [...byPage.values()].map((c) => c.id));
    const people = Object.values(conn.fieldMap).includes("assignee") && pages.length ? await notionPeople(conn.client) : null;
    let newest = cursor;

    for (const page of pages) {
        if (!newest || page.last_edited_time > newest) newest = page.last_edited_time;
        const fields = readPage(page.properties, conn.fieldMap, conn.stageMap);
        const card = byPage.get(page.id);
        if (!card) {
            if (!fields.name) continue;
            const { data, error: createError } = await db.rpc("create_project_with_memory", {
                p_user_id: conn.row.connected_by ?? null,
                p_name: fields.name,
                p_cm_number: null,
                p_practice: null,
                p_org_id: orgId,
                p_memory_enabled: false,
            });
            const created = Array.isArray(data) ? data[0] : data;
            if (createError || !created) throw createError ?? new Error("project not created");
            const projectId = (created as { id: string }).id;
            const { error: updateError } = await db
                .from("projects")
                .update({
                    visibility: "organization",
                    lane: fields.lane ?? "entrada",
                    notion_stage: fields.notion_stage ?? null,
                    status: fields.status ?? null,
                    priority: fields.priority ?? null,
                    deadline: fields.deadline ?? null,
                    completed_at: fields.completed_at ?? null,
                    requester_name: fields.requester_name ?? null,
                    counterparty: fields.counterparty ?? null,
                    risk_level: fields.risk_level ?? null,
                    contract_type: fields.contract_type ?? null,
                    assignee_email: fields.assignee_ids?.length ? (people?.emailOf.get(fields.assignee_ids[0]) ?? null) : null,
                    lane_updated_at: now.toISOString(),
                    notion_page_id: page.id,
                    notion_url: page.url ?? null,
                    notion_seen_at: page.last_edited_time,
                })
                .eq("id", projectId);
            if (updateError) throw updateError;
            await recordCardEvent(db, {
                projectId,
                orgId,
                actorType: "system",
                actorId: "notion:sync",
                actorName: "Notion",
                action: "notion.imported",
                source: "notion",
            });
            out.created += 1;
            continue;
        }
        // Our own push, or already applied.
        if (card.notion_seen_at && page.last_edited_time <= card.notion_seen_at) {
            out.unchanged += 1;
            continue;
        }
        // Mike changed the card after this edit: Mike's value stands, the push writes it back.
        const mikeChanged = mikeAt.get(card.id);
        if (mikeChanged && mikeChanged > page.last_edited_time) {
            await db.from("projects").update({ notion_seen_at: page.last_edited_time }).eq("id", card.id);
            out.unchanged += 1;
            continue;
        }
        const patch: Record<string, unknown> = {};
        const changes: { field: string; before: unknown; after: unknown }[] = [];
        for (const field of LEGAL_FIELDS) {
            if (!(Object.values(conn.fieldMap) as MikeField[]).includes(field)) continue;
            if (field === "assignee") {
                const email = fields.assignee_ids?.length ? (people?.emailOf.get(fields.assignee_ids[0]) ?? null) : null;
                if (email !== (card.assignee_email ?? null)) {
                    patch.assignee_email = email;
                    changes.push({ field: "assignee", before: card.assignee_email, after: email });
                }
                continue;
            }
            const column = CARD_COLUMN[field]!;
            const value = (fields as Record<string, unknown>)[field];
            if (field === "name" && !value) continue;
            if (field === "lane") {
                const lane = fields.lane ?? card.lane;
                const tag = fields.lane ? (fields.notion_stage ?? null) : card.notion_stage;
                if (lane !== card.lane || tag !== card.notion_stage) {
                    patch.lane = lane;
                    patch.notion_stage = tag;
                    if (lane !== card.lane) patch.lane_updated_at = now.toISOString();
                    changes.push({ field: "lane", before: card.notion_stage ?? card.lane, after: tag ?? lane });
                }
                continue;
            }
            const current = (card as Record<string, unknown>)[column] ?? null;
            if ((value ?? null) !== current) {
                patch[column] = value ?? null;
                changes.push({ field, before: current, after: value ?? null });
            }
        }
        patch.notion_seen_at = page.last_edited_time;
        const { error: updateError } = await db.from("projects").update(patch).eq("id", card.id).eq("org_id", orgId);
        if (updateError) throw updateError;
        for (const change of changes) {
            await recordCardEvent(db, {
                projectId: card.id,
                orgId,
                actorType: "system",
                actorId: "notion:sync",
                actorName: "Notion",
                action: change.field === "lane" ? "lane.changed" : "field.updated",
                field: LEGAL_LABEL[change.field as MikeField] ?? change.field,
                before: change.before,
                after: change.after,
                source: "notion",
            });
        }
        if (changes.length) out.updated += 1;
        else out.unchanged += 1;
    }
    if (newest && newest !== cursor) await stamp(db, orgId, { pull_cursor: newest });
    return out;
}

// ── jobs, sweep, status ─────────────────────────────────────────────────────

/**
 * The deployment-wide switch for the sync (NOTION_SYNC_ENABLED=true). Off by
 * default: with it off nothing sweeps, no job does any work and nothing is
 * sent to api.notion.com, whatever the organizations have set. Read on every
 * call so it can be flipped without code.
 */
export function notionSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return /^(1|true|yes|on)$/i.test((env.NOTION_SYNC_ENABLED ?? "").trim());
}

/** Job: pull then push one organization, and record how it went. */
export async function handleNotionSync(db: Db, payload: { org_id?: unknown }, fetchImpl?: Fetch): Promise<Record<string, unknown>> {
    if (!notionSyncEnabled()) return { skipped: "flag_off" };
    const orgId = typeof payload.org_id === "string" ? payload.org_id : null;
    if (!orgId) return { skipped: "no_org" };
    try {
        const pulled = await pullOrg(db, orgId, fetchImpl);
        const pushed = await pushOrg(db, orgId, fetchImpl);
        await stamp(db, orgId, { last_sync_at: new Date().toISOString(), last_sync_error: null });
        return { ...pulled, ...pushed };
    } catch (err) {
        await stamp(db, orgId, { last_sync_at: new Date().toISOString(), last_sync_error: notionErrorMessage(err) }).catch(() => undefined);
        throw err;
    }
}

/**
 * Sweep (every minute): queue a sync for every organization whose polling
 * interval has passed, or that has cards waiting to go out — so a change in
 * Mike reaches Notion within a minute, not at the next poll.
 */
export async function enqueueDueNotionSyncs(db: Db, now: Date = new Date()): Promise<number> {
    if (!notionSyncEnabled()) return 0;
    const { data, error } = await db.from("notion_connections").select("org_id, poll_minutes, last_sync_at").eq("sync_enabled", true);
    if (error) throw error;
    const rows = (data ?? []) as { org_id: string; poll_minutes: number; last_sync_at: string | null }[];
    if (!rows.length) return 0;
    const { data: waiting, error: waitingError } = await db
        .from("notion_sync_outbox")
        .select("org_id")
        .eq("status", "pending")
        .in("org_id", rows.map((r) => r.org_id));
    if (waitingError) throw waitingError;
    const hasPending = new Set(((waiting ?? []) as { org_id: string }[]).map((w) => w.org_id));
    let queued = 0;
    for (const row of rows) {
        const due = !row.last_sync_at || now.getTime() - Date.parse(row.last_sync_at) >= row.poll_minutes * 60_000;
        if (!due && !hasPending.has(row.org_id)) continue;
        await enqueueDbJob(db, { kind: SYNC_JOB, payload: { org_id: row.org_id }, dedupeKey: `${SYNC_JOB}:${row.org_id}` });
        queued += 1;
    }
    return queued;
}

export type SyncStatus = {
    sync_enabled: boolean;
    last_sync_at: string | null;
    last_sync_error: string | null;
    pending: number;
    failed: number;
    linked_cards: number;
};

export async function getNotionSyncStatus(db: Db, caller: Caller, orgId: string): Promise<ServiceResult<SyncStatus>> {
    try {
        if (!(await getOrgRole(caller.userId, orgId, db))) return failure("not_found", "Organização não encontrada.");
        const { data, error } = await db.from("notion_connections").select("sync_enabled, last_sync_at, last_sync_error").eq("org_id", orgId).maybeSingle();
        if (error) throw error;
        const row = data as { sync_enabled: boolean; last_sync_at: string | null; last_sync_error: string | null } | null;
        // The queue is small (one row per card at most); read and count it here.
        const { data: queue, error: queueError } = await db.from("notion_sync_outbox").select("status").eq("org_id", orgId).neq("status", "sent");
        if (queueError) throw queueError;
        const statuses = ((queue ?? []) as { status: string }[]).map((q) => q.status);
        const { data: linked, error: linkedError } = await db.from("projects").select("id").eq("org_id", orgId).not("notion_page_id", "is", null);
        if (linkedError) throw linkedError;
        return ok({
            sync_enabled: row?.sync_enabled ?? false,
            last_sync_at: row?.last_sync_at ?? null,
            last_sync_error: row?.last_sync_error ?? null,
            pending: statuses.filter((s) => s === "pending").length,
            failed: statuses.filter((s) => s === "failed").length,
            linked_cards: (linked ?? []).length,
        });
    } catch (error) {
        return internalFailure(error);
    }
}

/**
 * Turns the two-way sync on or off. On means Mike writes to the board, so
 * only an owner or admin may, and only once the mapping is saved.
 */
export async function setNotionSyncEnabled(db: Db, caller: Caller, orgId: string, enabled: unknown): Promise<ServiceResult<{ sync_enabled: boolean }>> {
    try {
        const role = await getOrgRole(caller.userId, orgId, db);
        if (!role) return failure("not_found", "Organização não encontrada.");
        if (!isOrgAdmin(role)) return failure("forbidden", "Só quem administra a organização pode ligar a sincronia com o Notion.");
        if (typeof enabled !== "boolean") return failure("validation", "Diga se a sincronia fica ligada ou desligada.");
        const { data, error } = await db.from("notion_connections").select("database_id, field_map, token_encrypted").eq("org_id", orgId).maybeSingle();
        if (error) throw error;
        const row = data as { database_id: string | null; field_map: FieldMap | null; token_encrypted: string | null } | null;
        if (enabled && (!row?.token_encrypted || !row.database_id || !Object.values(row.field_map ?? {}).includes("lane")))
            return failure("conflict", "Conecte o Notion e salve o mapeamento antes de ligar a sincronia.");
        const { error: updateError } = await db.from("notion_connections").update({ sync_enabled: enabled, updated_at: new Date().toISOString() }).eq("org_id", orgId);
        if (updateError) throw updateError;
        await recordAudit(db, {
            userId: caller.userId,
            orgId,
            userEmail: caller.userEmail ?? null,
            action: enabled ? "notion.sync_on" : "notion.sync_off",
            title: "Notion",
            surface: "settings",
        });
        return ok({ sync_enabled: enabled });
    } catch (error) {
        return internalFailure(error);
    }
}

/** "Sincronizar agora": queues the org's sync right away (deduped with the sweep). */
export async function syncNotionNow(db: Db, caller: Caller, orgId: string): Promise<ServiceResult<{ queued: true }>> {
    try {
        const role = await getOrgRole(caller.userId, orgId, db);
        if (!role) return failure("not_found", "Organização não encontrada.");
        if (!isOrgAdmin(role)) return failure("forbidden", "Só quem administra a organização pode sincronizar com o Notion.");
        const { data, error } = await db.from("notion_connections").select("sync_enabled").eq("org_id", orgId).maybeSingle();
        if (error) throw error;
        if (!(data as { sync_enabled?: boolean } | null)?.sync_enabled) return failure("conflict", "Ligue a sincronia antes.");
        await enqueueDbJob(db, { kind: SYNC_JOB, payload: { org_id: orgId }, dedupeKey: `${SYNC_JOB}:${orgId}` });
        return ok({ queued: true });
    } catch (error) {
        return internalFailure(error);
    }
}
