// The tabular module's MCP tools (doc 09 §4.1): an agent lists the person's
// tabular reviews (the Controle de Contratos among them) and reads one grid,
// cell by cell with the citations, through the same functions and access
// checks as the screen. Rows of documents the person cannot read are already
// left out by getTabularReviewDetail.

import { z } from "zod";
import { failure, ok, type ServiceResult } from "../../lib/serviceResult";
import { defineTool, uuidId, type AnyMcpTool } from "../mcp/mcp.service";
import { getTabularReviewDetail, listTabularReviews } from "./tabular.reviews";
import { parseCellContent, type TabularResult } from "./tabular.shared";

/** The MCP runner speaks ServiceResult; a tabular status failure becomes the nearest kind. */
function asService<T>(r: TabularResult<T>): ServiceResult<T> {
    if (r.ok || r.kind !== "status") return r as ServiceResult<T>;
    if (r.status === 404) return failure("not_found", "Tabela não encontrada.");
    if (r.status === 403) return failure("forbidden", "Você não pode abrir esta tabela.");
    if (r.status >= 400 && r.status < 500) return failure("validation", "Não consegui ler esta tabela.");
    return { ok: false, kind: "error", error: new Error(`tabular status ${r.status}`) };
}

function tabularLink(id: string): string {
    const base = (process.env.FRONTEND_URL ?? "").replace(/\/+$/, "");
    return `${base}/tabular-reviews/${id}`;
}

type Column = { index: number; name: string };
type Cell = { row_id: string; column_index: number; content: unknown; citations: unknown; status: string };
type Row = { id: string; label: string; sort_index: number };

const FLAG_LABEL: Record<string, string> = { green: "ok", yellow: "atenção", red: "risco", grey: "sem informação" };

export const TABULAR_TOOLS: AnyMcpTool[] = [
    defineTool({
        name: "mike_controle_listar",
        title: "Tabelas de análise (Controle de Contratos)",
        description:
            "As tabelas de análise que a pessoa vê no workspace do token, como o Controle de Contratos: título, " +
            "colunas, quantos documentos e quando foi atualizada. Use o review_id em mike_controle_ler.",
        input: {
            busca: z.string().min(1).max(200).optional().describe("Parte do título."),
            limite: z.number().int().min(1).max(50).optional().describe("Quantas (até 50; padrão 20)."),
        },
        scope: "controle:read",
        roles: ["head", "team"],
        access: "read",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        async handler(ctx, input) {
            const r = asService(
                await listTabularReviews(ctx.db, {
                    userId: ctx.caller.userId,
                    userEmail: ctx.caller.userEmail || undefined,
                    projectIdFilter: null,
                    scope: "all",
                    pagination: { limit: input.limite ?? 20, offset: 0 },
                    searchTerm: input.busca ?? null,
                    sort: { key: "updated", direction: "desc" },
                    workspace: ctx.workspace,
                }),
            );
            if (!r.ok) return r;
            const rows = r.data as { id: string; title: string | null; columns_config: Column[] | null; document_ids: string[] | null; updated_at: string }[];
            return ok({
                tabelas: rows.map((t) => ({
                    review_id: t.id,
                    titulo: t.title ?? "Sem título",
                    colunas: (t.columns_config ?? []).map((c) => c.name),
                    documentos: (t.document_ids ?? []).length,
                    atualizada_em: t.updated_at,
                    link: tabularLink(t.id),
                })),
            });
        },
        summary: (o) => (o.tabelas.length ? `${o.tabelas.length} tabela(s) de análise.` : "Nenhuma tabela de análise."),
    }),
    defineTool({
        name: "mike_controle_ler",
        title: "Ler uma tabela de análise",
        description:
            "As células de uma tabela de análise (o Controle de Contratos, por exemplo): uma linha por documento, " +
            "cada coluna com o resumo, a sinalização (ok, atenção, risco) e as citações. Pagina por linhas.",
        input: {
            review_id: uuidId().describe("Id da tabela, como vem de mike_controle_listar."),
            limite: z.number().int().min(1).max(50).optional().describe("Quantas linhas (até 50; padrão 20)."),
            a_partir_de: z.number().int().min(0).optional().describe("Posição da próxima página."),
        },
        scope: "controle:read",
        roles: ["head", "team"],
        access: "read",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        async handler(ctx, input) {
            const r = asService(
                await getTabularReviewDetail(ctx.db, {
                    reviewId: input.review_id,
                    userId: ctx.caller.userId,
                    userEmail: ctx.caller.userEmail || undefined,
                }),
            );
            if (!r.ok) return r.kind === "not_found" ? failure("not_found", "Tabela não encontrada.") : r;
            const review = r.data.review as { title?: string | null; columns_config?: Column[] | null; is_running?: boolean };
            const columns = [...(review.columns_config ?? [])].sort((a, b) => a.index - b.index);
            const rows = [...(r.data.rows as Row[])].sort((a, b) => a.sort_index - b.sort_index);
            const cells = r.data.cells as Cell[];
            const byRow = new Map<string, Map<number, Cell>>();
            for (const c of cells) {
                const m = byRow.get(c.row_id) ?? new Map<number, Cell>();
                m.set(c.column_index, c);
                byRow.set(c.row_id, m);
            }
            const start = input.a_partir_de ?? 0;
            const limit = input.limite ?? 20;
            return ok({
                titulo: review.title ?? "Sem título",
                gerando: review.is_running === true,
                colunas: columns.map((c) => c.name),
                linhas: rows.slice(start, start + limit).map((row) => ({
                    documento: row.label,
                    celulas: Object.fromEntries(
                        columns.map((col) => {
                            const cell = byRow.get(row.id)?.get(col.index);
                            const content = parseCellContent(cell?.content);
                            return [
                                col.name,
                                {
                                    valor: content?.summary ?? null,
                                    sinal: content?.flag ? (FLAG_LABEL[content.flag] ?? content.flag) : null,
                                    situacao: cell?.status ?? "vazia",
                                    citacoes: Array.isArray(cell?.citations) ? cell!.citations : [],
                                },
                            ];
                        }),
                    ),
                })),
                total_linhas: rows.length,
                proximo: start + limit < rows.length ? start + limit : null,
                link: tabularLink(input.review_id),
            });
        },
        summary: (o) =>
            `${o.titulo}: ${o.total_linhas} documento(s) × ${o.colunas.length} coluna(s)${o.gerando ? " (ainda gerando)" : ""}.`,
    }),
];
