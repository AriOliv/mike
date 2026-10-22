// mike_quem_sou: who the agent is acting for, and what it may do. The first
// call a client makes to check its token works.

import { ok } from "../../lib/serviceResult";
import { allowed } from "./mcp.server";
import { defineTool, type AnyMcpTool } from "./mcp.types";

const ROLE_LABEL = { head: "liderança do Legal", team: "time do Legal", requester: "solicitante" } as const;

export function whoAmITool(catalog: () => readonly AnyMcpTool[]): AnyMcpTool {
    return defineTool({
        name: "mike_quem_sou",
        title: "Quem sou eu no Mike",
        description:
            "Diz em nome de quem você está agindo no Mike, o papel dessa pessoa no Legal, o workspace do token " +
            "e as ferramentas que você pode usar. Chame primeiro, para conferir o acesso.",
        input: {},
        scope: null,
        roles: ["head", "team", "requester"],
        access: "read",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        async handler(ctx) {
            return ok({
                nome: ctx.displayName,
                email: ctx.caller.userEmail,
                papel: ctx.role,
                papel_rotulo: ROLE_LABEL[ctx.role],
                workspace: ctx.workspace,
                cliente: ctx.clientName,
                permissoes: [...ctx.scopes],
                ferramentas: catalog()
                    .filter((t) => t.access === "read" && allowed(t, ctx))
                    .map((t) => t.name),
                // Each one asks the person to confirm before it changes anything.
                acoes_com_confirmacao: catalog()
                    .filter((t) => t.access === "write" && allowed(t, ctx))
                    .map((t) => t.name),
            });
        },
        summary: (o) =>
            `Agindo em nome de ${o.nome} (${o.papel_rotulo}). ${o.ferramentas.length} ferramentas disponíveis.`,
    });
}
