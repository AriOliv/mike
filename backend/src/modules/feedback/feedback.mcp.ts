// The feedback tool for agents (doc 13 §4): the same report as the app's
// modal, sent for a person. It only writes to the Mike; the job files the
// issue, so the tool never reaches outside (no openWorldHint). Two steps like
// every write: an agent cannot fill the tracker without the person's ok.

import { z } from "zod";
import { ok } from "../../lib/serviceResult";
import { defineTool, type AnyMcpTool } from "../mcp/mcp.service";
import { parseReport, submitReport } from "./feedback.reports";
import { redact } from "./feedback.redact";

export const FEEDBACK_TOOL = "mike_feedback_reportar";

export const FEEDBACK_TOOLS: AnyMcpTool[] = [
    defineTool({
        name: FEEDBACK_TOOL,
        title: "Reportar um problema ou sugerir uma melhoria no Mike",
        description:
            "Envia ao time de tecnologia um relato sobre o próprio Mike: algo que deu errado (`bug`) ou uma ideia (`feature`). " +
            "Não escreva dados de pessoas (nome, e-mail, CPF) nem trechos de contrato: e-mail, CPF, CNPJ e telefone são " +
            "apagados, mas nomes não. Use só quando a pessoa pedir para reportar.",
        input: {
            tipo: z.enum(["bug", "feature"]).describe("`bug`: algo deu errado. `feature`: uma ideia."),
            descricao: z.string().min(3).max(4000).describe("O que aconteceu, ou qual é a ideia."),
            esperado: z.string().max(1000).optional().describe("Só no bug: o que deveria ter acontecido."),
            rota: z.string().max(200).optional().describe("Página do Mike onde ocorreu, como /pedidos (sem parâmetros)."),
        },
        scope: "feedback:write",
        roles: ["head", "team", "requester"],
        access: "write",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        confirm: {
            async preview(_ctx, input) {
                const shown = redact(input.descricao).text;
                const cut = shown.length > 280 ? `${shown.slice(0, 280)}…` : shown;
                return ok({
                    resumo: `Enviar ao time de tecnologia um relato (${input.tipo === "bug" ? "algo deu errado" : "ideia"}): "${cut}"`,
                    detalhes: { tipo: input.tipo, rota: input.rota ?? null },
                });
            },
        },
        async handler(ctx, input) {
            const raw = { kind: input.tipo, body: input.descricao, expected: input.esperado, route: input.rota, role: ctx.role, org_id: ctx.workspace && ctx.workspace !== "personal" ? ctx.workspace : null };
            const parsed = parseReport(raw);
            if (!parsed.ok) return parsed;
            const r = await submitReport(ctx.db, ctx.caller, raw, { kind: "agent", client: ctx.clientName });
            return r.ok ? ok({ numero: r.data.label, redigido: r.data.redacted }) : r;
        },
        summary: (o) => `Relato ${o.numero} enviado ao time de tecnologia${o.redigido ? " (dados pessoais foram apagados do texto)" : ""}.`,
    }),
];
