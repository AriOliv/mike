// The Legal head's dashboard as an MCP tool (doc 09 §4.1): the same numbers
// as /painel, in the token's workspace, for the head of the Legal team. The
// per-person adoption list stays on screen: an agent gets the team's totals,
// never a ranking of named colleagues.

import { z } from "zod";
import { ok } from "../../lib/serviceResult";
import { defineTool, type AnyMcpTool } from "../mcp/mcp.service";
import { getDashboard } from "./dashboard.metrics";

export const DASHBOARD_TOOLS: AnyMcpTool[] = [
    defineTool({
        name: "mike_painel_metricas",
        title: "Painel do Legal",
        description:
            "Os números do Painel do Legal no período: pedidos recebidos, concluídos e em aberto; tempo até concluir " +
            "e por etapa; prazo cumprido; avisos prévios; o que os agentes fizeram; horas poupadas (com a fórmula); " +
            "Ficha verificada; custo de IA. Só para a liderança do Legal.",
        input: { periodo: z.union([z.literal(30), z.literal(90), z.literal(365)]).optional().describe("Dias: 30, 90 (padrão) ou 365.") },
        scope: "painel:read",
        roles: ["head"],
        access: "read",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        async handler(ctx, input) {
            const r = await getDashboard(ctx.db, ctx.caller, { period: String(input.periodo ?? 90) }, new Date(), ctx.workspace);
            if (!r.ok) return r;
            const { adoption, ...rest } = r.data;
            return ok({
                ...rest,
                adoption: {
                    people: adoption.people.length,
                    assigned_open: adoption.people.reduce((n, p) => n + p.assigned_open, 0),
                    closed: adoption.people.reduce((n, p) => n + p.closed, 0),
                    reviews_run: adoption.reviews_by_user_id.reduce((n, p) => n + p.count, 0),
                },
            });
        },
        summary: (o) =>
            `Últimos ${o.period_days} dias: ${o.volume.opened} pedido(s) recebido(s), ${o.volume.closed} concluído(s), ` +
            `${o.volume.open} em aberto; ${o.agents.contracts_reviewed_by_agents} contrato(s) revisado(s) por agentes; ` +
            `${o.hours_saved.hours} h poupadas (estimativa).`,
    }),
];
