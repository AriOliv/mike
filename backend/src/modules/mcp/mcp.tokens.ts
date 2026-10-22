// Access tokens for agents (doc 09 §3.1): created on the settings screen,
// shown once, stored as a SHA-256 hash, scoped to one workspace, expiring
// and revocable. A token always acts for a person.

import crypto from "crypto";
import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { getOrgRole } from "../../lib/access";
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
    can_act_as: boolean;
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
    can_act_as?: boolean;
    created_at: string;
};

const COLUMNS =
    "id, org_id, user_id, kind, name, token_prefix, scopes, expires_at, revoked_at, last_used_at, last_client, can_act_as, created_at";

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
        can_act_as: row.can_act_as === true,
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

    const mfa = await requireEnrolledMfa(db, caller.userId);
    if (mfa) return mfa;

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
        .eq("kind", "pessoal")
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

/**
 * A token reads contracts outside the browser: it never comes from an account
 * protected by a password alone. The route has already asked for the second
 * factor of whoever enrolled one (requireMfaIfEnrolled); this refuses the
 * accounts that have none.
 */
async function requireEnrolledMfa(db: Db, userId: string): Promise<ServiceResult<never> | null> {
    const { data: account, error } = await db.auth.admin.getUserById(userId);
    if (error) return internalFailure(error);
    const hasTotp = (account.user?.factors ?? []).some((f) => f.factor_type === "totp" && f.status === "verified");
    return hasTotp
        ? null
        : failure(
              "forbidden",
              "Ative a verificação em duas etapas em Configurações → Segurança para criar um token de acesso.",
              "mfa_enrollment_required",
          );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SERVICE_PER_ORG = 10;

/** Only an owner or admin of the organization manages its service tokens. */
async function requireOrgAdmin(db: Db, userId: string, orgId: unknown): Promise<ServiceResult<string>> {
    if (typeof orgId !== "string" || !UUID.test(orgId)) return failure("validation", "Escolha a organização do token.");
    const role = await getOrgRole(userId, orgId, db);
    if (role !== "owner" && role !== "admin")
        return failure("forbidden", "Só quem administra a organização cria e revoga tokens de serviço.");
    return ok(orgId.toLowerCase());
}

/**
 * Creates a service token (doc 09 §3.2): one organization, made by its owner
 * or an admin, acting for the members who confirmed their chat identity.
 * `can_act_as` must be asked for explicitly; without it the token acts for
 * no one. Body: `name`, `org_id`, `scopes`, `can_act_as`, `expires_in_days?`.
 */
export async function createServiceToken(
    db: Db,
    caller: Caller,
    body: Record<string, unknown>,
    now: Date = new Date(),
): Promise<ServiceResult<{ token: string; access_token: AccessTokenView }>> {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80) return failure("validation", "Dê um nome de até 80 caracteres ao token.");
    const scopes = body.scopes;
    if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every(isScope))
        return failure("validation", "Escolha ao menos uma permissão válida.");
    if (body.can_act_as !== true)
        return failure("validation", "Marque que o token age em nome das pessoas que confirmarem o vínculo.");
    const days = body.expires_in_days === undefined ? DEFAULT_DAYS : Number(body.expires_in_days);
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS)
        return failure("validation", `A validade vai de 1 a ${MAX_DAYS} dias.`);
    try {
        const org = await requireOrgAdmin(db, caller.userId, body.org_id);
        if (!org.ok) return org;
        const mfa = await requireEnrolledMfa(db, caller.userId);
        if (mfa) return mfa;
        const { count, error: countError } = await db
            .from("mcp_access_tokens")
            .select("id", { count: "exact", head: true })
            .eq("org_id", org.data)
            .eq("kind", "servico")
            .is("revoked_at", null)
            .gt("expires_at", now.toISOString());
        if (countError) return internalFailure(countError);
        if ((count ?? 0) >= MAX_SERVICE_PER_ORG)
            return failure("conflict", `A organização já tem ${MAX_SERVICE_PER_ORG} tokens de serviço ativos. Revogue um antes.`);

        const secret = crypto.randomBytes(32).toString("base64url");
        const token = `${PREFIX.servico}${secret}`;
        const { data, error } = await db
            .from("mcp_access_tokens")
            .insert({
                org_id: org.data,
                user_id: caller.userId,
                kind: "servico",
                name,
                token_hash: hashToken(token),
                token_prefix: secret.slice(0, 4),
                scopes: [...new Set(scopes)],
                can_act_as: true,
                expires_at: new Date(now.getTime() + days * DAY).toISOString(),
            })
            .select(COLUMNS)
            .single();
        if (error) return internalFailure(error);
        return ok({ token, access_token: view(data as TokenRow) });
    } catch (error) {
        return internalFailure(error);
    }
}

/** The organization's service tokens, for its owners and admins. */
export async function listServiceTokens(db: Db, caller: Caller, orgId: string): Promise<ServiceResult<AccessTokenView[]>> {
    try {
        const org = await requireOrgAdmin(db, caller.userId, orgId);
        if (!org.ok) return org;
        const { data, error } = await db
            .from("mcp_access_tokens")
            .select(COLUMNS)
            .eq("org_id", org.data)
            .eq("kind", "servico")
            .order("created_at", { ascending: false })
            .limit(100);
        if (error) return internalFailure(error);
        return ok(((data ?? []) as TokenRow[]).map(view));
    } catch (error) {
        return internalFailure(error);
    }
}

/**
 * Revokes a service token. Any owner or admin of its organization can, not
 * only whoever made it: a token must not outlive the admin who left.
 */
export async function revokeServiceToken(
    db: Db,
    caller: Caller,
    tokenId: string,
    now: Date = new Date(),
): Promise<ServiceResult<AccessTokenView>> {
    if (!UUID.test(tokenId)) return failure("not_found", "Token não encontrado.");
    try {
        const { data: existing, error: readError } = await db
            .from("mcp_access_tokens")
            .select(COLUMNS)
            .eq("id", tokenId)
            .eq("kind", "servico")
            .maybeSingle();
        if (readError) return internalFailure(readError);
        const row = existing as TokenRow | null;
        if (!row?.org_id) return failure("not_found", "Token não encontrado.");
        const org = await requireOrgAdmin(db, caller.userId, row.org_id);
        // Not an admin there reads as missing: a 403 would confirm the token exists.
        if (!org.ok) return org.kind === "forbidden" ? failure("not_found", "Token não encontrado.") : org;
        if (row.revoked_at) return ok(view(row));
        const { data, error } = await db
            .from("mcp_access_tokens")
            .update({ revoked_at: now.toISOString() })
            .eq("id", tokenId)
            .eq("kind", "servico")
            .select(COLUMNS)
            .single();
        if (error) return internalFailure(error);
        return ok(view(data as TokenRow));
    } catch (error) {
        return internalFailure(error);
    }
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
        .eq("kind", "pessoal")
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
        .eq("kind", "pessoal")
        .select(COLUMNS)
        .single();
    if (error) return internalFailure(error);
    return ok(view(data as TokenRow));
}

/** A valid token, resolved to the person it acts for. */
export type ResolvedToken = {
    id: string;
    kind: TokenKind;
    userId: string;
    userEmail: string;
    displayName: string;
    orgId: string | null;
    scopes: McpScope[];
    lastUsedAt: string | null;
    /** The client that last used the token: the name stateless calls fall back to. */
    lastClient: string | null;
    /** For a service token: the confirmed chat identity link it acted through. */
    linkId: string | null;
};

export type { TokenRow };

export type TokenRejection = "missing" | "invalid" | "expired" | "revoked" | "not_member";

/** A service token that may act for someone, before the person is known. */
export type ServiceToken = {
    id: string;
    orgId: string;
    scopes: McpScope[];
    lastUsedAt: string | null;
    lastClient: string | null;
};

type TokenCheck =
    | { ok: true; kind: "pessoal"; row: TokenRow; scopes: McpScope[] }
    | { ok: true; kind: "servico"; token: ServiceToken }
    | { ok: false; reason: TokenRejection };

/** The bearer's token row: known hash, right kind for its prefix, not revoked, not expired. */
export async function checkToken(db: Db, bearer: string | undefined, now: Date = new Date()): Promise<TokenCheck> {
    const raw = bearer?.startsWith("Bearer ") ? bearer.slice(7).trim() : "";
    if (!raw) return { ok: false, reason: "missing" };
    const kind = raw.startsWith(PREFIX.pessoal) ? "pessoal" : raw.startsWith(PREFIX.servico) ? "servico" : null;
    if (!kind) return { ok: false, reason: "invalid" };

    const { data, error } = await db
        .from("mcp_access_tokens")
        .select(`${COLUMNS}`)
        .eq("token_hash", hashToken(raw))
        .maybeSingle();
    if (error) throw error;
    if (!data) return { ok: false, reason: "invalid" };
    const row = data as TokenRow;
    if (row.kind !== kind) return { ok: false, reason: "invalid" };
    if (row.revoked_at) return { ok: false, reason: "revoked" };
    if (Date.parse(row.expires_at) <= now.getTime()) return { ok: false, reason: "expired" };
    if (kind === "pessoal") return { ok: true, kind, row, scopes: row.scopes.filter(isScope) };
    // A service token that was not granted act_as has nothing to do here: it
    // acts for no one, and the server holds no data of its own to show.
    if (row.can_act_as !== true || !row.org_id) return { ok: false, reason: "invalid" };
    return {
        ok: true,
        kind,
        token: { id: row.id, orgId: row.org_id, scopes: row.scopes.filter(isScope), lastUsedAt: row.last_used_at, lastClient: row.last_client },
    };
}

/**
 * The person a token acts as, checked on every call: the account exists, is
 * not being deleted, and still belongs to `orgId` (when there is one).
 */
export async function resolvePerson(
    db: Db,
    userId: string,
    orgId: string | null,
): Promise<{ ok: true; userEmail: string; displayName: string } | { ok: false; reason: "invalid" | "not_member" }> {
    const [{ data: user, error: userError }, profile, membership] = await Promise.all([
        db.auth.admin.getUserById(userId),
        db
            .from("user_profiles")
            .select("display_name, account_deletion_requested_at")
            .eq("user_id", userId)
            .maybeSingle(),
        orgId
            ? db.from("org_members").select("user_id").eq("org_id", orgId).eq("user_id", userId).maybeSingle()
            : Promise.resolve({ data: { user_id: userId }, error: null }),
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
    return { ok: true, userEmail, displayName: profileRow?.display_name?.trim() || userEmail || "usuário" };
}

/** A personal token, resolved to its owner. Service tokens go through the identity link (mcp.service). */
export async function authenticateToken(
    db: Db,
    bearer: string | undefined,
    now: Date = new Date(),
): Promise<{ ok: true; token: ResolvedToken } | { ok: false; reason: TokenRejection }> {
    const checked = await checkToken(db, bearer, now);
    if (!checked.ok) return checked;
    if (checked.kind !== "pessoal") return { ok: false, reason: "invalid" };
    const row = checked.row;
    const person = await resolvePerson(db, row.user_id, row.org_id);
    if (!person.ok) return person;
    return {
        ok: true,
        token: {
            id: row.id,
            kind: "pessoal",
            userId: row.user_id,
            userEmail: person.userEmail,
            displayName: person.displayName,
            orgId: row.org_id,
            scopes: checked.scopes,
            lastUsedAt: row.last_used_at,
            lastClient: row.last_client,
            linkId: null,
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
