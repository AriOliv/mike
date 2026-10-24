// The CNPJ lookup as an MCP tool (L-54): the same record and cache as the
// counterparty field. Public company data only; no contract is read.

import { z } from "zod";
import { ok } from "../../lib/serviceResult";
import { defineTool, type AnyMcpTool } from "../mcp/mcp.service";
import { cnpjLookupEnabled, lookupCnpj } from "./cnpj.lookup";

export const CNPJ_TOOLS: AnyMcpTool[] = [
    defineTool({
        name: "mike_cnpj_consultar",
        title: "Consultar CNPJ",
        description:
            "Consulta um CNPJ nos dados públicos da Receita: razão social, situação, natureza jurídica, CNAE principal, " +
            "porte, endereço e contato da empresa. Use para qualificar a outra parte de um contrato.",
        input: { cnpj: z.string().min(11).max(20).describe("CNPJ com ou sem pontuação.") },
        scope: "contratos:read",
        roles: ["head", "team"],
        access: "read",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        async handler(ctx, input) {
            const r = await lookupCnpj(ctx.db, input.cnpj);
            return r.ok ? ok(r.data) : r;
        },
        summary: (o) => `${o.razao_social} (${o.situacao ?? "situação não informada"}), fonte ${o.fonte}.`,
    }),
];

export { cnpjLookupEnabled };
