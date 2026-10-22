// Facade of the MCP module (doc 09): the server agents connect to at /mcp,
// the personal access tokens behind it, and the tool contract other modules
// implement (McpTool, McpContext). Other modules import only from here.

// FIRST, before anything that loads the catalog: the catalog imports the
// facades of the modules that publish tools, and they import defineTool from
// here. Exporting it ahead of that cycle keeps it defined whichever side
// loads first.
export { DEFAULT_SCOPES, MCP_SCOPES, defineTool, uuidId } from "./mcp.types";
export type { AnyMcpTool, McpContext, McpRole, McpScope, McpTool, McpToolAnnotations } from "./mcp.types";

import type { Db } from "../../lib/supabase";
import { ok, type ServiceResult } from "../../lib/serviceResult";
import { createLinkChallenge, resolveChatIdentity, validIdentity } from "../legal-agent/legalAgent.service";
import { buildContext, cleanClientName } from "./mcp.context";
import { allowCall } from "./mcp.limits";
import { checkToken, resolvePerson, touchToken, type ResolvedToken, type TokenRejection } from "./mcp.tokens";
import type { McpContext } from "./mcp.types";

export { buildServer, SERVER_INFO } from "./mcp.server";
export {
    createAccessToken,
    listAccessTokens,
    revokeAccessToken,
    createServiceToken,
    listServiceTokens,
    revokeServiceToken,
} from "./mcp.tokens";
export type { AccessTokenView } from "./mcp.tokens";

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

export type McpAuthFailure = {
    status: 400 | 401 | 403 | 429;
    message: string;
    /** Machine-readable reason, e.g. "vinculo_necessario". */
    code?: string;
    /** For vinculo_necessario: the one-time link the person opens to confirm who they are. */
    link?: { url: string; expires_at: string };
};

/** Calls a minute: per service token, and per person it acts for (doc 09 §3.2). */
export const SERVICE_LIMITS = { perToken: 120, perPerson: 20 } as const;

type AuthResult = { ok: false; kind: "auth"; auth: McpAuthFailure };
const refuse = (auth: McpAuthFailure): AuthResult => ({ ok: false, kind: "auth", auth });

/** "slack:T123:U456" → its three parts, or null. */
function parseActingUser(raw: string): { platform: string; teamId: string; userId: string } | null {
    const parts = raw.trim().split(":");
    if (parts.length !== 3) return null;
    const [platform, teamId, userId] = parts;
    return validIdentity(platform, teamId, userId) ? { platform, teamId, userId } : null;
}

/**
 * Authenticates one /mcp call and builds the context its tools run with.
 * A rejected token is an HTTP 401/403, not a tool error: the client has to
 * fix its configuration, not retry the call.
 *
 * A personal token acts as its owner and never takes X-Mike-Acting-User. A
 * service token acts only through that header, for the org member who
 * confirmed the chat identity it names (doc 09 §3.2); never for an e-mail.
 */
export async function openMcpCall(
    db: Db,
    input: {
        authorization: string | undefined;
        body: unknown;
        userAgent: string | undefined;
        /** X-Mike-Acting-User: "<platform>:<team id>:<user id>", set by the bot's code, never by its model. */
        actingUser?: string | undefined;
    },
    now: Date = new Date(),
): Promise<ServiceResult<McpContext> | AuthResult> {
    const checked = await checkToken(db, input.authorization, now);
    if (!checked.ok)
        return refuse({ status: checked.reason === "not_member" ? 403 : 401, message: REJECTION_MESSAGE[checked.reason] });

    let token: ResolvedToken;
    if (checked.kind === "pessoal") {
        // Ignoring the header would let a bot believe it acts for someone
        // else while it acts as the token's owner.
        if (input.actingUser !== undefined)
            return refuse({ status: 400, message: "X-Mike-Acting-User só vale com um token de serviço autorizado a agir em nome de outra pessoa." });
        const row = checked.row;
        const person = await resolvePerson(db, row.user_id, row.org_id);
        if (!person.ok) return refuse({ status: person.reason === "not_member" ? 403 : 401, message: REJECTION_MESSAGE[person.reason] });
        token = {
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
        };
    } else {
        const svc = checked.token;
        if (input.actingUser === undefined)
            return refuse({ status: 400, message: "Um token de serviço exige o cabeçalho X-Mike-Acting-User com a identidade de chat da pessoa." });
        const identity = parseActingUser(input.actingUser);
        if (!identity)
            return refuse({ status: 400, message: "X-Mike-Acting-User deve ser <plataforma>:<workspace>:<usuário>, por exemplo slack:T123:U456." });
        if (!allowCall(`svc:${svc.id}`, SERVICE_LIMITS.perToken, now))
            return refuse({ status: 429, message: "Muitas chamadas deste token de serviço. Espere um minuto." });
        const link = await resolveChatIdentity(db, svc.orgId, identity.platform, identity.teamId, identity.userId, now);
        if (!link) {
            const challenge = await createLinkChallenge(
                db,
                { orgId: svc.orgId, tokenId: svc.id, platform: identity.platform, teamId: identity.teamId, userId: identity.userId },
                now,
            );
            if (!challenge.ok)
                return challenge.kind === "forbidden" || challenge.kind === "validation"
                    ? refuse({ status: 403, message: challenge.detail, code: "workspace_nao_registrado" })
                    : challenge;
            return refuse({
                status: 403,
                code: "vinculo_necessario",
                message: "Esta pessoa ainda não confirmou quem é no Mike. Mande o link para ela abrir, entrar no Mike e confirmar; vale por 15 minutos.",
                link: challenge.data,
            });
        }
        if (!allowCall(`link:${link.linkId}`, SERVICE_LIMITS.perPerson, now))
            return refuse({ status: 429, message: "Muitas chamadas em nome desta pessoa. Espere um minuto." });
        const person = await resolvePerson(db, link.userId, svc.orgId);
        if (!person.ok)
            return refuse({ status: 403, message: "Esta pessoa não faz mais parte da organização deste token." });
        token = {
            id: svc.id,
            kind: "servico",
            userId: link.userId,
            userEmail: person.userEmail,
            displayName: person.displayName,
            orgId: svc.orgId,
            scopes: svc.scopes,
            lastUsedAt: svc.lastUsedAt,
            lastClient: svc.lastClient,
            linkId: link.linkId,
        };
    }

    const clientName = clientNameOf(input.body, token.lastClient, input.userAgent);
    const ctx = await buildContext(db, token, clientName);
    if (!ctx.ok) return ctx;
    void touchToken(db, token, clientName, now);
    return ok(ctx.data);
}
