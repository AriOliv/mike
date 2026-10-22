// Access tokens for agents (doc 09 §3.1): created on the settings screen,
// shown once, stored as a SHA-256 hash, scoped to one workspace, expiring
// and revocable. A token always acts for a person.

import crypto from "crypto";
import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { PERSONAL_WORKSPACE, resolveWorkspaceFilter, type WorkspaceFilter } from "../../lib/workspace";
import { DEFAULT_SCOPES, MCP_SCOPES, type McpScope } from "./mcp.types";

const PREFIX = { pessoal: "mike_pat_", servico: "mike_svc_" } as const;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;
const MAX_ACTIVE_PER_USER = 20;
// Touch last_used_at at most once a minute per token.
const TOUCH_EVERY_MS = 60_000;
const DAY = 86_400_000;

export type TokenKind = keyof typeof PREFIX;

export type AccessTokenView = {
    id: string;
    name: string;
    kind: TokenKind;
    workspace: string;
    prefix: string;
    scopes: McpScope[];
    expires_at: string;
    revoked_at: string | null;
    last_used_at: string | null;
    last_client: string | null;
    created_at: string;
};

type TokenRow = {
    id: string;
    org_id: string | null;
    user_id: string;
    kind: TokenKind;
    name: string;
    token_prefix: string;
    scopes: string[];
    expires_at: string;
    revoked_at: string | null;
    last_used_at: string | null;
    last_client: string | null;
    created_at: string;
};

const COLUMNS =
    "id, org_id, user_id, kind, name, token_prefix, scopes, expires_at, revoked_at, last_used_at, last_client, created_at";

export function hashToken(token: string): string {
    return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function view(row: TokenRow): AccessTokenView {
    return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        workspace: row.org_id ?? PERSONAL_WORKSPACE,
        prefix: `${PREFIX[row.kind]}${row.token_prefix}…`,
        scopes: row.scopes.filter(isScope),
        expires_at: row.expires_at,
        revoked_at: row.revoked_at,
        last_used_at: row.last_used_at,
        last_client: row.last_client,
        created_at: row.created_at,
    };
}

function isScope(s: unknown): s is McpScope {
    return typeof s === "string" && (MCP_SCOPES as readonly string[]).includes(s);
}

type Caller = { userId: string; userEmail?: string | null };

/** The person's tokens, newest first, revoked ones included (the screen greys them). */
export async function listAccessTokens(db: Db, caller: Caller): Promise<ServiceResult<AccessTokenView[]>> {
    const { data, error } = await db
        .from("mcp_access_tokens")
        .select(COLUMNS)
        .eq("user_id", caller.userId)
        .eq("kind", "pessoal")
        .order("created_at", { ascending: false })
        .limit(100);
    if (error) return internalFailure(error);
    return ok(((data ?? []) as TokenRow[]).map(view));
}

/**
 * Creates a personal token. The plain token is returned once, here, and
 * never again. Body: `name`, `workspace` ("personal" or an org id the person
 * belongs to), `scopes?`, `expires_in_days?` (1..90, default 30).
 */
export async function createAccessToken(
    db: Db,
    caller: Caller,
    body: Record<string, unknown>,
    now: Date = new Date(),
): Promise<ServiceResult<{ token: string; access_token: AccessTokenView }>> {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80) return failure("validation", "Dê um nome de até 80 caracteres ao token.");

    const scopes = body.scopes === undefined ? [...DEFAULT_SCOPES] : body.scopes;
    if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every(isScope))
        return failure("validation", "Escolha ao menos uma permissão válida.");

    const days = body.expires_in_days === undefined ? DEFAULT_DAYS : Number(body.expires_in_days);
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS)
        return failure("validation", `A validade vai de 1 a ${MAX_DAYS} dias.`);

    let workspace: WorkspaceFilter;
    try {
        const resolved = await resolveWorkspaceFilter(db, caller.userId, body.workspace ?? PERSONAL_WORKSPACE);
        if (!resolved.ok)
            return failure(resolved.kind === "validation" ? "validation" : "not_found", "Workspace não encontrado.");
        workspace = resolved.workspace;
    } catch (error) {
        return internalFailure(error);
    }

    const { count, error: countError } = await db
        .from("mcp_access_tokens")
        .select("id", { count: "exact", head: true })
        .eq("user_id", caller.userId)
        .is("revoked_at", null)
        .gt("expires_at", now.toISOString());
    if (countError) return internalFailure(countError);
    if ((count ?? 0) >= MAX_ACTIVE_PER_USER)
        return failure("conflict", `Você já tem ${MAX_ACTIVE_PER_USER} tokens ativos. Revogue um antes de criar outro.`);

    const secret = crypto.randomBytes(32).toString("base64url");
    const token = `${PREFIX.pessoal}${secret}`;
    const { data, error } = await db
        .from("mcp_access_tokens")
        .insert({
            org_id: workspace === PERSONAL_WORKSPACE ? null : workspace,
            user_id: caller.userId,
            kind: "pessoal",
            name,
            token_hash: hashToken(token),
            token_prefix: secret.slice(0, 4),
            scopes: [...new Set(scopes)],
            expires_at: new Date(now.getTime() + days * DAY).toISOString(),
        })
        .select(COLUMNS)
        .single();
    if (error) return internalFailure(error);
    return ok({ token, access_token: view(data as TokenRow) });
}

/** Revokes one of the person's tokens. Idempotent; the row stays for the audit trail. */
export async function revokeAccessToken(
    db: Db,
    caller: Caller,
    tokenId: string,
    now: Date = new Date(),
): Promise<ServiceResult<AccessTokenView>> {
    if (!/^[0-9a-f-]{36}$/i.test(tokenId)) return failure("not_found", "Token não encontrado.");
    const { data: existing, error: readError } = await db
        .from("mcp_access_tokens")
        .select(COLUMNS)
        .eq("id", tokenId)
        .eq("user_id", caller.userId)
        .maybeSingle();
    if (readError) return internalFailure(readError);
    if (!existing) return failure("not_found", "Token não encontrado.");
    const row = existing as TokenRow;
    if (row.revoked_at) return ok(view(row));
    const { data, error } = await db
        .from("mcp_access_tokens")
        .update({ revoked_at: now.toISOString() })
        .eq("id", tokenId)
        .eq("user_id", caller.userId)
        .select(COLUMNS)
        .single();
    if (error) return internalFailure(error);
    return ok(view(data as TokenRow));
}

/** A valid token, resolved to the person it acts for. */
export type ResolvedToken = {
    id: string;
    userId: string;
    userEmail: string;
    displayName: string;
    orgId: string | null;
    scopes: McpScope[];
    lastUsedAt: string | null;
    /** The client that last used the token: the name stateless calls fall back to. */
    lastClient: string | null;
};

export type TokenRejection = "missing" | "invalid" | "expired" | "revoked" | "not_member";

/**
 * Checks a bearer token on every call: known hash, not revoked, not expired,
 * the owner still exists with a confirmed e-mail and no deletion pending, and
 * is still a member of the token's organization.
 */
export async function authenticateToken(
    db: Db,
    bearer: string | undefined,
    now: Date = new Date(),
): Promise<{ ok: true; token: ResolvedToken } | { ok: false; reason: TokenRejection }> {
    const raw = bearer?.startsWith("Bearer ") ? bearer.slice(7).trim() : "";
    if (!raw) return { ok: false, reason: "missing" };
    // Service tokens (act_as, doc 09 §3.2) are refused until the confirmed
    // chat identity link, the per-person limit and their audit ship.
    if (!raw.startsWith(PREFIX.pessoal)) return { ok: false, reason: "invalid" };

    const { data, error } = await db
        .from("mcp_access_tokens")
        .select(`${COLUMNS}`)
        .eq("token_hash", hashToken(raw))
        .maybeSingle();
    if (error) throw error;
    if (!data) return { ok: false, reason: "invalid" };
    const row = data as TokenRow;
    if (row.kind !== "pessoal") return { ok: false, reason: "invalid" };
    if (row.revoked_at) return { ok: false, reason: "revoked" };
    if (Date.parse(row.expires_at) <= now.getTime()) return { ok: false, reason: "expired" };

    const [{ data: user, error: userError }, profile, membership] = await Promise.all([
        db.auth.admin.getUserById(row.user_id),
        db
            .from("user_profiles")
            .select("display_name, account_deletion_requested_at")
            .eq("user_id", row.user_id)
            .maybeSingle(),
        row.org_id
            ? db.from("org_members").select("user_id").eq("org_id", row.org_id).eq("user_id", row.user_id).maybeSingle()
            : Promise.resolve({ data: { user_id: row.user_id }, error: null }),
    ]);
    if (userError) throw userError;
    if (profile.error) throw profile.error;
    if (membership.error) throw membership.error;
    const account = user?.user;
    const profileRow = profile.data as { display_name?: string | null; account_deletion_requested_at?: string | null } | null;
    if (!account || profileRow?.account_deletion_requested_at) return { ok: false, reason: "invalid" };
    if (!membership.data) return { ok: false, reason: "not_member" };

    // The same rule as the session middleware: an unconfirmed address matches
    // no e-mail-keyed grant.
    const userEmail = account.email && account.email_confirmed_at ? account.email.toLowerCase() : "";
    return {
        ok: true,
        token: {
            id: row.id,
            userId: row.user_id,
            userEmail,
            displayName: profileRow?.display_name?.trim() || userEmail || "usuário",
            orgId: row.org_id,
            scopes: row.scopes.filter(isScope),
            lastUsedAt: row.last_used_at,
            lastClient: row.last_client,
        },
    };
}

/** Records the last use, at most once a minute, never failing the call. */
export async function touchToken(
    db: Db,
    token: { id: string; lastUsedAt: string | null; lastClient: string | null },
    clientName: string,
    now: Date = new Date(),
): Promise<void> {
    const recent = token.lastUsedAt && now.getTime() - Date.parse(token.lastUsedAt) < TOUCH_EVERY_MS;
    if (recent && token.lastClient === clientName) return;
    const { error } = await db
        .from("mcp_access_tokens")
        .update({ last_used_at: now.toISOString(), last_client: clientName.slice(0, 80) })
        .eq("id", token.id);
    if (error) console.error("[mcp] touch token failed:", error.message);
}
