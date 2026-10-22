// The contract between the MCP server and the modules that publish tools
// (doc 09 §5). A domain module declares its tools in `<domain>.mcp.ts`,
// re-exports them from its facade, and the server only aggregates: nobody
// reaches into another module's topic files.

import { z } from "zod";
import type { Db } from "../../lib/supabase";
import type { ServiceResult } from "../../lib/serviceResult";
import type { WorkspaceFilter } from "../../lib/workspace";
import { uuidId as uuidShape } from "../../lib/ids";

/** Who the caller is to the legal team, as whoAmI answers it. */
export type McpRole = "head" | "team" | "requester";

/** Every scope a token can carry (doc 09 §3.3). */
export const MCP_SCOPES = [
    "contratos:read",
    "prazos:read",
    "base:ask",
    "revisao:read",
    "revisao:run",
    "controle:read",
    "controle:run",
    "radar:read",
    "painel:read",
    "pedidos:read",
    "pedidos:write",
    "agente:config",
] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** What a new personal token gets unless the person picks otherwise. */
export const DEFAULT_SCOPES: readonly McpScope[] = MCP_SCOPES.filter(
    (s) => s.endsWith(":read") || s === "base:ask",
);

/**
 * The person an agent acts for, resolved from the token on every call. Tools
 * hand `caller` to the same service functions the screens use, so the
 * permission check is the screen's.
 */
export type McpContext = {
    db: Db;
    caller: { userId: string; userEmail: string };
    /** The person's name, for summaries ("Duda"). */
    displayName: string;
    role: McpRole;
    /** The token's workspace: an org id, "personal", or null for no narrowing. */
    workspace: WorkspaceFilter;
    scopes: readonly McpScope[];
    /** The MCP client's name ("claude-code", "codex", "hermes-docbot"). */
    clientName: string;
    tokenId: string;
    /** The actor every write and card event carries (doc 09 §7). */
    actor: {
        actorType: "agent";
        actorId: `mcp:${string}`;
        /** "<client> em nome de <Nome>". */
        actorName: string;
        /** The person's e-mail, as card_events.on_behalf_of expects. */
        onBehalfOf: string;
        source: "mcp";
    };
};

export type McpToolAnnotations = {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
};

type Shape = Record<string, z.ZodType>;
type Input<I extends Shape> = { [K in keyof I]: z.output<I[K]> };

export type McpTool<I extends Shape = Shape, O = unknown> = {
    name: string;
    title: string;
    description: string;
    input: I;
    /** The scope the token needs; null for tools any valid token may call. */
    scope: McpScope | null;
    roles: readonly McpRole[];
    access: "read" | "write";
    annotations?: McpToolAnnotations;
    /**
     * A read of one contract (its `project_id` input) that enters the
     * contract's activity feed as "<client> em nome de <Nome>" (doc 09 §7).
     * Off for tools that read the feed itself.
     */
    recordsRead?: boolean;
    /**
     * Writes that change relevant state run in two steps (doc 09 §6):
     * `preview` changes nothing and says what would happen; the server asks
     * for the person's ok before `handler` runs. Phase 2.
     */
    confirm?: {
        preview(ctx: McpContext, input: Input<I>): Promise<ServiceResult<{ resumo: string; detalhes?: unknown }>>;
    };
    handler(ctx: McpContext, input: Input<I>): Promise<ServiceResult<O>>;
    /** The short Portuguese line the agent repeats to the person. */
    summary(output: O): string;
};

/**
 * Erases a tool's own input/output types so tools of different shapes fit
 * one list. Each module calls this on its array.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMcpTool = McpTool<any, any>;

/** An id as Postgres stores it; the MCP tools' wording. */
export const uuidId = () => uuidShape("id inválido");

export function defineTool<I extends Shape, O>(tool: McpTool<I, O>): AnyMcpTool {
    return tool as AnyMcpTool;
}
