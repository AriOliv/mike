// The contracts module's MCP tools (doc 09 §4.1): an agent reads a contract's
// document and its activity for a person of the Legal team, through the same
// service functions and project access check as the screens.

import { z } from "zod";
import { ok } from "../../lib/serviceResult";
import { defineTool, uuidId, type AnyMcpTool } from "../mcp/mcp.service";
import { askAcervo } from "./contracts.acervo";
import { listCardEvents } from "./contracts.events";
import { listNoticeDeadlines } from "./contracts.home";
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
    defineTool({
        name: "mike_prazos_proximos",
        title: "Próximos avisos prévios",
        description:
            "Os avisos prévios (prazo para avisar a não renovação ou a rescisão) dos contratos que a pessoa vê no " +
            "workspace do token, do mais próximo ao mais distante, até `dias` dias à frente.",
        input: {
            dias: z.number().int().min(1).max(180).optional().describe("Quantos dias à frente (até 180; padrão 30)."),
            contraparte: z.string().min(1).max(200).optional().describe("Só contratos desta contraparte (ou com isto no nome)."),
        },
        scope: "prazos:read",
        roles: ["head", "team"],
        access: "read",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        async handler(ctx, input) {
            const dias = input.dias ?? 30;
            const r = await listNoticeDeadlines(ctx.db, ctx.caller, { daysAhead: dias, workspace: ctx.workspace, counterparty: input.contraparte });
            if (!r.ok) return r;
            return ok({
                dias,
                prazos: r.data.map((d) => ({
                    project_id: d.project_id,
                    contrato: d.project_name,
                    contraparte: d.counterparty,
                    avisar_ate: d.notice_deadline,
                    faltam_dias: d.days_left,
                    aviso_previo_dias: d.notice_days,
                    vigencia_fim: d.term_end,
                    renovacao_automatica: d.auto_renewal,
                    link: contractLink(d.project_id),
                })),
            });
        },
        summary: (o) =>
            o.prazos.length === 0
                ? `Nenhum aviso prévio nos próximos ${o.dias} dias.`
                : `${o.prazos.length} aviso(s) prévio(s) nos próximos ${o.dias} dias; o primeiro vence em ${o.prazos[0].faltam_dias} dia(s) (${o.prazos[0].contrato}).`,
    }),
    defineTool({
        name: "mike_base_perguntar",
        title: "Perguntar à base de contratos",
        description:
            "Responde a uma pergunta sobre os contratos que a pessoa vê no workspace do token, lendo os contratos e " +
            "citando os trechos ([n] na resposta = fontes[n]). Diz quando não encontrou. Cite as fontes ao responder; " +
            "a resposta não substitui o parecer do Legal.",
        input: {
            pergunta: z.string().min(3).max(2000).describe("A pergunta, em português."),
            contraparte: z.string().min(1).max(200).optional().describe("Só contratos com esta contraparte."),
            tipo: z.string().min(1).max(200).optional().describe("Só contratos deste tipo."),
            contratos: z.array(uuidId()).max(500).optional().describe("Só estes contratos (project_id)."),
            incluir_lei: z.boolean().optional().describe("Também buscar a legislação oficial, quando configurado."),
        },
        scope: "base:ask",
        roles: ["head", "team"],
        access: "read",
        annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
        async handler(ctx, input) {
            const filtered = input.contraparte || input.tipo || input.contratos;
            const r = await askAcervo(
                ctx.db,
                ctx.caller,
                {
                    question: input.pergunta,
                    scope: filtered
                        ? { counterparty: input.contraparte, contract_type: input.tipo, project_ids: input.contratos }
                        : "todos",
                    include_law: input.incluir_lei === true,
                },
                ctx.workspace,
            );
            if (!r.ok) return r;
            const a = r.data;
            return ok({
                resposta: a.answer,
                encontrou: a.found,
                fontes: a.sources.map((f) => ({
                    n: f.n,
                    contrato: f.contract,
                    project_id: f.project_id,
                    referencia: f.ref,
                    trecho: f.quote,
                    conferido_no_texto: f.verified,
                    link: f.project_id ? contractLink(f.project_id) : null,
                })),
                leis: a.law_sources.map((l) => ({ n: l.n, titulo: l.title, url: l.url, trecho: l.quote, conferido: l.verified })),
                contratos_lidos: a.searched,
                contratos_no_escopo: a.total,
                cobertura: {
                    contratos_ainda_indexando: a.coverage.contracts_pending,
                    contratos_nao_buscados: a.coverage.contracts_not_searched,
                },
                aviso: "Não substitui o parecer do Legal.",
            });
        },
        summary: (o) =>
            o.contratos_no_escopo === 0
                ? "Nenhum contrato no escopo para responder."
                : o.encontrou
                  ? `${o.resposta}\n\n(${o.fontes.length} fonte(s); ${o.contratos_lidos} de ${o.contratos_no_escopo} contrato(s) lidos. Não substitui o parecer do Legal.)`
                  : `Não encontrei a resposta nos ${o.contratos_lidos} contrato(s) lidos de ${o.contratos_no_escopo}.`,
    }),
];
