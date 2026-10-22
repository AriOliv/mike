// Runs one tool through the real MCP runner (scope and role gating, input
// validation, result mapping, audit) for a fictional person on the Legal
// team. For the tests of every module that publishes tools.

import { runTool } from "../mcp.server";
import type { AnyMcpTool, McpContext } from "../mcp.types";

export function testContext(over: Partial<McpContext> = {}): McpContext {
    return {
        db: { tag: "db" } as never,
        caller: { userId: "00000000-0000-4000-b000-000000000001", userEmail: "ana@exemplo.test" },
        displayName: "Ana Teste",
        role: "team",
        workspace: null,
        scopes: ["contratos:read", "prazos:read", "base:ask", "revisao:read", "controle:read", "radar:read", "painel:read", "pedidos:read"],
        clientName: "claude-code",
        tokenId: "token-1",
        tokenKind: "pessoal",
        linkId: null,
        actor: {
            actorType: "agent",
            actorId: "mcp:claude-code",
            actorName: "claude-code em nome de Ana Teste",
            onBehalfOf: "ana@exemplo.test",
            source: "mcp",
        },
        ...over,
    };
}

export async function runToolForTest(tool: AnyMcpTool, input: Record<string, unknown>, over: Partial<McpContext> = {}) {
    const ctx = testContext(over);
    return { ctx, result: await runTool(tool, ctx, input) };
}
