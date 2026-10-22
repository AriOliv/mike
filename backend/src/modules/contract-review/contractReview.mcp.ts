// The contract-review module's MCP tools (doc 09 §4.1): an agent searches the
// portfolio and reads a contract's Ficha, with every field's citations, for a
// person of the Legal team, through the same functions and access checks as
// the /contratos page and the Ficha panel.

import { z } from "zod";
import { ok } from "../../lib/serviceResult";
import { defineTool, uuidId, type AnyMcpTool } from "../mcp/mcp.service";
import { FICHA_FIELDS, type FichaPath } from "./contractReview.ficha";
import { getFicha } from "./contractReview.fichaService";
import { listContractPortfolio, type PortfolioRow } from "./contractReview.portfolio";

/** Where the person opens the contract in the Mike. */
function contractLink(id: string): string {
    const base = (process.env.FRONTEND_URL ?? "").replace(/\/+$/, "");
    return `${base}/projects/${id}/review`;
}

// The portfolio is read whole and filtered here: a few hundred contracts per
// team, and the page already paginates in memory the same way.
const SCAN_LIMIT = 100;

function matches(row: PortfolioRow, q: string): boolean {
    const norm = (s: string | null) => (s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    const needle = norm(q);
    return [row.name, row.counterparty, row.contract_type].some((v) => norm(v).includes(needle));
}

const RISK_LABEL = { critico: "crítico", atencao: "atenção", ok: "ok" } as const;

export const CONTRACT_REVIEW_TOOLS: AnyMcpTool[] = [
    defineTool({
        name: "mike_contratos_buscar",
        title: "Buscar contratos na carteira",
        description:
            "Lista os contratos da carteira que a pessoa vê no workspace do token, com contraparte, tipo, etapa, fim da vigência, aviso " +
            "prévio, risco e quantos campos da Ficha já foram verificados. Filtre por nome, contraparte ou tipo com `busca`; " +
            "ordene por `aviso` para ver primeiro os avisos que vencem antes.",
        input: {
            busca: z.string().min(1).max(200).optional().describe("Parte do nome, da contraparte ou do tipo."),
            ordem: z.enum(["nome", "aviso"]).optional().describe("nome (padrão) ou aviso: o aviso prévio mais próximo primeiro."),
            limite: z.number().int().min(1).max(50).optional().describe("Quantos contratos (até 50; padrão 20)."),
            a_partir_de: z.number().int().min(0).optional().describe("Posição para a próxima página (proximo de uma chamada anterior)."),
        },
        scope: "contratos:read",
        roles: ["head", "team"],
        access: "read",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        async handler(ctx, input) {
            const limit = input.limite ?? 20;
            const start = input.a_partir_de ?? 0;
            const rows: PortfolioRow[] = [];
            let offset = 0;
            for (;;) {
                const page = await listContractPortfolio(ctx.db, ctx.caller, { limit: SCAN_LIMIT, offset, sort: input.ordem ?? "nome" }, ctx.workspace);
                if (!page.ok) return page;
                rows.push(...page.data.rows);
                if (page.data.next_offset === null) break;
                offset = page.data.next_offset;
            }
            const hits = input.busca ? rows.filter((r) => matches(r, input.busca!)) : rows;
            const slice = hits.slice(start, start + limit);
            return ok({
                contratos: slice.map((r) => ({
                    project_id: r.project_id,
                    nome: r.name,
                    contraparte: r.counterparty,
                    tipo: r.contract_type,
                    etapa: r.lane,
                    vigencia_fim: r.term_end,
                    aviso_previo_dias: r.notice_days,
                    aviso_previo_ate: r.notice_deadline,
                    risco: r.risk,
                    ficha: { preenchidos: r.filled, verificados: r.verified, total: r.total },
                    link: contractLink(r.project_id),
                })),
                total: hits.length,
                proximo: start + limit < hits.length ? start + limit : null,
            });
        },
        summary: (o) =>
            o.total === 0
                ? "Nenhum contrato encontrado."
                : `${o.total} contrato(s)${o.contratos.length < o.total ? `, mostrando ${o.contratos.length}` : ""}.`,
    }),
    defineTool({
        name: "mike_contratos_ficha",
        title: "Ficha do contrato com citações",
        description:
            "Lê a Ficha do contrato: cada campo com o valor, o status (encontrado, inferido, ambíguo, não encontrado), " +
            "a confiança, se uma pessoa já verificou e as citações literais do contrato que sustentam o valor; e os " +
            "alertas de risco. Cite as citações ao responder; um campo não verificado é leitura da IA.",
        input: {
            project_id: uuidId().describe("Id do contrato (project_id), como vem de mike_contratos_buscar."),
            campos: z.array(z.string()).max(30).optional().describe("Só estes campos (ex.: vigencia.renovacao); padrão: todos."),
        },
        scope: "contratos:read",
        roles: ["head", "team"],
        access: "read",
        recordsRead: true,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        async handler(ctx, input) {
            const r = await getFicha(ctx.db, ctx.caller, input.project_id);
            if (!r.ok) return r;
            const wanted = input.campos ? new Set(input.campos) : null;
            const ficha = r.data.ficha ?? {};
            const campos = FICHA_FIELDS.filter((f) => !wanted || wanted.has(f.path)).map((f) => {
                const field = ficha[f.path as FichaPath];
                return {
                    campo: f.path,
                    rotulo: f.label,
                    status: field?.status ?? "nao_extraido",
                    valor: field?.value ?? null,
                    confianca: field?.confidence ?? null,
                    origem: field?.origin ?? null,
                    verificado: !!field && field.review.state !== "pendente",
                    revisao: field ? field.review.state : null,
                    citacoes: (field?.citations ?? []).map((c) => ({
                        trecho: c.quote,
                        clausula: c.clause,
                        conferida_no_texto: c.verified,
                    })),
                };
            });
            return ok({
                extraida: r.data.ficha !== null,
                extraida_em: r.data.extracted_at,
                risco: r.data.risk_overall,
                alertas: r.data.findings.map((f) => ({
                    titulo: f.titulo,
                    severidade: f.severidade,
                    justificativa: f.justificativa,
                    acao_sugerida: f.acao_sugerida,
                    campos: f.campos,
                    depende_de_campo_nao_verificado: f.depende_de_campo_nao_validado,
                })),
                verificados: r.data.progress.verified,
                total: r.data.progress.total,
                campos,
                link: contractLink(input.project_id),
                aviso: "Campos não verificados são leitura da IA; não substituem o parecer do Legal.",
            });
        },
        summary: (o) =>
            !o.extraida
                ? "A Ficha deste contrato ainda não foi extraída."
                : `Ficha: ${o.verificados} de ${o.total} campos verificados${o.risco ? `, risco ${RISK_LABEL[o.risco as keyof typeof RISK_LABEL] ?? o.risco}` : ""}, ${o.alertas.length} alerta(s).`,
    }),
];
