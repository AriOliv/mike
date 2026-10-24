// HTTP layer of the MCP module: the server agents call at /mcp (bearer
// access token, never the session) and the settings screen's token routes at
// /mcp-tokens (session auth, MFA when the person enrolled it).

import { Router } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createOAuthMetadata, mcpAuthMetadataRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { InvalidGrantError, InvalidClientMetadataError, InvalidScopeError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import rateLimit from "express-rate-limit";
import { requireAuth, requireMfaIfEnrolled } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure } from "../../lib/serviceResult";
import { hashToken } from "./mcp.tokens";
import {
    buildServer,
    challengeFor,
    decideAuthorization,
    describeAuthorization,
    exchangeCode,
    exchangeRefresh,
    getClient,
    oauthConfig,
    OAuthGrantError,
    OAUTH_DEFAULT_SCOPES,
    registerClient,
    revokeOAuthToken,
    startAuthorization,
    createAccessToken,
    createServiceToken,
    listAccessTokens,
    listServiceTokens,
    openMcpCall,
    revokeAccessToken,
    revokeServiceToken,
} from "./mcp.service";

const caller = (res: { locals: Record<string, unknown> }) => ({
    userId: res.locals.userId as string,
    userEmail: res.locals.userEmail as string | undefined,
});

// 60 calls a minute per token (doc 09 §2); the shared per-IP budget skips
// /mcp, so one agent's burst never locks a whole office out. Keyed by the
// token's hash, never the token.
const perToken = rateLimit({
    windowMs: 60_000,
    max: Number(process.env.MCP_RATE_LIMIT_PER_MINUTE ?? 60),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `mcp:${hashToken(req.get("authorization") ?? "anon").slice(0, 32)}`,
    message: {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Muitas chamadas. Espere um minuto e tente de novo." },
        id: null,
    },
});

export const mcpRouter = Router();

mcpRouter.post(
    "/",
    perToken,
    asyncRoute(async (req, res) => {
        const db = createServerSupabase();
        const opened = await openMcpCall(db, {
            authorization: req.get("authorization"),
            body: req.body,
            userAgent: req.get("user-agent"),
            actingUser: req.get("x-mike-acting-user"),
        });
        if (!opened.ok) {
            if (opened.kind === "auth") {
                if (opened.auth.status === 401) {
                    // RFC 9728: tell an OAuth-capable client where to learn how to sign in.
                    const metadata = resourceMetadataUrl();
                    res.setHeader(
                        "WWW-Authenticate",
                        metadata ? `Bearer realm="mike", resource_metadata="${metadata}"` : 'Bearer realm="mike"',
                    );
                }
                return void res.status(opened.auth.status).json({
                    jsonrpc: "2.0",
                    error: {
                        code: -32001,
                        message: opened.auth.message,
                        // The bot sends the person the link to confirm who they are.
                        ...(opened.auth.code ? { data: { code: opened.auth.code, ...(opened.auth.link ? { link: opened.auth.link } : {}) } } : {}),
                    },
                    id: null,
                });
            }
            return void sendServiceFailure(res, opened);
        }
        const server = buildServer(opened.data);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
            void transport.close();
            void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    }),
);

// Stateless: no notification stream and no session to end (doc 09 §2).
mcpRouter.all("/", (_req, res) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "O servidor MCP do Mike aceita só POST (sem sessão)." },
        id: null,
    });
});

mcpRouter.use(routerErrorHandler("[mcp]"));

export const mcpTokensRouter = Router();

mcpTokensRouter.get(
    "/",
    requireAuth,
    asyncRoute(async (_req, res) => {
        const result = await listAccessTokens(createServerSupabase(), caller(res));
        if (!result.ok) return void sendServiceFailure(res, result);
        res.json({ tokens: result.data });
    }),
);

mcpTokensRouter.post(
    "/",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
        const result = await createAccessToken(createServerSupabase(), caller(res), (req.body ?? {}) as Record<string, unknown>);
        if (!result.ok) return void sendServiceFailure(res, result);
        res.setHeader("Cache-Control", "no-store");
        res.status(201).json(result.data);
    }),
);

// Service tokens (doc 09 §3.2), for an organization's owners and admins.
// Registered before "/:tokenId" so "servico" is never read as an id.
mcpTokensRouter.get(
    "/servico",
    requireAuth,
    asyncRoute(async (req, res) => {
        const result = await listServiceTokens(createServerSupabase(), caller(res), String(req.query.org_id ?? ""));
        if (!result.ok) return void sendServiceFailure(res, result);
        res.json({ tokens: result.data });
    }),
);

mcpTokensRouter.post(
    "/servico",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
        const result = await createServiceToken(createServerSupabase(), caller(res), (req.body ?? {}) as Record<string, unknown>);
        if (!result.ok) return void sendServiceFailure(res, result);
        res.setHeader("Cache-Control", "no-store");
        res.status(201).json(result.data);
    }),
);

mcpTokensRouter.delete(
    "/servico/:tokenId",
    requireAuth,
    asyncRoute(async (req, res) => {
        const result = await revokeServiceToken(createServerSupabase(), caller(res), String(req.params.tokenId));
        if (!result.ok) return void sendServiceFailure(res, result);
        res.json(result.data);
    }),
);

mcpTokensRouter.delete(
    "/:tokenId",
    requireAuth,
    asyncRoute(async (req, res) => {
        const result = await revokeAccessToken(createServerSupabase(), caller(res), String(req.params.tokenId));
        if (!result.ok) return void sendServiceFailure(res, result);
        res.json(result.data);
    }),
);

mcpTokensRouter.use(routerErrorHandler("[mcp-tokens]"));

// ── OAuth 2.1 (doc 09 §3.4) ─────────────────────────────────────────────────
//
// The SDK's handlers speak the protocol at /oauth/register, /authorize,
// /token and /revoke, and publish the metadata under /.well-known; the
// provider below is the Mike's side. Off unless MCP_PUBLIC_URL is set.

/** Maps the Mike's errors onto the OAuth error the SDK's handlers answer with. */
async function oauthCall<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        if (error instanceof OAuthGrantError) throw new InvalidGrantError(error.message);
        if (error instanceof Error && error.message === "invalid_redirect_uri")
            throw new InvalidClientMetadataError("redirect_uris must be https, or http on a loopback address");
        if (error instanceof Error && error.message === "public_client_only")
            throw new InvalidClientMetadataError("Only public clients (token_endpoint_auth_method: none) with PKCE are supported");
        console.error("[mcp-oauth] failed:", error instanceof Error ? error.message : error);
        throw new ServerError("Internal error");
    }
}

export function oauthProvider(consentUrl: (requestId: string) => string): OAuthServerProvider {
    const db = () => createServerSupabase();
    return {
        clientsStore: {
            getClient: (clientId) => oauthCall(() => getClient(db(), clientId)) as Promise<OAuthClientInformationFull | undefined>,
            registerClient: (client) =>
                oauthCall(() => registerClient(db(), client as never)) as Promise<OAuthClientInformationFull>,
        },
        async authorize(client, params, res) {
            const started = await oauthCall(() =>
                startAuthorization(
                    db(),
                    {
                        clientId: client.client_id,
                        redirectUri: params.redirectUri,
                        codeChallenge: params.codeChallenge,
                        scopes: params.scopes,
                        state: params.state,
                        resource: params.resource,
                    },
                    consentUrl,
                ),
            );
            if (!started.ok) {
                if (started.kind === "validation") throw new InvalidScopeError(started.detail);
                throw new ServerError("Internal error");
            }
            res.redirect(302, started.data);
        },
        challengeForAuthorizationCode: (client, code) => oauthCall(() => challengeFor(db(), client.client_id, code)),
        exchangeAuthorizationCode: (client, code, _verifier, redirectUri, resource) =>
            oauthCall(() => exchangeCode(db(), client, code, redirectUri, resource)),
        exchangeRefreshToken: (client, refreshToken, scopes) =>
            oauthCall(() => exchangeRefresh(db(), client, refreshToken, scopes)),
        // /mcp resolves its bearer itself (openMcpCall); the SDK never calls this.
        verifyAccessToken: async () => {
            throw new ServerError("not used");
        },
        revokeToken: (client, request) => oauthCall(() => revokeOAuthToken(db(), client.client_id, request.token)),
    };
}

/** The OAuth endpoints and metadata, or null when MCP_PUBLIC_URL is unset. */
export function buildOAuthRouter(env: NodeJS.ProcessEnv = process.env): Router | null {
    const config = oauthConfig(env);
    if (!config.enabled) return null;
    const provider = oauthProvider(config.consentUrl);
    const base = new URL("/oauth/", config.issuer);
    const metadata = {
        ...createOAuthMetadata({ provider, issuerUrl: config.issuer, scopesSupported: [...OAUTH_DEFAULT_SCOPES] }),
        authorization_endpoint: new URL("authorize", base).href,
        token_endpoint: new URL("token", base).href,
        registration_endpoint: new URL("register", base).href,
        revocation_endpoint: new URL("revoke", base).href,
        token_endpoint_auth_methods_supported: ["none"],
        revocation_endpoint_auth_methods_supported: ["none"],
    };
    const router = Router();
    router.use("/oauth/authorize", authorizationHandler({ provider }));
    router.use("/oauth/token", tokenHandler({ provider }));
    router.use("/oauth/register", clientRegistrationHandler({ clientsStore: provider.clientsStore }));
    router.use("/oauth/revoke", revocationHandler({ provider }));
    router.use(
        mcpAuthMetadataRouter({
            oauthMetadata: metadata,
            resourceServerUrl: config.resource,
            scopesSupported: [...OAUTH_DEFAULT_SCOPES],
            resourceName: "Mike",
        }),
    );
    return router;
}

/** Where a 401 from /mcp points the client to discover how to sign in (RFC 9728). */
export function resourceMetadataUrl(env: NodeJS.ProcessEnv = process.env): string | null {
    const config = oauthConfig(env);
    if (!config.enabled) return null;
    return new URL(`/.well-known/oauth-protected-resource${config.resource.pathname}`, config.resource).href;
}

// The consent screen's two calls, behind the normal sign-in.
export const mcpConsentRouter = Router();

mcpConsentRouter.get(
    "/pedido/:id",
    requireAuth,
    asyncRoute(async (req, res) => {
        const result = await describeAuthorization(createServerSupabase(), String(req.params.id));
        if (!result.ok) return void sendServiceFailure(res, result);
        res.setHeader("Cache-Control", "no-store");
        res.json(result.data);
    }),
);

mcpConsentRouter.post(
    "/decisao",
    requireAuth,
    requireMfaIfEnrolled,
    asyncRoute(async (req, res) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const result = await decideAuthorization(createServerSupabase(), caller(res), {
            requestId: String(body.pedido ?? ""),
            approve: body.aprovar === true,
            workspace: body.espaco,
        });
        if (!result.ok) return void sendServiceFailure(res, result);
        res.setHeader("Cache-Control", "no-store");
        res.json(result.data);
    }),
);

mcpConsentRouter.use(routerErrorHandler("[mcp-oauth]"));
