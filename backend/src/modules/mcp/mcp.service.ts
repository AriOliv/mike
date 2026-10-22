// Facade of the MCP module (doc 09): the server agents connect to at /mcp,
// the personal access tokens behind it, and the tool contract other modules
// implement (McpTool, McpContext). Other modules import only from here.

import type { Db } from "../../lib/supabase";
import { ok, type ServiceResult } from "../../lib/serviceResult";
import { buildContext, cleanClientName } from "./mcp.context";
import { authenticateToken, touchToken, type TokenRejection } from "./mcp.tokens";
import type { McpContext } from "./mcp.types";

export { buildServer, SERVER_INFO } from "./mcp.server";
export { createAccessToken, listAccessTokens, revokeAccessToken } from "./mcp.tokens";
export type { AccessTokenView } from "./mcp.tokens";
export { DEFAULT_SCOPES, MCP_SCOPES, defineTool } from "./mcp.types";
export type { AnyMcpTool, McpContext, McpRole, McpScope, McpTool, McpToolAnnotations } from "./mcp.types";

const REJECTION_MESSAGE: Record<TokenRejection, string> = {
    missing: "Envie o token de acesso do Mike no cabeçalho Authorization: Bearer.",
    invalid: "Token de acesso inválido.",
    expired: "Este token expirou. Crie outro em Configurações → Tokens de acesso para agentes.",
    revoked: "Este token foi revogado.",
    not_member: "Você não faz mais parte do workspace deste token.",
};

/** The client's name: clientInfo on initialize, else what the token last used, else the User-Agent. */
function clientNameOf(body: unknown, lastClient: string | null, userAgent: string | undefined): string {
    const messages = Array.isArray(body) ? body : [body];
    for (const m of messages) {
        const info = (m as { method?: string; params?: { clientInfo?: { name?: unknown } } } | null);
        if (info?.method === "initialize") return cleanClientName(info.params?.clientInfo?.name);
    }
    if (lastClient) return cleanClientName(lastClient);
    return cleanClientName(userAgent?.split(/[\s/]/)[0]);
}

export type McpAuthFailure = { status: 400 | 401 | 403; message: string };

/**
 * Authenticates one /mcp call and builds the context its tools run with.
 * A rejected token is an HTTP 401/403, not a tool error: the client has to
 * fix its configuration, not retry the call.
 */
export async function openMcpCall(
    db: Db,
    input: {
        authorization: string | undefined;
        body: unknown;
        userAgent: string | undefined;
        /** X-Mike-Acting-User. Never honoured on a personal token (doc 09 §3.2). */
        actingUser?: string | undefined;
    },
    now: Date = new Date(),
): Promise<ServiceResult<McpContext> | { ok: false; kind: "auth"; auth: McpAuthFailure }> {
    // A personal token acts only as its owner. Ignoring the header would let
    // a bot believe it is acting for someone else while it acts as the owner.
    if (input.actingUser !== undefined)
        return {
            ok: false,
            kind: "auth",
            auth: { status: 400, message: "X-Mike-Acting-User só vale com um token de serviço autorizado a agir em nome de outra pessoa." },
        };
    const auth = await authenticateToken(db, input.authorization, now);
    if (!auth.ok) {
        return {
            ok: false,
            kind: "auth",
            auth: { status: auth.reason === "not_member" ? 403 : 401, message: REJECTION_MESSAGE[auth.reason] },
        };
    }
    const clientName = clientNameOf(input.body, auth.token.lastClient, input.userAgent);
    const ctx = await buildContext(db, auth.token, clientName);
    if (!ctx.ok) return ctx;
    void touchToken(db, auth.token, clientName, now);
    return ok(ctx.data);
}
