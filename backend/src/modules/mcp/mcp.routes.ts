// HTTP layer of the MCP module: the server agents call at /mcp (bearer
// access token, never the session) and the settings screen's token routes at
// /mcp-tokens (session auth, MFA when the person enrolled it).

import { Router } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import rateLimit from "express-rate-limit";
import { requireAuth, requireMfaIfEnrolled } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure } from "../../lib/serviceResult";
import { hashToken } from "./mcp.tokens";
import {
    buildServer,
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
                if (opened.auth.status === 401) res.setHeader("WWW-Authenticate", 'Bearer realm="mike"');
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
