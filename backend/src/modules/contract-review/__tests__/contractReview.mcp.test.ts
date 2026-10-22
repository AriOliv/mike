// The portfolio and Ficha MCP tools, run through the real MCP runner: the
// person's Caller and workspace reach the services, outputs are shaped for
// agents, and failures stay the screen's. Fictional contracts only.

import { beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({ listContractPortfolio: vi.fn(), getFicha: vi.fn() }));
vi.mock("../contractReview.portfolio", () => ({ listContractPortfolio: svc.listContractPortfolio }));
vi.mock("../contractReview.fichaService", () => ({ getFicha: svc.getFicha }));
vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn(async () => undefined) }));
const events = vi.hoisted(() => ({ recordAgentRead: vi.fn(async () => undefined) }));
vi.mock("../../contracts/contracts.service", () => events);

import { failure, ok } from "../../../lib/serviceResult";
import { runToolForTest } from "../../mcp/__tests__/runToolForTest";
import { CONTRACT_REVIEW_TOOLS } from "../contractReview.mcp";

const tool = (name: string) => CONTRACT_REVIEW_TOOLS.find((t) => t.name === name)!;
const P1 = "00000000-0000-4000-a000-000000000001";

const row = (id: string, name: string, counterparty: string, over: Record<string, unknown> = {}) => ({
    project_id: id,
    name,
    counterparty,
    contract_type: "saas",
    lane: "revisao",
    term_end: "2027-03-31",
    notice_days: 60,
    notice_deadline: "2027-01-30",
    filled: 10,
    verified: 4,
    total: 20,
    risk: "atencao",
    ...over,
});

beforeEach(() => {
    svc.listContractPortfolio.mockReset();
    svc.getFicha.mockReset();
    events.recordAgentRead.mockClear();
    process.env.FRONTEND_URL = "https://mike.exemplo.test/";
});

describe("mike_contratos_buscar", () => {
    it("reads every page of the person's portfolio in the token's workspace and filters by name, counterparty or type", async () => {
        svc.listContractPortfolio
            .mockResolvedValueOnce(ok({ rows: [row("p1", "SaaS — Nuvem Contábil", "Nuvem Contábil S.A.")], total: 2, next_offset: 100 }))
            .mockResolvedValueOnce(ok({ rows: [row("p2", "Locação — Ed. Sol", "Imobiliária Sol", { contract_type: "locacao" })], total: 2, next_offset: null }));
        const { result, ctx } = await runToolForTest(tool("mike_contratos_buscar"), { busca: "contabil" }, { workspace: "org-1" });

        expect(svc.listContractPortfolio).toHaveBeenNthCalledWith(1, ctx.db, ctx.caller, { limit: 100, offset: 0, sort: "nome" }, "org-1");
        expect(svc.listContractPortfolio).toHaveBeenNthCalledWith(2, ctx.db, ctx.caller, { limit: 100, offset: 100, sort: "nome" }, "org-1");
        expect(result.structuredContent).toMatchObject({
            total: 1,
            proximo: null,
            contratos: [
                {
                    project_id: "p1",
                    nome: "SaaS — Nuvem Contábil",
                    aviso_previo_ate: "2027-01-30",
                    ficha: { preenchidos: 10, verificados: 4, total: 20 },
                    link: "https://mike.exemplo.test/projects/p1/review",
                },
            ],
        });
        expect((result.content as { text: string }[])[0].text).toBe("1 contrato(s).");
    });

    it("pages its own results and passes the notice order through", async () => {
        const rows = Array.from({ length: 5 }, (_, i) => row(`p${i}`, `Contrato ${i}`, `Parte ${i}`));
        svc.listContractPortfolio.mockResolvedValue(ok({ rows, total: 5, next_offset: null }));
        const { result } = await runToolForTest(tool("mike_contratos_buscar"), { ordem: "aviso", limite: 2, a_partir_de: 2 });
        expect(svc.listContractPortfolio.mock.calls[0][2]).toMatchObject({ sort: "aviso" });
        expect(result.structuredContent).toMatchObject({ total: 5, proximo: 4 });
        expect((result.structuredContent as { contratos: { project_id: string }[] }).contratos.map((c) => c.project_id)).toEqual(["p2", "p3"]);
        expect((result.content as { text: string }[])[0].text).toBe("5 contrato(s), mostrando 2.");
    });

    it("says so when nothing matches, and surfaces the screen's failure", async () => {
        svc.listContractPortfolio.mockResolvedValueOnce(ok({ rows: [], total: 0, next_offset: null }));
        expect((await runToolForTest(tool("mike_contratos_buscar"), {})).result.content).toEqual([{ type: "text", text: "Nenhum contrato encontrado." }]);
        svc.listContractPortfolio.mockResolvedValueOnce(failure("validation", "Não entendi a página pedida."));
        expect((await runToolForTest(tool("mike_contratos_buscar"), {})).result).toMatchObject({ isError: true, structuredContent: { error: { code: "invalid_input" } } });
    });
});

describe("mike_contratos_ficha", () => {
    const fieldWith = (value: unknown, state = "pendente") => ({
        status: "encontrado",
        value,
        citations: [{ quote: "renova-se automaticamente por iguais períodos", clause: "12.1", span: { start: 10, end: 52 }, verified: true, match: "exato" }],
        confidence: "alta",
        origin: "ia",
        notes: null,
        review: { state, by: null, at: null, comment: null },
    });

    it("gives every field with its citations, whether a person verified it, and the risk alerts", async () => {
        svc.getFicha.mockResolvedValue(
            ok({
                ficha: {
                    "vigencia.renovacao": fieldWith({ tipo: "automatica" }, "confirmado"),
                    "identificacao.contraparte": fieldWith({ nome: "Nuvem Contábil S.A." }),
                },
                choices: {},
                findings: [
                    { rule_id: "r1", rules_version: "1", titulo: "Renovação automática com aviso curto", severidade: "atencao", justificativa: "Aviso de 30 dias.", acao_sugerida: "Agendar.", campos: ["vigencia.renovacao"], depende_de_campo_nao_validado: false },
                ],
                risk_overall: "atencao",
                progress: { verified: 1, total: 20 },
                document_id: "d1",
                extracted_at: "2026-10-20T10:00:00Z",
                model: "m",
            }),
        );
        const { result, ctx } = await runToolForTest(tool("mike_contratos_ficha"), { project_id: P1 });
        expect(svc.getFicha).toHaveBeenCalledWith(ctx.db, ctx.caller, P1);
        const out = result.structuredContent as { campos: Record<string, unknown>[]; alertas: unknown[] };
        expect(out).toMatchObject({ extraida: true, risco: "atencao", verificados: 1, total: 20, link: `https://mike.exemplo.test/projects/${P1}/review` });
        expect(out.campos.find((c) => c.campo === "vigencia.renovacao")).toEqual({
            campo: "vigencia.renovacao",
            rotulo: "Renovação",
            status: "encontrado",
            valor: { tipo: "automatica" },
            confianca: "alta",
            origem: "ia",
            verificado: true,
            revisao: "confirmado",
            citacoes: [{ trecho: "renova-se automaticamente por iguais períodos", clausula: "12.1", conferida_no_texto: true }],
        });
        expect(out.campos.find((c) => c.campo === "identificacao.contraparte")).toMatchObject({ verificado: false, revisao: "pendente" });
        expect(out.campos.find((c) => c.campo === "rescisao.imotivada")).toMatchObject({ status: "nao_extraido", valor: null, citacoes: [] });
        expect(out.alertas).toEqual([
            { titulo: "Renovação automática com aviso curto", severidade: "atencao", justificativa: "Aviso de 30 dias.", acao_sugerida: "Agendar.", campos: ["vigencia.renovacao"], depende_de_campo_nao_verificado: false },
        ]);
        expect((result.content as { text: string }[])[0].text).toBe("Ficha: 1 de 20 campos verificados, risco atenção, 1 alerta(s).");
        // The read enters the contract's activity feed as the agent acting for the person.
        expect(events.recordAgentRead).toHaveBeenCalledWith(ctx.db, {
            projectId: P1,
            actorId: "mcp:claude-code",
            actorName: "claude-code em nome de Ana Teste",
            onBehalfOf: "ana@exemplo.test",
            tool: "mike_contratos_ficha",
        });
    });

    it("narrows to the fields asked, says when there is no Ficha yet, and keeps not_found for a contract the person cannot see", async () => {
        svc.getFicha.mockResolvedValueOnce(ok({ ficha: null, choices: {}, findings: [], risk_overall: null, progress: { verified: 0, total: 20 }, document_id: null, extracted_at: null, model: null }));
        const { result } = await runToolForTest(tool("mike_contratos_ficha"), { project_id: P1, campos: ["vigencia.renovacao"] });
        expect((result.structuredContent as { campos: unknown[] }).campos).toHaveLength(1);
        expect((result.content as { text: string }[])[0].text).toBe("A Ficha deste contrato ainda não foi extraída.");

        events.recordAgentRead.mockClear();
        svc.getFicha.mockResolvedValueOnce(failure("not_found", "Não encontrei este contrato."));
        expect((await runToolForTest(tool("mike_contratos_ficha"), { project_id: P1 })).result).toMatchObject({
            isError: true,
            structuredContent: { error: { code: "not_found", message: "Não encontrei este contrato." } },
        });
        expect((await runToolForTest(tool("mike_contratos_ficha"), { project_id: "nao-e-uuid" })).result).toMatchObject({ structuredContent: { error: { code: "invalid_input" } } });
        // A refused read is not a read.
        expect(events.recordAgentRead).not.toHaveBeenCalled();
    });
});

describe("gating", () => {
    it("is for the Legal team with contratos:read, never for a requester", () => {
        expect(CONTRACT_REVIEW_TOOLS.map((t) => [t.name, !!t.recordsRead])).toEqual([
            ["mike_contratos_buscar", false],
            ["mike_contratos_ficha", true],
        ]);
        for (const t of CONTRACT_REVIEW_TOOLS) {
            expect(t.scope).toBe("contratos:read");
            expect(t.roles).toEqual(["head", "team"]);
            expect(t.access).toBe("read");
        }
    });
});
