// The contracts module's MCP tools (doc 09 §4.1): an agent reads a contract's
// document and its activity for a person of the Legal team, through the same
// service functions and project access check as the screens.

import { z } from "zod";
import { ok } from "../../lib/serviceResult";
import { defineTool, uuidId, type AnyMcpTool } from "../mcp/mcp.service";
import { listCardEvents } from "./contracts.events";
import { getContractText } from "./contracts.text";

const projectId = uuidId().describe("Id do contrato (project_id), como vem de mike_contratos_buscar.");

/** Where the person opens the contract in the Mike. */
export function contractLink(id: string): string {
    const base = (process.env.FRONTEND_URL ?? "").replace(/\/+$/, "");
    return `${base}/projects/${id}/review`;
}

const ACTOR_LABEL: Record<string, string> = { user: "pessoa", agent: "agente", system: "sistema", hermes: "Hermes" };

export const CONTRACT_TOOLS: AnyMcpTool[] = [
    defineTool({
        name: "mike_contratos_documento",
        title: "Ler o texto do contrato",
        description:
            "Lê o texto da versão atual do contrato, uma página por vez (30 mil caracteres), ou devolve os trechos " +
            "que contêm uma frase quando você passa `buscar`. Use para conferir a redação exata de uma cláusula.",
        input: {
            project_id: projectId,
            pagina: z.number().int().min(1).max(500).optional().describe("Página do texto; começa em 1."),
            buscar: z.string().min(2).max(500).optional().describe("Frase a localizar no contrato."),
        },
        scope: "contratos:read",
        roles: ["head", "team"],
        access: "read",
        recordsRead: true,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        async handler(ctx, input) {
            const r = await getContractText(ctx.db, ctx.caller, input.project_id, { page: input.pagina, find: input.buscar });
            if (!r.ok) return r;
            return ok(r.data ? { ...r.data, link: contractLink(input.project_id) } : { status: "missing" as const, link: contractLink(input.project_id) });
        },
        summary: (o) => {
            if (!("document_id" in o)) return "Este contrato ainda não tem documento.";
            if (o.matches) return `${o.matches.length} trecho(s) encontrados em ${o.filename}.`;
            if (o.status !== "ready") return `O texto de ${o.filename} ainda não está pronto para leitura (${o.status}).`;
            return `${o.filename}: página ${o.page} de ${o.pages}.`;
        },
    }),
    defineTool({
        name: "mike_contratos_atividade",
        title: "Atividade do contrato",
        description:
            "O histórico do contrato, do mais recente ao mais antigo: quem mudou o quê (pessoas, agentes, sistema), " +
            "com antes e depois.",
        input: {
            project_id: projectId,
            limite: z.number().int().min(1).max(50).optional().describe("Quantos eventos (até 50; padrão 20)."),
        },
        scope: "contratos:read",
        roles: ["head", "team"],
        access: "read",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        async handler(ctx, input) {
            const r = await listCardEvents(ctx.db, ctx.caller, input.project_id, input.limite ?? 20);
            if (!r.ok) return r;
            return ok({
                eventos: r.data.map((e) => ({
                    em: e.at,
                    ator: e.actor_name ?? ACTOR_LABEL[e.actor_type] ?? e.actor_type,
                    tipo_ator: e.actor_type,
                    em_nome_de: e.on_behalf_of,
                    acao: e.action,
                    campo: e.field,
                    antes: e.before,
                    depois: e.after,
                    origem: e.source,
                })),
                link: contractLink(input.project_id),
            });
        },
        summary: (o) => (o.eventos.length ? `${o.eventos.length} evento(s), o mais recente em ${o.eventos[0].em.slice(0, 10)}.` : "Nenhuma atividade registrada."),
    }),
];
