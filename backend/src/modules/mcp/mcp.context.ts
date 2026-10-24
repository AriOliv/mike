// Turns a valid token into the McpContext every tool receives (doc 09 §5):
// the person's Caller, their role on the legal team, the token's workspace
// and the actor that writes and card events carry.

import type { Db } from "../../lib/supabase";
import { internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { PERSONAL_WORKSPACE } from "../../lib/workspace";
import { whoAmI } from "../requests/requests.service";
import type { ResolvedToken } from "./mcp.tokens";
import type { McpContext } from "./mcp.types";

/** A client name safe to show and store: the MCP clientInfo name, or a fallback. */
export function cleanClientName(raw: unknown): string {
    const name = typeof raw === "string" ? raw.replace(/[^\p{L}\p{N} ._\-/]/gu, "").trim().slice(0, 60) : "";
    return name || "agente";
}

export async function buildContext(
    db: Db,
    token: ResolvedToken,
    clientName: string,
): Promise<ServiceResult<McpContext>> {
    const caller = { userId: token.userId, userEmail: token.userEmail };
    const who = await whoAmI(db, caller);
    if (!who.ok) return who.kind === "error" ? internalFailure(who.error) : who;
    return ok({
        db,
        caller,
        displayName: token.displayName,
        // No Legal team configured: the screens keep the whole menu (nobody is
        // narrowed to a requester), so the agent reads like the team does.
        role: who.data.configured ? who.data.role : "team",
        workspace: token.orgId ?? PERSONAL_WORKSPACE,
        scopes: token.scopes,
        clientName,
        tokenId: token.id,
        tokenKind: token.kind === "servico" ? "servico" : token.kind === "oauth" ? "oauth" : "pessoal",
        linkId: token.linkId,
        actor: {
            actorType: "agent",
            actorId: `mcp:${clientName}`,
            actorName: `${clientName} em nome de ${token.displayName}`,
            onBehalfOf: token.userEmail,
            source: "mcp",
        },
    });
}
