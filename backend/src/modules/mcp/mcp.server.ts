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
import { consume, propose } from "./mcp.confirm";
import { catalogTools, WRITE_TOOLS_ENABLED } from "./mcp.catalog";
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
/** The argument a write tool's second call carries; the server's, never the tool's. */
export const CONFIRM_FIELD = "confirm_token";

const confirmTokenSchema = z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
        "Deixe vazio na primeira chamada: o Mike devolve um resumo e o código de confirmação. Mostre o resumo à pessoa e, " +
            "só se ela concordar, chame de novo com os mesmos argumentos e este código.",
    );

/** Runs one tool for `ctx`; exported for the tests. Never throws. */
export async function runTool(tool: AnyMcpTool, ctx: McpContext, input: Record<string, unknown>): Promise<CallToolResult> {
    const started = Date.now();
    let result: CallToolResult;
    let code: string | null = null;
    let step: "proposta" | "confirmada" | null = null;
    const { [CONFIRM_FIELD]: confirmToken, ...args } = input;
    try {
        if (!allowed(tool, ctx)) {
            code = "forbidden";
            result = errorResult(code, "Este token não pode usar esta ferramenta.");
        } else if (tool.access === "write" && (!tool.confirm || !WRITE_TOOLS_ENABLED.has(tool.name))) {
            // Every write that changes relevant state is confirmed by the person
            // (doc 09 §6), and only the writes switched on by name ever run, even
            // when called here directly rather than through the catalog.
            code = "forbidden";
            result = errorResult(code, "Esta ação precisa de confirmação e ainda não está liberada pelo MCP.");
        } else {
            // The SDK validates on /mcp; this keeps any other caller of
            // runTool (a future in-process agent) to the same schema.
            const parsed = z.object(tool.input).strict().safeParse(args);
            if (!parsed.success) {
                code = "invalid_input";
                result = errorResult(code, `Argumentos inválidos: ${parsed.error.issues.map((i) => i.path.join(".") || i.message).join(", ")}.`);
            } else if (tool.access === "write" && confirmToken === undefined) {
                // Step 1: nothing changes; the person sees what would.
                step = "proposta";
                const preview = await tool.confirm!.preview(ctx, parsed.data);
                const proposal = preview.ok ? await propose(ctx, tool.name, parsed.data, preview.data.resumo) : preview;
                if (!preview.ok || !proposal.ok) {
                    const f = (!preview.ok ? preview : proposal) as ServiceFailure;
                    code = errorCode(f);
                    result = failureResult(tool, f, code);
                } else {
                    const out = {
                        precisa_confirmar: true,
                        resumo: preview.data.resumo,
                        ...(preview.data.detalhes !== undefined ? { detalhes: preview.data.detalhes } : {}),
                        confirm_token: proposal.data.confirm_token,
                        expira_em: proposal.data.expira_em,
                    };
                    result = {
                        content: [
                            {
                                type: "text",
                                text:
                                    `Confirme com a pessoa antes: ${preview.data.resumo} ` +
                                    `Se ela concordar, chame ${tool.name} de novo com os mesmos argumentos e ${CONFIRM_FIELD}.`,
                            },
                        ],
                        structuredContent: out,
                    };
                }
            } else {
                if (tool.access === "write") {
                    // Step 2: only this person's ok for these exact arguments runs it.
                    step = "confirmada";
                    const spent =
                        typeof confirmToken === "string"
                            ? await consume(ctx, tool.name, parsed.data, confirmToken)
                            : failure("validation", "Código de confirmação inválido.", "confirmacao_invalida");
                    if (!spent.ok) {
                        code = errorCode(spent);
                        result = failureResult(tool, spent, code);
                        return await finish();
                    }
                } else if (confirmToken !== undefined) {
                    code = "invalid_input";
                    result = errorResult(code, "Esta ferramenta só lê; não leva código de confirmação.");
                    return await finish();
                }
                const out = await tool.handler(ctx, parsed.data);
                if (out.ok) {
                    if (tool.recordsRead && typeof args.project_id === "string")
                        await recordAgentRead(ctx.db, {
                            projectId: args.project_id,
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
                    result = failureResult(tool, out, code);
                }
            }
        }
    } catch (error) {
        console.error(`[mcp] ${tool.name} threw:`, error instanceof Error ? error.message : error);
        code = "internal";
        result = errorResult(code, "Algo deu errado no Mike. Tente de novo em instantes.");
    }
    return await finish();

    async function finish(): Promise<CallToolResult> {
        await recordAudit(ctx.db, {
            userId: ctx.caller.userId,
            orgId: typeof ctx.workspace === "string" && ctx.workspace !== "personal" ? ctx.workspace : null,
            userEmail: ctx.caller.userEmail || null,
            action: "mcp.tool",
            status: code ? "failed" : "completed",
            title: tool.name,
            surface: "mcp",
            projectId: typeof args.project_id === "string" ? args.project_id : null,
            detail: {
                client: ctx.clientName,
                token_id: ctx.tokenId,
                token_kind: ctx.tokenKind,
                ...(ctx.linkId ? { link_id: ctx.linkId } : {}),
                tool: tool.name,
                ok: !code,
                ...(code ? { code } : {}),
                ...(step ? { step } : {}),
                ms: Date.now() - started,
                args_hash: argsHash(args),
            },
        });
        return result;
    }
}

function failureResult(tool: AnyMcpTool, f: ServiceFailure, code: string): CallToolResult {
    if (f.kind === "error") console.error(`[mcp] ${tool.name} failed:`, f.error);
    return errorResult(code, f.kind === "error" ? "Algo deu errado no Mike. Tente de novo em instantes." : f.detail);
}

/** A stable hash of the arguments: the audit row proves what was asked without holding it. */
export function argsHash(input: Record<string, unknown>): string {
    const canonical = JSON.stringify(input, Object.keys(input).sort());
    return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** A server carrying the tools `ctx` may call, and nothing else. */
export function buildServer(ctx: McpContext, tools: readonly AnyMcpTool[] = catalogTools()): McpServer {
    const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
    for (const tool of tools) {
        // A write with no confirmation step is never offered (doc 09 §6).
        if (!allowed(tool, ctx) || (tool.access === "write" && !tool.confirm)) continue;
        const write = tool.access === "write";
        server.registerTool(
            tool.name,
            {
                title: tool.title,
                description: write
                    ? `${tool.description} Pede confirmação: a primeira chamada só mostra o que vai acontecer.`
                    : tool.description,
                inputSchema: write ? { ...tool.input, [CONFIRM_FIELD]: confirmTokenSchema } : tool.input,
                annotations: write
                    ? { readOnlyHint: false, destructiveHint: false, openWorldHint: false, ...tool.annotations, title: tool.title }
                    : { readOnlyHint: true, openWorldHint: false, ...tool.annotations, title: tool.title },
            },
            (input: Record<string, unknown>) => runTool(tool, ctx, input ?? {}),
        );
    }
    return server;
}
