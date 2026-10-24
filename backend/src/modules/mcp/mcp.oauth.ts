// OAuth 2.1 authorization server for the MCP endpoint (doc 09 §3.4). The
// SDK's mcpAuthRouter speaks the protocol (metadata, dynamic client
// registration, PKCE S256 check, token and revocation endpoints, client
// authentication); this file is the Mike's side of it: where clients,
// pending consents, codes and tokens live, and what a token may do.
//
// The person consents on the Mike's own screen, signed in as usual. Codes
// and tokens are stored as SHA-256 only. An access token is a row of
// mcp_access_tokens (kind 'oauth', the client's id): /mcp resolves it like a
// personal token, with its scopes, the consenting person's role and the
// workspace chosen on the consent screen.

import crypto from "crypto";
import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { resolveWorkspaceFilter, PERSONAL_WORKSPACE } from "../../lib/workspace";
import { hashToken, requireEnrolledMfa } from "./mcp.tokens";
import { MCP_SCOPES, type McpScope } from "./mcp.types";

export const OAUTH_PREFIX = { access: "mike_oat_", refresh: "mike_ort_", code: "mike_oac_" } as const;
/** An access token lives an hour; the client renews it with the refresh token. */
export const ACCESS_TTL_S = 3600;
/** A refresh token lives 30 days and is rotated on every use. */
export const REFRESH_TTL_S = 30 * 86_400;
const CODE_TTL_MS = 60_000;
const REQUEST_TTL_MS = 10 * 60_000;

const secret = () => crypto.randomBytes(32).toString("base64url");

/**
 * The scopes OAuth grants, and what a client asking for nothing gets:
 * reading only. Clients ask for whatever the metadata lists, so the metadata
 * lists only these. Writes (:run, :write) wait for a consent screen that
 * shows them apart; agente:config is a service token's, never a person's
 * connected app's.
 */
export const OAUTH_DEFAULT_SCOPES: McpScope[] = MCP_SCOPES.filter(
    (s) => (s.endsWith(":read") || s === "base:ask") && s !== "agente:config",
);

export function parseScopes(requested: string[] | undefined): ServiceResult<McpScope[]> {
    const list = requested && requested.length > 0 ? requested : OAUTH_DEFAULT_SCOPES;
    const refused = list.filter((s) => !(OAUTH_DEFAULT_SCOPES as readonly string[]).includes(s));
    if (refused.length > 0)
        return failure("validation", `Permissões que um aplicativo conectado não pode pedir: ${refused.join(", ")}.`, "invalid_scope");
    return ok([...new Set(list)] as McpScope[]);
}

// ── clients (RFC 7591) ──────────────────────────────────────────────────────

export type OAuthClient = {
    client_id: string;
    client_secret?: string;
    client_secret_expires_at?: number;
    client_id_issued_at: number;
    client_name?: string;
    redirect_uris: string[];
    [key: string]: unknown;
};

type ClientRow = {
    client_id: string;
    client_secret_hash: string | null;
    client_name: string | null;
    redirect_uris: string[];
    metadata: Record<string, unknown>;
    client_id_issued_at: string;
};

/**
 * The client as the SDK reads it. Only public clients are registered (PKCE,
 * no secret), so the record never carries a client_secret and the SDK's
 * client authentication treats every client as public.
 */
export async function getClient(db: Db, clientId: string): Promise<OAuthClient | undefined> {
    const { data, error } = await db.from("mcp_oauth_clients").select("*").eq("client_id", clientId).maybeSingle();
    if (error) throw error;
    const row = data as ClientRow | null;
    if (!row) return undefined;
    return {
        ...row.metadata,
        client_id: row.client_id,
        client_name: row.client_name ?? undefined,
        redirect_uris: row.redirect_uris,
        token_endpoint_auth_method: "none",
        client_id_issued_at: Math.floor(Date.parse(row.client_id_issued_at) / 1000),
    };
}

/** Only https redirects, or loopback http for a desktop client (OAuth 2.1 §8.4.2). */
export function acceptableRedirect(uri: string): boolean {
    try {
        const u = new URL(uri);
        if (u.hash) return false;
        if (u.protocol === "https:") return true;
        return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    } catch {
        return false;
    }
}

export async function registerClient(
    db: Db,
    client: Omit<OAuthClient, "client_id" | "client_id_issued_at">,
): Promise<OAuthClient> {
    // Public clients only (OAuth 2.1 with PKCE): the Mike keeps no client secret.
    if ((client as Record<string, unknown>).token_endpoint_auth_method !== "none") throw new Error("public_client_only");
    const redirects: string[] = Array.isArray(client.redirect_uris) ? client.redirect_uris.map(String) : [];
    if (redirects.length === 0 || redirects.length > 10 || !redirects.every(acceptableRedirect))
        throw new Error("invalid_redirect_uri");
    const clientId = `mike_cli_${crypto.randomBytes(12).toString("base64url")}`;
    const { client_secret: _secret, client_secret_expires_at: _expiry, client_name, redirect_uris: _uris, ...rest } = client as Record<string, unknown>;
    const { error } = await db.from("mcp_oauth_clients").insert({
        client_id: clientId,
        client_secret_hash: null,
        client_name: typeof client_name === "string" ? client_name.slice(0, 100) : null,
        redirect_uris: redirects,
        metadata: rest,
    });
    if (error) throw error;
    return {
        ...rest,
        ...(typeof client_name === "string" ? { client_name } : {}),
        token_endpoint_auth_method: "none",
        redirect_uris: redirects,
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
    };
}

// ── authorization: consent on the Mike's own screen ────────────────────────

export type PendingAuthorization = {
    id: string;
    client: { client_id: string; client_name: string | null; redirect_host: string };
    scopes: McpScope[];
    expires_at: string;
};

/** Stores the client's request and returns where the person consents. */
export async function startAuthorization(
    db: Db,
    input: { clientId: string; redirectUri: string; codeChallenge: string; scopes: string[] | undefined; state?: string; resource?: URL },
    consentUrl: (requestId: string) => string,
    now: Date = new Date(),
): Promise<ServiceResult<string>> {
    const scopes = parseScopes(input.scopes);
    if (!scopes.ok) return scopes;
    const { data, error } = await db
        .from("mcp_oauth_requests")
        .insert({
            client_id: input.clientId,
            redirect_uri: input.redirectUri,
            code_challenge: input.codeChallenge,
            scopes: scopes.data,
            state: input.state ?? null,
            resource: input.resource?.href ?? null,
            expires_at: new Date(now.getTime() + REQUEST_TTL_MS).toISOString(),
        })
        .select("id")
        .single();
    if (error) return internalFailure(error);
    return ok(consentUrl((data as { id: string }).id));
}

type RequestRow = {
    id: string;
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    scopes: string[];
    state: string | null;
    resource: string | null;
    expires_at: string;
    decided_at: string | null;
};

async function openRequest(db: Db, requestId: string, now: Date): Promise<ServiceResult<RequestRow>> {
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) return failure("not_found", "Pedido de acesso não encontrado ou expirado.");
    const { data, error } = await db.from("mcp_oauth_requests").select("*").eq("id", requestId).maybeSingle();
    if (error) return internalFailure(error);
    const row = data as RequestRow | null;
    if (!row || row.decided_at || Date.parse(row.expires_at) <= now.getTime())
        return failure("not_found", "Pedido de acesso não encontrado ou expirado. Volte ao aplicativo e conecte de novo.");
    return ok(row);
}

/** What the consent screen shows: who asks, for what, to send the answer where. */
export async function describeAuthorization(db: Db, requestId: string, now: Date = new Date()): Promise<ServiceResult<PendingAuthorization>> {
    const req = await openRequest(db, requestId, now);
    if (!req.ok) return req;
    const client = await getClient(db, req.data.client_id);
    if (!client) return failure("not_found", "Aplicativo não encontrado.");
    return ok({
        id: req.data.id,
        client: { client_id: client.client_id, client_name: client.client_name ?? null, redirect_host: new URL(req.data.redirect_uri).host },
        scopes: req.data.scopes as McpScope[],
        expires_at: req.data.expires_at,
    });
}

/**
 * The person's answer. Approving issues a single-use code bound to them and
 * to the workspace they chose; denying tells the client so. Either way the
 * request is spent, atomically, and the browser goes back to the client.
 */
export async function decideAuthorization(
    db: Db,
    caller: { userId: string },
    input: { requestId: string; approve: boolean; workspace?: unknown },
    now: Date = new Date(),
): Promise<ServiceResult<{ redirect: string }>> {
    const req = await openRequest(db, input.requestId, now);
    if (!req.ok) return req;
    // Connecting an app gives what a personal token gives, so the same rule:
    // never from an account protected by a password alone. Checked before the
    // request is spent, so the person can enrol a second factor and approve.
    if (input.approve) {
        const mfa = await requireEnrolledMfa(db, caller.userId);
        if (mfa) return mfa;
    }
    const { data: spent, error: spendError } = await db
        .from("mcp_oauth_requests")
        .update({ decided_at: now.toISOString() })
        .eq("id", req.data.id)
        .is("decided_at", null)
        .select("id");
    if (spendError) return internalFailure(spendError);
    if (((spent ?? []) as unknown[]).length !== 1) return failure("not_found", "Este pedido de acesso já foi respondido.");

    const back = new URL(req.data.redirect_uri);
    if (req.data.state) back.searchParams.set("state", req.data.state);
    if (!input.approve) {
        back.searchParams.set("error", "access_denied");
        return ok({ redirect: back.href });
    }
    let orgId: string | null = null;
    try {
        const ws = await resolveWorkspaceFilter(db, caller.userId, input.workspace ?? PERSONAL_WORKSPACE);
        if (!ws.ok) return failure("validation", "Escolha um espaço do qual você faz parte.");
        orgId = ws.workspace === PERSONAL_WORKSPACE ? null : ws.workspace;
    } catch (error) {
        return internalFailure(error);
    }
    const code = `${OAUTH_PREFIX.code}${secret()}`;
    const { error } = await db.from("mcp_oauth_codes").insert({
        // A 256-bit random code, not a password a person chose: SHA-256 is the right hash.
        code_hash: hashToken(code),
        client_id: req.data.client_id,
        user_id: caller.userId,
        org_id: orgId,
        redirect_uri: req.data.redirect_uri,
        code_challenge: req.data.code_challenge,
        scopes: req.data.scopes,
        resource: req.data.resource,
        expires_at: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
    });
    if (error) return internalFailure(error);
    back.searchParams.set("code", code);
    return ok({ redirect: back.href });
}

// ── codes and tokens ────────────────────────────────────────────────────────

type CodeRow = {
    code_hash: string;
    client_id: string;
    user_id: string;
    org_id: string | null;
    redirect_uri: string;
    code_challenge: string;
    scopes: string[];
    resource: string | null;
    expires_at: string;
    used_at: string | null;
};

export class OAuthGrantError extends Error {}

async function liveCode(db: Db, clientId: string, code: string, now: Date): Promise<CodeRow> {
    const { data, error } = await db.from("mcp_oauth_codes").select("*").eq("code_hash", hashToken(code)).maybeSingle();
    if (error) throw error;
    const row = data as CodeRow | null;
    if (!row || row.client_id !== clientId || row.used_at || Date.parse(row.expires_at) <= now.getTime())
        throw new OAuthGrantError("Invalid authorization code");
    return row;
}

/** The PKCE challenge stored with the code; the SDK checks the verifier against it. */
export async function challengeFor(db: Db, clientId: string, code: string, now: Date = new Date()): Promise<string> {
    return (await liveCode(db, clientId, code, now)).code_challenge;
}

export type IssuedTokens = { access_token: string; token_type: "bearer"; expires_in: number; refresh_token: string; scope: string };

async function issue(
    db: Db,
    grant: { clientId: string; clientName: string | null; userId: string; orgId: string | null; scopes: string[]; resource: string | null },
    now: Date,
): Promise<IssuedTokens> {
    const access = `${OAUTH_PREFIX.access}${secret()}`;
    const refresh = `${OAUTH_PREFIX.refresh}${secret()}`;
    const name = (grant.clientName || grant.clientId).slice(0, 80);
    const base = { org_id: grant.orgId, user_id: grant.userId, name, scopes: grant.scopes, client_id: grant.clientId, resource: grant.resource };
    const { data: accessRow, error: accessError } = await db
        .from("mcp_access_tokens")
        .insert({
            ...base,
            kind: "oauth",
            token_hash: hashToken(access),
            token_prefix: access.slice(OAUTH_PREFIX.access.length, OAUTH_PREFIX.access.length + 4),
            expires_at: new Date(now.getTime() + ACCESS_TTL_S * 1000).toISOString(),
        })
        .select("id")
        .single();
    if (accessError) throw accessError;
    const { error: refreshError } = await db.from("mcp_access_tokens").insert({
        ...base,
        kind: "oauth_refresh",
        token_hash: hashToken(refresh),
        token_prefix: refresh.slice(OAUTH_PREFIX.refresh.length, OAUTH_PREFIX.refresh.length + 4),
        refresh_of: (accessRow as { id: string }).id,
        expires_at: new Date(now.getTime() + REFRESH_TTL_S * 1000).toISOString(),
    });
    if (refreshError) throw refreshError;
    return { access_token: access, token_type: "bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: grant.scopes.join(" ") };
}

/** Code → tokens. Single use: a second exchange of the same code fails. */
export async function exchangeCode(
    db: Db,
    client: { client_id: string; client_name?: string },
    code: string,
    redirectUri: string | undefined,
    resource: URL | undefined,
    now: Date = new Date(),
): Promise<IssuedTokens> {
    const row = await liveCode(db, client.client_id, code, now);
    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) throw new OAuthGrantError("redirect_uri does not match");
    if (resource && row.resource && resource.href !== row.resource) throw new OAuthGrantError("resource does not match");
    const { data: spent, error } = await db
        .from("mcp_oauth_codes")
        .update({ used_at: now.toISOString() })
        .eq("code_hash", row.code_hash)
        .is("used_at", null)
        .select("code_hash");
    if (error) throw error;
    if (((spent ?? []) as unknown[]).length !== 1) throw new OAuthGrantError("Invalid authorization code");
    return issue(
        db,
        { clientId: row.client_id, clientName: client.client_name ?? null, userId: row.user_id, orgId: row.org_id, scopes: row.scopes, resource: row.resource },
        now,
    );
}

type TokenRow = {
    id: string;
    kind: string;
    client_id: string | null;
    user_id: string;
    org_id: string | null;
    scopes: string[];
    resource: string | null;
    revoked_at: string | null;
    expires_at: string;
};

/**
 * Refresh token → new pair. The refresh token is rotated: the one used is
 * revoked, and so is its access token. Scopes can only narrow.
 */
export async function exchangeRefresh(
    db: Db,
    client: { client_id: string; client_name?: string },
    refreshToken: string,
    scopes: string[] | undefined,
    now: Date = new Date(),
): Promise<IssuedTokens> {
    const { data, error } = await db.from("mcp_access_tokens").select("*").eq("token_hash", hashToken(refreshToken)).maybeSingle();
    if (error) throw error;
    const row = data as (TokenRow & { refresh_of: string | null }) | null;
    if (!row || row.kind !== "oauth_refresh" || row.client_id !== client.client_id || row.revoked_at || Date.parse(row.expires_at) <= now.getTime())
        throw new OAuthGrantError("Invalid refresh token");
    const narrowed = scopes && scopes.length > 0 ? scopes : row.scopes;
    if (!narrowed.every((s) => row.scopes.includes(s))) throw new OAuthGrantError("A refresh can only narrow the scopes");
    const { data: spent, error: spendError } = await db
        .from("mcp_access_tokens")
        .update({ revoked_at: now.toISOString() })
        .eq("id", row.id)
        .is("revoked_at", null)
        .select("id");
    if (spendError) throw spendError;
    if (((spent ?? []) as unknown[]).length !== 1) throw new OAuthGrantError("Invalid refresh token");
    if (row.refresh_of) await db.from("mcp_access_tokens").update({ revoked_at: now.toISOString() }).eq("id", row.refresh_of).is("revoked_at", null);
    return issue(
        db,
        { clientId: row.client_id!, clientName: client.client_name ?? null, userId: row.user_id, orgId: row.org_id, scopes: narrowed, resource: row.resource },
        now,
    );
}

/** RFC 7009: revoke an access or refresh token of this client. Unknown tokens are not an error. */
export async function revokeOAuthToken(db: Db, clientId: string, token: string, now: Date = new Date()): Promise<void> {
    const { data, error } = await db.from("mcp_access_tokens").select("*").eq("token_hash", hashToken(token)).maybeSingle();
    if (error) throw error;
    const row = data as (TokenRow & { refresh_of: string | null }) | null;
    if (!row || row.client_id !== clientId) return;
    const at = now.toISOString();
    await db.from("mcp_access_tokens").update({ revoked_at: at }).eq("id", row.id).is("revoked_at", null);
    // Revoking the refresh token ends the grant: its access token goes too.
    if (row.kind === "oauth_refresh" && row.refresh_of)
        await db.from("mcp_access_tokens").update({ revoked_at: at }).eq("id", row.refresh_of).is("revoked_at", null);
}

/** For the SDK's bearer middleware; /mcp itself resolves tokens through checkToken. */
export function oauthTokenPrefix(token: string): boolean {
    return token.startsWith(OAUTH_PREFIX.access);
}


// ── configuration ───────────────────────────────────────────────────────────

/**
 * The public address of /mcp (MCP_PUBLIC_URL, e.g. https://host/mcp). OAuth
 * is on only when it is set: the issuer, the protected-resource metadata and
 * the token's audience all derive from it, and a deployment that keeps /mcp
 * behind an identity proxy simply leaves it unset.
 */
export function oauthConfig(env: NodeJS.ProcessEnv = process.env):
    | { enabled: false }
    | { enabled: true; resource: URL; issuer: URL; consentUrl: (requestId: string) => string } {
    const raw = env.MCP_PUBLIC_URL?.trim();
    if (!raw) return { enabled: false };
    const resource = new URL(raw.replace(/\/+$/, ""));
    if (resource.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(resource.hostname))
        throw new Error("MCP_PUBLIC_URL must be https");
    const issuer = new URL(resource.origin);
    const app = (env.FRONTEND_URL?.trim() || resource.origin).replace(/\/+$/, "");
    return {
        enabled: true,
        resource,
        issuer,
        consentUrl: (requestId) => `${app}/oauth/consentir?pedido=${encodeURIComponent(requestId)}`,
    };
}
