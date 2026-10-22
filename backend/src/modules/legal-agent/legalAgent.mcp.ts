// The legal agent's MCP tool, registered through this module's facade
// (AGENT_TOOLS) and aggregated by the MCP server (docs/product/09-mcp-integral.md
// §5). The shape below is the agreed McpTool contract, declared structurally so
// this module does not depend on the MCP module's files; the server checks
// scope, role and workspace before calling the handler.

import { z } from "zod";
import { failure, type ServiceResult } from "../../lib/serviceResult";
import type { Db } from "../../lib/supabase";
import { getAgentConfigForBot } from "./legalAgent.store";
import type { agentConfigForBot } from "./legalAgent.settings";

type AgentConfig = ReturnType<typeof agentConfigForBot>;

/** The part of the MCP server's context this tool reads. */
export type AgentToolContext = {
    db: Db;
    /** The organization the token belongs to; personal workspaces have no agent. */
    workspace: string | null;
    /** The channel the bot says it speaks on (X-Mike-Channel), when it says. */
    channel?: string | null;
};

const input = { canal: z.enum(["slack", "whatsapp", "telegram"]).optional() };

export const agentConfigTool = {
    name: "mike_agente_config",
    title: "Configuração do assistente do Legal",
    description:
        "Lê como o assistente do Legal deve se comportar nesta organização: persona, tom, horário de atendimento, " +
        "quem pode pedir o quê, quando passar para uma pessoa do Legal e os avisos que ele dá sozinho. " +
        "Leia no começo da conversa. Não traz segredo nem lista de pessoas.",
    input,
    scope: "agente:config",
    roles: ["head", "team", "requester"] as const,
    access: "read" as const,
    annotations: { readOnlyHint: true, openWorldHint: false },
    async handler(ctx: AgentToolContext, args: { canal?: "slack" | "whatsapp" | "telegram" }): Promise<ServiceResult<AgentConfig>> {
        if (!ctx.workspace || ctx.workspace === "personal")
            return failure("not_found", "O assistente do Legal é configurado por organização, e este acesso não é de uma.");
        return getAgentConfigForBot(ctx.db, ctx.workspace, args.canal ?? ctx.channel ?? null);
    },
    summary(output: AgentConfig): string {
        const dias = output.horario.dias.join(", ");
        return output.ativo
            ? `${output.nome} está ligado, em tom ${output.tom}, de ${dias}, das ${output.horario.inicio} às ${output.horario.fim}. ` +
                  `Passa para uma pessoa do Legal em ${output.escalada.length} situações.`
            : `${output.nome} está desligado nesta organização: não responda pedidos, diga que o Legal ainda não ativou o assistente.`;
    },
};

/** Every MCP tool this module offers; the MCP server aggregates them. */
export const AGENT_TOOLS = [agentConfigTool] as const;
