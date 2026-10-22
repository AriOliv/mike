// The regulatory radar's MCP tools (doc 09 §4.1): an agent reads the changes
// the person's scans found and which contracts each one touches, through the
// same functions and visibility as the radar screen. Affected contracts the
// person cannot open stay a count, never a name.

import { z } from "zod";
import { ok } from "../../lib/serviceResult";
import { defineTool, uuidId, type AnyMcpTool } from "../mcp/mcp.service";
import { getChange, listChanges, type RegulatoryChange } from "./regulatory.changes";

const TAB = { abertas: "todas", nao_lidas: "nao_lidas", favoritas: "favoritas", arquivadas: "arquivadas" } as const;
const IMPACT_LABEL: Record<string, string> = { alto: "alto", medio: "médio", baixo: "baixo" };

/** The radar screen (it opens a change from the list, not by URL). */
function radarLink(): string {
    const base = (process.env.FRONTEND_URL ?? "").replace(/\/+$/, "");
    return `${base}/radar-regulatorio`;
}

function situacao(c: RegulatoryChange): string {
    if (c.request_project_id) return "virou_pedido";
    if (c.obligation_id) return "nos_prazos";
    return String(c.status);
}

function shape(c: RegulatoryChange) {
    return {
        change_id: c.id,
        titulo: c.title,
        orgao: c.issuer,
        tipo_ato: c.act_type,
        fonte: c.source,
        publicado_em: c.published_at,
        url_oficial: c.url,
        resumo: c.summary,
        citacao_oficial: c.summary_quote,
        impacto: c.impact,
        motivo_do_impacto: c.impact_reason,
        vigencia: c.effective_date,
        acao_sugerida: c.suggested_action,
        situacao: situacao(c),
        favorita: c.starred === true,
        contratos_afetados: c.affected.length + c.affected_hidden,
        link: radarLink(),
    };
}

export const REGULATORY_TOOLS: AnyMcpTool[] = [
    defineTool({
        name: "mike_radar_mudancas",
        title: "Mudanças regulatórias do radar",
        description:
            "As mudanças regulatórias que as varreduras da pessoa encontraram (BCB, DOU, ANPD, CVM, COAF, Receita), " +
            "com resumo, a citação do texto oficial, impacto (alto, médio, baixo) e o motivo, vigência, quantos contratos " +
            "afeta e a situação. Mais impactantes primeiro.",
        input: {
            aba: z.enum(["abertas", "nao_lidas", "favoritas", "arquivadas"]).optional().describe("Padrão: abertas."),
            busca: z.string().min(1).max(200).optional().describe("Filtra por título, órgão ou trecho."),
            limite: z.number().int().min(1).max(50).optional().describe("Quantas (até 50; padrão 20)."),
        },
        scope: "radar:read",
        roles: ["head", "team"],
        access: "read",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        async handler(ctx, input) {
            const r = await listChanges(ctx.db, ctx.caller, { tab: TAB[input.aba ?? "abertas"], q: input.busca });
            if (!r.ok) return r;
            const limit = input.limite ?? 20;
            return ok({
                mudancas: r.data.changes.slice(0, limit).map(shape),
                total: r.data.changes.length,
                contagem: { abertas: r.data.tabs.todas, nao_lidas: r.data.tabs.nao_lidas, favoritas: r.data.tabs.favoritas, arquivadas: r.data.tabs.arquivadas },
            });
        },
        summary: (o) => {
            if (o.total === 0) return "Nenhuma mudança regulatória nesta aba.";
            const altas = o.mudancas.filter((m) => m.impacto === "alto").length;
            return `${o.total} mudança(s)${altas ? `, ${altas} de impacto alto` : ""}; ${o.contagem.nao_lidas} não lida(s).`;
        },
    }),
    defineTool({
        name: "mike_radar_contratos_afetados",
        title: "Contratos afetados por uma mudança",
        description:
            "Os contratos que uma mudança regulatória afeta, com o termo que casou e o trecho do contrato. " +
            "Contratos que a pessoa não pode abrir aparecem só como uma contagem.",
        input: { change_id: uuidId().describe("Id da mudança, como vem de mike_radar_mudancas.") },
        scope: "radar:read",
        roles: ["head", "team"],
        access: "read",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        async handler(ctx, input) {
            const r = await getChange(ctx.db, ctx.caller, input.change_id);
            if (!r.ok) return r;
            const base = (process.env.FRONTEND_URL ?? "").replace(/\/+$/, "");
            return ok({
                mudanca: shape(r.data),
                afetados: r.data.affected.map((a) => ({
                    project_id: a.project_id,
                    contrato: a.name,
                    contraparte: a.counterparty,
                    termo: a.term,
                    trecho: a.quote,
                    link: `${base}/projects/${a.project_id}/review`,
                })),
                ocultos: r.data.affected_hidden,
            });
        },
        summary: (o) =>
            `${o.mudanca.titulo}: impacto ${IMPACT_LABEL[String(o.mudanca.impacto)] ?? o.mudanca.impacto}, ${o.afetados.length} contrato(s) afetado(s)${o.ocultos ? ` e ${o.ocultos} que você não vê` : ""}.`,
    }),
];
