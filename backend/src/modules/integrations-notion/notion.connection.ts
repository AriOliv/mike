// An organization's Notion connection: the token (encrypted at rest, never
// returned), the board it uses and how that board maps onto Mike's cards.
// Owners and admins manage it; every member may see that it exists.

import crypto from "node:crypto";
import { recordAudit } from "../../lib/audit";
import { getOrgRole, isOrgAdmin } from "../../lib/access";
import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { notionClient, notionErrorMessage, NotionError, type Fetch, type NotionClient } from "./notion.client";
import {
    MIKE_FIELDS,
    parseFieldMap,
    parseStageMap,
    suggestFieldMap,
    suggestStageMap,
    type BoardProperty,
    type FieldMap,
    type StageMap,
} from "./notion.mapping";

export type Caller = { userId: string; userEmail?: string | null };

// ── token at rest ────────────────────────────────────────────────────────────

const KEY_SALT = "mike-org-notion-v1";
let cachedKey: { secret: string; key: Buffer } | null = null;

function encryptionKey(): Buffer {
    const secret = process.env.USER_API_KEYS_ENCRYPTION_SECRET;
    if (!secret) throw new Error("USER_API_KEYS_ENCRYPTION_SECRET is not configured");
    if (cachedKey?.secret !== secret) cachedKey = { secret, key: crypto.scryptSync(secret, KEY_SALT, 32) };
    return cachedKey.key;
}

export function encryptToken(token: string): { token_encrypted: string; token_iv: string; token_tag: string } {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return {
        token_encrypted: encrypted.toString("base64"),
        token_iv: iv.toString("base64"),
        token_tag: cipher.getAuthTag().toString("base64"),
    };
}

export function decryptToken(row: { token_encrypted?: string | null; token_iv?: string | null; token_tag?: string | null }): string | null {
    if (!row.token_encrypted || !row.token_iv || !row.token_tag) return null;
    try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(row.token_iv, "base64"));
        decipher.setAuthTag(Buffer.from(row.token_tag, "base64"));
        return Buffer.concat([decipher.update(Buffer.from(row.token_encrypted, "base64")), decipher.final()]).toString("utf8");
    } catch {
        // Wrong key or tampered row: say nothing about the value.
        return null;
    }
}

/** An internal integration token: "ntn_…" or the older "secret_…". */
export function looksLikeNotionToken(value: unknown): value is string {
    return typeof value === "string" && /^(ntn_|secret_)[A-Za-z0-9]{20,120}$/.test(value.trim());
}

// ── what the page sees ───────────────────────────────────────────────────────

export type NotionConnectionView = {
    connected: boolean;
    token_last4: string | null;
    database_id: string | null;
    data_source_id: string | null;
    database_title: string | null;
    field_map: FieldMap;
    stage_map: StageMap;
    sync_enabled: boolean;
    poll_minutes: number;
    last_sync_at: string | null;
    last_sync_error: string | null;
    can_manage: boolean;
    fields: { field: string; label: string; types: readonly string[]; owner: string }[];
};

type Row = {
    org_id: string;
    token_encrypted: string | null;
    token_iv: string | null;
    token_tag: string | null;
    token_last4: string | null;
    database_id: string | null;
    data_source_id: string | null;
    database_title: string | null;
    field_map: FieldMap | null;
    stage_map: StageMap | null;
    sync_enabled: boolean;
    poll_minutes: number;
    last_sync_at: string | null;
    last_sync_error: string | null;
};

const NOT_FOUND = failure("not_found", "Organização não encontrada.");
const ONLY_ADMINS = failure("forbidden", "Só quem administra a organização pode mudar a integração com o Notion.");
const NOT_CONNECTED = failure("conflict", "Conecte o Notion primeiro, com o token da integração.");

const FIELDS = Object.entries(MIKE_FIELDS).map(([field, spec]) => ({ field, label: spec.label, types: spec.types, owner: spec.owner }));

function view(row: Row | null, canManage: boolean): NotionConnectionView {
    return {
        connected: !!row?.token_encrypted,
        token_last4: row?.token_last4 ?? null,
        database_id: row?.database_id ?? null,
        data_source_id: row?.data_source_id ?? null,
        database_title: row?.database_title ?? null,
        field_map: row?.field_map ?? {},
        stage_map: row?.stage_map ?? {},
        sync_enabled: row?.sync_enabled ?? false,
        poll_minutes: row?.poll_minutes ?? 10,
        last_sync_at: row?.last_sync_at ?? null,
        last_sync_error: row?.last_sync_error ?? null,
        can_manage: canManage,
        fields: FIELDS,
    };
}

async function readRow(db: Db, orgId: string): Promise<Row | null> {
    const { data, error } = await db.from("notion_connections").select("*").eq("org_id", orgId).maybeSingle();
    if (error) throw error;
    return data as Row | null;
}

async function access(db: Db, caller: Caller, orgId: string, manage: boolean) {
    const role = await getOrgRole(caller.userId, orgId, db);
    if (!role) return { ok: false as const, result: NOT_FOUND };
    if (manage && !isOrgAdmin(role)) return { ok: false as const, result: ONLY_ADMINS };
    return { ok: true as const, canManage: isOrgAdmin(role) };
}

/** The organization's Notion client, for the sync jobs and the import. Null when not connected. */
export async function clientForOrg(db: Db, orgId: string, fetchImpl?: Fetch): Promise<{ client: NotionClient; row: Row } | null> {
    const row = await readRow(db, orgId);
    const token = row ? decryptToken(row) : null;
    return row && token ? { client: notionClient(token, fetchImpl), row } : null;
}

export async function getNotionConnection(db: Db, caller: Caller, orgId: string): Promise<ServiceResult<NotionConnectionView>> {
    try {
        const who = await access(db, caller, orgId, false);
        if (!who.ok) return who.result;
        return ok(view(await readRow(db, orgId), who.canManage));
    } catch (error) {
        return internalFailure(error);
    }
}

/**
 * Saves the token after checking it against Notion (GET /users/me). The
 * token never leaves this function except encrypted; a failure says why in a
 * sentence, never with the token or Notion's raw answer.
 */
export async function connectNotion(
    db: Db,
    caller: Caller,
    orgId: string,
    token: unknown,
    fetchImpl?: Fetch,
): Promise<ServiceResult<NotionConnectionView>> {
    try {
        const who = await access(db, caller, orgId, true);
        if (!who.ok) return who.result;
        if (!looksLikeNotionToken(token))
            return failure("validation", "Cole o token da integração interna do Notion. Ele começa com ntn_ ou secret_.");
        const clean = token.trim();
        try {
            await notionClient(clean, fetchImpl).request("GET", "/users/me");
        } catch (error) {
            return failure("validation", notionErrorMessage(error));
        }
        const now = new Date().toISOString();
        const { data, error } = await db
            .from("notion_connections")
            .upsert(
                { org_id: orgId, ...encryptToken(clean), token_last4: clean.slice(-4), connected_by: caller.userId, updated_at: now },
                { onConflict: "org_id" },
            )
            .select("*")
            .single();
        if (error) throw error;
        await recordAudit(db, {
            userId: caller.userId,
            orgId,
            userEmail: caller.userEmail ?? null,
            action: "notion.connected",
            title: "Notion",
            surface: "settings",
        });
        return ok(view(data as Row, true));
    } catch (error) {
        return internalFailure(error);
    }
}

export async function disconnectNotion(db: Db, caller: Caller, orgId: string): Promise<ServiceResult<NotionConnectionView>> {
    try {
        const who = await access(db, caller, orgId, true);
        if (!who.ok) return who.result;
        const { data, error } = await db
            .from("notion_connections")
            .update({
                token_encrypted: null,
                token_iv: null,
                token_tag: null,
                token_last4: null,
                sync_enabled: false,
                updated_at: new Date().toISOString(),
            })
            .eq("org_id", orgId)
            .select("*")
            .maybeSingle();
        if (error) throw error;
        await recordAudit(db, {
            userId: caller.userId,
            orgId,
            userEmail: caller.userEmail ?? null,
            action: "notion.disconnected",
            title: "Notion",
            surface: "settings",
        });
        return ok(view(data as Row | null, true));
    } catch (error) {
        return internalFailure(error);
    }
}

export type NotionDatabase = { id: string; data_source_id: string; title: string };

/** The databases the integration was given access to. */
export async function listNotionDatabases(
    db: Db,
    caller: Caller,
    orgId: string,
    fetchImpl?: Fetch,
): Promise<ServiceResult<NotionDatabase[]>> {
    try {
        const who = await access(db, caller, orgId, true);
        if (!who.ok) return who.result;
        const conn = await clientForOrg(db, orgId, fetchImpl);
        if (!conn) return NOT_CONNECTED;
        try {
            const result = await conn.client.request("POST", "/search", {
                filter: { property: "object", value: "database" },
                page_size: 50,
            });
            const items = (result.results ?? []) as { id: string; title?: { plain_text?: string }[] }[];
            return ok(
                items.map((d) => ({
                    id: d.id,
                    // API 2022-06-28: one data source per database, same id.
                    data_source_id: d.id,
                    title: (d.title ?? []).map((t) => t.plain_text ?? "").join("").trim() || "Sem título",
                })),
            );
        } catch (error) {
            return failure("unavailable", notionErrorMessage(error));
        }
    } catch (error) {
        return internalFailure(error);
    }
}

export type BoardSchema = {
    database_id: string;
    title: string;
    /** Every property; select and status ones carry their options (for the stage map). */
    properties: BoardProperty[];
    stage_options: string[];
    suggested_field_map: FieldMap;
    suggested_stage_map: StageMap;
};

function boardProperties(raw: Record<string, { type: string; select?: { options?: { name: string }[] }; status?: { options?: { name: string }[] } }>): BoardProperty[] {
    return Object.entries(raw).map(([name, p]) => ({
        name,
        type: p.type,
        options: (p.select?.options ?? p.status?.options)?.map((o) => o.name),
    }));
}

async function readBoard(client: NotionClient, databaseId: string): Promise<{ title: string; properties: BoardProperty[] }> {
    const meta = await client.request("GET", `/databases/${encodeURIComponent(databaseId)}`);
    const title = ((meta.title ?? []) as { plain_text?: string }[]).map((t) => t.plain_text ?? "").join("").trim() || "Sem título";
    return { title, properties: boardProperties((meta.properties ?? {}) as Parameters<typeof boardProperties>[0]) };
}

function stageOptions(properties: BoardProperty[], fieldMap: FieldMap): string[] {
    const stageProp = Object.entries(fieldMap).find(([, f]) => f === "lane")?.[0];
    return properties.find((p) => p.name === stageProp)?.options ?? [];
}

/** A board's schema with a suggested mapping, for the mapping assistant. */
export async function describeNotionBoard(
    db: Db,
    caller: Caller,
    orgId: string,
    databaseId: unknown,
    fetchImpl?: Fetch,
): Promise<ServiceResult<BoardSchema>> {
    try {
        const who = await access(db, caller, orgId, true);
        if (!who.ok) return who.result;
        if (typeof databaseId !== "string" || !/^[0-9a-f-]{32,36}$/i.test(databaseId))
            return failure("validation", "Escolha uma base do Notion.");
        const conn = await clientForOrg(db, orgId, fetchImpl);
        if (!conn) return NOT_CONNECTED;
        try {
            const board = await readBoard(conn.client, databaseId);
            const suggested = suggestFieldMap(board.properties);
            const options = stageOptions(board.properties, suggested);
            return ok({
                database_id: databaseId,
                title: board.title,
                properties: board.properties,
                stage_options: options,
                suggested_field_map: suggested,
                suggested_stage_map: suggestStageMap(options),
            });
        } catch (error) {
            return failure("unavailable", notionErrorMessage(error));
        }
    } catch (error) {
        return internalFailure(error);
    }
}

/**
 * Saves the board and its mapping, checked against the board as Notion has
 * it now (so a renamed property is caught here, not at the first sync).
 * Sync stays off until someone turns it on, after the import.
 */
export async function saveNotionMapping(
    db: Db,
    caller: Caller,
    orgId: string,
    input: { database_id?: unknown; field_map?: unknown; stage_map?: unknown; poll_minutes?: unknown },
    fetchImpl?: Fetch,
): Promise<ServiceResult<NotionConnectionView>> {
    try {
        const who = await access(db, caller, orgId, true);
        if (!who.ok) return who.result;
        if (typeof input.database_id !== "string" || !/^[0-9a-f-]{32,36}$/i.test(input.database_id))
            return failure("validation", "Escolha uma base do Notion.");
        const poll = input.poll_minutes === undefined ? 10 : Number(input.poll_minutes);
        if (!Number.isInteger(poll) || poll < 5 || poll > 1440)
            return failure("validation", "A sincronia roda de 5 em 5 minutos, no mínimo, e uma vez por dia, no máximo.");
        const conn = await clientForOrg(db, orgId, fetchImpl);
        if (!conn) return NOT_CONNECTED;
        let board: { title: string; properties: BoardProperty[] };
        try {
            board = await readBoard(conn.client, input.database_id);
        } catch (error) {
            return failure("unavailable", notionErrorMessage(error));
        }
        const fields = parseFieldMap(input.field_map, board.properties);
        if (!fields.ok) return failure("validation", fields.detail);
        const stages = parseStageMap(input.stage_map, stageOptions(board.properties, fields.value));
        if (!stages.ok) return failure("validation", stages.detail);

        const { data, error } = await db
            .from("notion_connections")
            .update({
                database_id: input.database_id,
                data_source_id: input.database_id,
                database_title: board.title,
                field_map: fields.value,
                stage_map: stages.value,
                poll_minutes: poll,
                updated_at: new Date().toISOString(),
            })
            .eq("org_id", orgId)
            .select("*")
            .single();
        if (error) throw error;
        await recordAudit(db, {
            userId: caller.userId,
            orgId,
            userEmail: caller.userEmail ?? null,
            action: "notion.mapping_saved",
            title: board.title,
            surface: "settings",
            detail: { fields: Object.keys(fields.value).length, stages: Object.keys(stages.value).length },
        });
        return ok(view(data as Row, true));
    } catch (error) {
        return internalFailure(error);
    }
}

export { NotionError };
