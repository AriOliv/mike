// OAuth 2.1 for MCP clients, end to end with the official SDK client: the
// 401 points to the metadata, the client registers itself (DCR), sends the
// person to consent with PKCE, trades the code for tokens, calls /mcp as the
// person, refreshes (rotating), and loses access once revoked. The consent
// screen is the frontend's; here the person's answer is the service call it
// makes. Fictional people only.

import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fakeDb";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../../../lib/supabase", () => ({ createServerSupabase: () => state.db }));
vi.mock("../../requests/requests.service", async (orig) => ({
    ...(await orig<object>()),
    whoAmI: vi.fn(async () => ({ ok: true, data: { configured: true, role: "team", area: null, areas: [] } })),
}));
vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn(async () => undefined) }));

import { buildOAuthRouter, mcpRouter } from "../mcp.routes";
import { decideAuthorization, exchangeRefresh, revokeOAuthToken } from "../mcp.oauth";
import { listAccessTokens, revokeAccessToken } from "../mcp.tokens";

const ana = { userId: "00000000-0000-4000-b000-000000000001", userEmail: "ana@exemplo.test" };
let http: Server;
let origin: string;
let tables: Record<string, Record<string, unknown>[]>;

function memoryProvider(redirect: string): OAuthClientProvider & { authUrl?: URL; saved?: OAuthTokens; info?: OAuthClientInformationMixed; verifier?: string } {
    const p: OAuthClientProvider & { authUrl?: URL; saved?: OAuthTokens; info?: OAuthClientInformationMixed; verifier?: string } = {
        get redirectUrl() {
            return redirect;
        },
        get clientMetadata() {
            return { client_name: "Claude (teste)", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
        },
        clientInformation: () => p.info,
        saveClientInformation: (i) => {
            p.info = i;
        },
        tokens: () => p.saved,
        saveTokens: (t) => {
            p.saved = t;
        },
        redirectToAuthorization: (url) => {
            p.authUrl = url;
        },
        saveCodeVerifier: (v) => {
            p.verifier = v;
        },
        codeVerifier: () => p.verifier!,
    };
    return p;
}

beforeAll(async () => {
    const app = express();
    // origin is known only after listen; the router reads MCP_PUBLIC_URL when built.
    let oauth: express.Router | null = null;
    app.use((req, res, next) => (oauth ? oauth(req, res, next) : next()));
    app.use("/mcp", express.json(), mcpRouter);
    await new Promise<void>((resolve) => {
        http = app.listen(0, "127.0.0.1", () => resolve());
    });
    origin = `http://localhost:${(http.address() as AddressInfo).port}`;
    process.env.MCP_PUBLIC_URL = `${origin}/mcp`;
    process.env.FRONTEND_URL = "https://mike.exemplo.test";
    oauth = buildOAuthRouter();
});
afterAll(() => new Promise<void>((resolve) => http.close(() => resolve())));

beforeEach(() => {
    const fake = fakeDb(
        { user_profiles: [{ user_id: ana.userId, display_name: "Ana Teste" }], org_members: [] },
        { [ana.userId]: { email: "ana@exemplo.test", email_confirmed_at: "2026-01-01T00:00:00Z" } },
    );
    state.db = fake.db;
    tables = fake.tables;
});

/** Runs the whole dance up to a connected client. */
async function connectWithOAuth() {
    const redirect = "http://127.0.0.1:65000/callback";
    const provider = memoryProvider(redirect);
    const url = new URL(`${origin}/mcp`);
    const first = new StreamableHTTPClientTransport(url, { authProvider: provider });
    const client = new Client({ name: "claude-ai", version: "1.0.0" });
    await expect(client.connect(first)).rejects.toThrow();
    // The client discovered the server, registered itself and wants the person to consent.
    expect(provider.authUrl).toBeDefined();
    const consent = await fetch(provider.authUrl!, { redirect: "manual" });
    expect(consent.status).toBe(302);
    const consentUrl = new URL(consent.headers.get("location")!);
    expect(consentUrl.origin + consentUrl.pathname).toBe("https://mike.exemplo.test/oauth/consentir");
    const requestId = consentUrl.searchParams.get("pedido")!;

    const decided = await decideAuthorization(state.db as never, ana, { requestId, approve: true, workspace: "personal" });
    if (!decided.ok) throw new Error(JSON.stringify(decided));
    const back = new URL(decided.data.redirect);
    expect(back.origin + back.pathname).toBe(redirect);
    const code = back.searchParams.get("code")!;

    await first.finishAuth(code);
    const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
    const connected = new Client({ name: "claude-ai", version: "1.0.0" });
    await connected.connect(transport);
    return { provider, client: connected, code, requestId };
}

describe("OAuth 2.1 for MCP clients", () => {
    it("publishes the metadata and points a 401 at it (RFC 9728, RFC 8414)", async () => {
        const unauth = await fetch(`${origin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
        expect(unauth.status).toBe(401);
        expect(unauth.headers.get("www-authenticate")).toBe(`Bearer realm="mike", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);

        const prm = await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json();
        expect(prm).toMatchObject({ resource: `${origin}/mcp`, authorization_servers: [`${origin}/`] });
        const as = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
        expect(as).toMatchObject({
            issuer: `${origin}/`,
            authorization_endpoint: `${origin}/oauth/authorize`,
            token_endpoint: `${origin}/oauth/token`,
            registration_endpoint: `${origin}/oauth/register`,
            revocation_endpoint: `${origin}/oauth/revoke`,
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
        });
        expect(as.scopes_supported).not.toContain("pedidos:write");
        expect(prm.scopes_supported).not.toContain("revisao:run");
    });

    it("connects with the official client: registers, consents with PKCE, and acts as the person", async () => {
        const { provider, client } = await connectWithOAuth();
        expect(provider.saved).toMatchObject({ token_type: "bearer", expires_in: 3600 });
        // Reading only: a connected app never gets writes or the bot's agente:config.
        expect(provider.saved!.scope!.split(" ").sort()).toEqual(
            ["base:ask", "contratos:read", "controle:read", "painel:read", "pedidos:read", "prazos:read", "radar:read", "revisao:read"],
        );
        expect(provider.saved!.access_token).toMatch(/^mike_oat_/);
        expect(provider.saved!.refresh_token).toMatch(/^mike_ort_/);
        const me = await client.callTool({ name: "mike_quem_sou", arguments: {} });
        expect(me.structuredContent).toMatchObject({ nome: "Ana Teste", email: "ana@exemplo.test", papel: "team", workspace: "personal" });

        // Nothing stored in clear; the client is public, with no secret.
        expect(JSON.stringify(tables)).not.toContain(provider.saved!.access_token);
        expect(JSON.stringify(tables)).not.toContain(provider.saved!.refresh_token);
        expect(tables.mcp_oauth_clients[0]).toMatchObject({ client_secret_hash: null, client_name: "Claude (teste)" });
        const access = tables.mcp_access_tokens.find((t) => t.kind === "oauth")!;
        expect(access).toMatchObject({ user_id: ana.userId, org_id: null, client_id: tables.mcp_oauth_clients[0].client_id, resource: `${origin}/mcp` });
        await client.close();
    });

    it("spends the code once, rotates the refresh token, and stops on revocation", async () => {
        const { provider, code } = await connectWithOAuth();
        const clientId = String(tables.mcp_oauth_clients[0].client_id);

        // The code was used by the client: a second exchange fails.
        const replay = await fetch(`${origin}/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: provider.verifier!, client_id: clientId, redirect_uri: "http://127.0.0.1:65000/callback" }),
        });
        expect(replay.status).toBe(400);
        expect((await replay.json()).error).toBe("invalid_grant");

        const firstRefresh = provider.saved!.refresh_token!;
        const firstAccess = provider.saved!.access_token;
        const renewed = await exchangeRefresh(state.db as never, { client_id: clientId }, firstRefresh, undefined);
        expect(renewed.refresh_token).not.toBe(firstRefresh);
        await expect(exchangeRefresh(state.db as never, { client_id: clientId }, firstRefresh, undefined)).rejects.toThrow("Invalid refresh token");
        await expect(exchangeRefresh(state.db as never, { client_id: "outro" }, renewed.refresh_token, undefined)).rejects.toThrow();
        await expect(exchangeRefresh(state.db as never, { client_id: clientId }, renewed.refresh_token, ["revisao:run"])).rejects.toThrow(/narrow/);
        // A narrower refresh is fine.
        const narrower = await exchangeRefresh(state.db as never, { client_id: clientId }, renewed.refresh_token, ["contratos:read"]);
        expect(narrower.scope).toBe("contratos:read");

        // The old access token went with its refresh token.
        const old = await fetch(`${origin}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${firstAccess}` },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        expect(old.status).toBe(401);

        await revokeOAuthToken(state.db as never, clientId, narrower.refresh_token);
        const after = await fetch(`${origin}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${narrower.access_token}` },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        expect(after.status).toBe(401);
    });

    it("shows the connected app once in the person's tokens, and disconnecting cuts it now", async () => {
        const { provider } = await connectWithOAuth();
        const list = await listAccessTokens(state.db as never, ana);
        if (!list.ok) throw new Error("list");
        const apps = list.data.filter((t) => t.kind === "aplicativo");
        expect(apps).toHaveLength(1);
        expect(apps[0]).toMatchObject({ name: "Claude (teste)", workspace: "personal" });
        // The hourly access tokens are not listed.
        expect(list.data.some((t) => t.kind === "oauth")).toBe(false);

        // Someone else cannot disconnect it.
        expect(await revokeAccessToken(state.db as never, { userId: "00000000-0000-4000-b000-000000000009" }, apps[0].id)).toMatchObject({ kind: "not_found" });
        expect((await revokeAccessToken(state.db as never, ana, apps[0].id)).ok).toBe(true);
        const call = await fetch(`${origin}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${provider.saved!.access_token}` },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        expect(call.status).toBe(401);
        await expect(exchangeRefresh(state.db as never, { client_id: String(tables.mcp_oauth_clients[0].client_id) }, provider.saved!.refresh_token!, undefined)).rejects.toThrow();
    });

    it("tells the client when the person says no, and a request is answered only once", async () => {
        const redirect = "http://127.0.0.1:65000/callback";
        const provider = memoryProvider(redirect);
        const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: provider });
        await expect(new Client({ name: "x", version: "1" }).connect(transport)).rejects.toThrow();
        const consent = await fetch(provider.authUrl!, { redirect: "manual" });
        const requestId = new URL(consent.headers.get("location")!).searchParams.get("pedido")!;
        const no = await decideAuthorization(state.db as never, ana, { requestId, approve: false });
        expect(no.ok && new URL(no.data.redirect).searchParams.get("error")).toBe("access_denied");
        expect(await decideAuthorization(state.db as never, ana, { requestId, approve: true })).toMatchObject({ kind: "not_found" });
        expect(tables.mcp_oauth_codes ?? []).toEqual([]);
    });

    it("refuses confidential clients, non-https redirects and unknown scopes", async () => {
        const register = (body: Record<string, unknown>) =>
            fetch(`${origin}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const confidential = await register({ redirect_uris: ["https://app.exemplo.test/cb"], token_endpoint_auth_method: "client_secret_post" });
        expect(confidential.status).toBe(400);
        const insecure = await register({ redirect_uris: ["http://app.exemplo.test/cb"], token_endpoint_auth_method: "none" });
        expect(insecure.status).toBe(400);
        const good = await register({ redirect_uris: ["https://app.exemplo.test/cb"], token_endpoint_auth_method: "none", client_name: "App" });
        expect(good.status).toBe(201);
        const client = await good.json();
        expect(client.client_secret).toBeUndefined();

        const authorize = new URL(`${origin}/oauth/authorize`);
        authorize.search = new URLSearchParams({
            client_id: client.client_id,
            redirect_uri: "https://app.exemplo.test/cb",
            response_type: "code",
            code_challenge: "abc",
            code_challenge_method: "S256",
            scope: "tudo:write",
        }).toString();
        const bad = await fetch(authorize, { redirect: "manual" });
        expect(new URL(bad.headers.get("location")!).searchParams.get("error")).toBe("invalid_scope");
        // A write scope is refused too, until the consent screen shows writes apart.
        authorize.searchParams.set("scope", "contratos:read pedidos:write");
        const write = await fetch(authorize, { redirect: "manual" });
        expect(new URL(write.headers.get("location")!).searchParams.get("error")).toBe("invalid_scope");
    });
});
