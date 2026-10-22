// The MCP server (doc 09 §2): one McpServer per call, stateless, carrying
// only the tools this token may call. Each tool runs the domain module's
// handler with the person's Caller, maps ServiceResult to an MCP result, and
// leaves an audit row that never holds the arguments.

import crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { recordAudit } from "../../lib/audit";
import { recordAgentRead } from "../contracts/contracts.service";
import { failure, type ServiceFailure } from "../../lib/serviceResult";
import { readTools } from "./mcp.catalog";
import type { AnyMcpTool, McpContext } from "./mcp.types";

export const SERVER_INFO = { name: "mike", version: "1.0.0" } as const;

const INSTRUCTIONS =
    "Mike é a workstation do time Legal. Você age em nome de uma pessoa e vê só o que ela veria na tela. " +
    "Repita ao usuário o resumo em português de cada resposta, cite as fontes que vierem nas citações e " +
    "lembre que respostas sobre contratos não substituem o parecer do Legal.";

/** The MCP error codes of doc 09 §2, from a service failure. */
export function errorCode(f: ServiceFailure): string {
    switch (f.kind) {
        case "validation":
            return "invalid_input";
        case "forbidden":
            return "forbidden";
        case "not_found":
            return "not_found";
        case "conflict":
            return "conflict";
        case "unavailable":
            return "unavailable";
        default:
            return "internal";
    }
}

function errorResult(code: string, message: string): CallToolResult {
    return {
        isError: true,
        content: [{ type: "text", text: message }],
        structuredContent: { error: { code, message } },
    };
}

/** Whether `ctx` may see and call `tool`: the scope on the token AND the role on screen. */
export function allowed(tool: AnyMcpTool, ctx: Pick<McpContext, "scopes" | "role">): boolean {
    return (tool.scope === null || ctx.scopes.includes(tool.scope)) && tool.roles.includes(ctx.role);
}

/** Runs one tool for `ctx`; exported for the tests. Never throws. */
export async function runTool(tool: AnyMcpTool, ctx: McpContext, input: Record<string, unknown>): Promise<CallToolResult> {
    const started = Date.now();
    let result: CallToolResult;
    let code: string | null = null;
    try {
        if (!allowed(tool, ctx)) {
            code = "forbidden";
            result = errorResult(code, "Este token não pode usar esta ferramenta.");
        } else if (tool.access === "write") {
            // Writes are phase 2: they need the two-step confirmation first.
            code = "forbidden";
            result = errorResult(code, "Ações de escrita ainda não estão liberadas pelo MCP.");
        } else {
            // The SDK validates on /mcp; this keeps any other caller of
            // runTool (a future in-process agent) to the same schema.
            const parsed = z.object(tool.input).strict().safeParse(input);
            const out = parsed.success
                ? await tool.handler(ctx, parsed.data)
                : failure("validation", `Argumentos inválidos: ${parsed.error.issues.map((i) => i.path.join(".") || i.message).join(", ")}.`);
            if (out.ok) {
                if (tool.recordsRead && typeof input.project_id === "string")
                    await recordAgentRead(ctx.db, {
                        projectId: input.project_id,
                        actorId: ctx.actor.actorId,
                        actorName: ctx.actor.actorName,
                        onBehalfOf: ctx.actor.onBehalfOf,
                        tool: tool.name,
                    });
                result = {
                    content: [{ type: "text", text: tool.summary(out.data) }],
                    structuredContent: out.data as Record<string, unknown>,
                };
            } else {
                code = errorCode(out);
                if (out.kind === "error") console.error(`[mcp] ${tool.name} failed:`, out.error);
                result = errorResult(
                    code,
                    out.kind === "error" ? "Algo deu errado no Mike. Tente de novo em instantes." : out.detail,
                );
            }
        }
    } catch (error) {
        console.error(`[mcp] ${tool.name} threw:`, error instanceof Error ? error.message : error);
        code = "internal";
        result = errorResult(code, "Algo deu errado no Mike. Tente de novo em instantes.");
    }
    await recordAudit(ctx.db, {
        userId: ctx.caller.userId,
        orgId: typeof ctx.workspace === "string" && ctx.workspace !== "personal" ? ctx.workspace : null,
        userEmail: ctx.caller.userEmail || null,
        action: "mcp.tool",
        status: code ? "failed" : "completed",
        title: tool.name,
        surface: "mcp",
        projectId: typeof input.project_id === "string" ? input.project_id : null,
        detail: {
            client: ctx.clientName,
            token_id: ctx.tokenId,
            tool: tool.name,
            ok: !code,
            ...(code ? { code } : {}),
            ms: Date.now() - started,
            args_hash: argsHash(input),
        },
    });
    return result;
}

/** A stable hash of the arguments: the audit row proves what was asked without holding it. */
export function argsHash(input: Record<string, unknown>): string {
    const canonical = JSON.stringify(input, Object.keys(input).sort());
    return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** A server carrying the tools `ctx` may call, and nothing else. */
export function buildServer(ctx: McpContext, tools: readonly AnyMcpTool[] = readTools()): McpServer {
    const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
    for (const tool of tools) {
        if (!allowed(tool, ctx) || tool.access !== "read") continue;
        server.registerTool(
            tool.name,
            {
                title: tool.title,
                description: tool.description,
                inputSchema: tool.input,
                annotations: { readOnlyHint: true, openWorldHint: false, ...tool.annotations, title: tool.title },
            },
            (args: Record<string, unknown>) => runTool(tool, ctx, args ?? {}),
        );
    }
    return server;
}
