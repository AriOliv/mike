// The portfolio and Ficha MCP tools, run through the real MCP runner: the
// person's Caller and workspace reach the services, outputs are shaped for
// agents, and failures stay the screen's. Fictional contracts only.

import { beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({ listContractPortfolio: vi.fn(), getFicha: vi.fn(), listContractReviews: vi.fn(), getContractReview: vi.fn() }));
vi.mock("../contractReview.portfolio", () => ({ listContractPortfolio: svc.listContractPortfolio }));
vi.mock("../contractReview.fichaService", () => ({ getFicha: svc.getFicha }));
vi.mock("../contractReview.reviews", () => ({ listContractReviews: svc.listContractReviews, getContractReview: svc.getContractReview }));
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
    svc.listContractReviews.mockReset();
    svc.getContractReview.mockReset();
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

describe("mike_revisao_listar and mike_revisao_ler", () => {
    const RUN = "00000000-0000-4000-c000-000000000009";
    const clause = (verdict: string, over: Record<string, unknown> = {}) => ({
        id: `f-${verdict}`,
        ruleId: "r",
        topicId: null,
        ruleName: `Regra ${verdict}`,
        status: "needs_review",
        quote: "a multa será de 50%",
        location: "Cláusula 9",
        analysis: "Multa acima da posição.",
        suggestedText: "a multa será de 10%",
        verdict,
        playbook_status: "needs_review",
        covered: true,
        sources: [
            { kind: "playbook", label: "Multa", position: "Até 10%", criteria: "Acima de 20% diverge" },
            { kind: "ficha", path: "rescisao.multa_rescisoria", label: "Multa", state: "pendente", quote: null },
        ],
        rule_findings: [{ titulo: "Multa alta", severidade: "alta" }],
        precedent: null,
        decision: null,
        ...over,
    });

    it("lists the reviews with their counts", async () => {
        svc.listContractReviews.mockResolvedValue(
            ok([{ id: RUN, status: "completed", started_at: "2026-10-20T10:00:00Z", playbook_name: "Playbook Avenia v1", counts: { alinhado: 8, precisa_revisao: 6, diverge: 3 } }]),
        );
        const { result, ctx } = await runToolForTest(tool("mike_revisao_listar"), { project_id: P1 });
        expect(svc.listContractReviews).toHaveBeenCalledWith(ctx.db, ctx.caller, P1);
        expect(result.structuredContent).toMatchObject({ revisoes: [{ review_id: RUN, playbook: "Playbook Avenia v1", alinhadas: 8, precisam_revisao: 6, divergem: 3 }] });
        expect(result.content).toEqual([{ type: "text", text: "1 revisão(ões); a mais recente (Playbook Avenia v1): 3 divergem, 6 pedem revisão." }]);
        svc.listContractReviews.mockResolvedValueOnce(ok([]));
        expect((await runToolForTest(tool("mike_revisao_listar"), { project_id: P1 })).result.content).toEqual([{ type: "text", text: "Este contrato ainda não foi revisado por playbook." }]);
    });

    it("reads each clause with the playbook's position and the Legal's decision, filtered by verdict", async () => {
        svc.getContractReview.mockResolvedValue(
            ok({
                id: RUN,
                status: "completed",
                error: null,
                summary: "Três pontos divergem.",
                started_at: "2026-10-20T10:00:00Z",
                completed_at: "2026-10-20T10:05:00Z",
                model: "m",
                playbook: { id: "pb", name: "Playbook Avenia v1" },
                document: { id: "d1", name: "nda.docx", edited_version_id: null },
                clauses: [
                    clause("diverge", { decision: { decision: "editado", edited_text: "multa de 15%", reason: "acordo comercial", decided_by: "Duda", decided_at: "2026-10-20T11:00:00Z", edit: null } }),
                    clause("alinhado", { suggestedText: "" }),
                ],
                uncovered: [{ titulo: "Foro fora de SP", severidade: "media", justificativa: "Foro em outra comarca." }],
            }),
        );
        const { result, ctx } = await runToolForTest(tool("mike_revisao_ler"), { project_id: P1, review_id: RUN, vereditos: ["diverge"] });
        expect(svc.getContractReview).toHaveBeenCalledWith(ctx.db, ctx.caller, P1, RUN);
        const out = result.structuredContent as { clausulas: Record<string, unknown>[]; contagem: unknown };
        expect(out.contagem).toEqual({ alinhadas: 1, precisam_revisao: 0, divergem: 1, nao_se_aplicam: 0 });
        expect(out.clausulas).toEqual([
            {
                regra: "Regra diverge",
                veredito: "diverge",
                local: "Cláusula 9",
                trecho: "a multa será de 50%",
                analise: "Multa acima da posição.",
                redacao_sugerida: "a multa será de 10%",
                posicao_do_playbook: [{ posicao: "Até 10%", criterio: "Acima de 20% diverge" }],
                alertas_da_ficha: [{ titulo: "Multa alta", severidade: "alta" }],
                decisao: { decisao: "editado", texto_editado: "multa de 15%", motivo: "acordo comercial", por: "Duda", em: "2026-10-20T11:00:00Z" },
            },
        ]);
        expect(result.structuredContent).toMatchObject({ fora_do_playbook: [{ titulo: "Foro fora de SP" }], aviso: "Veredito do agente; a decisão sobre cada cláusula é do Legal." });
        expect(result.content).toEqual([{ type: "text", text: "Revisão pelo playbook Playbook Avenia v1: 1 diverge, 0 precisa de revisão, 1 alinhada." }]);
        expect(events.recordAgentRead).toHaveBeenCalledWith(ctx.db, expect.objectContaining({ projectId: P1, tool: "mike_revisao_ler" }));
    });

    it("says when a review is still running or failed, and keeps not_found", async () => {
        svc.getContractReview.mockResolvedValueOnce(
            ok({ id: RUN, status: "running", error: null, summary: null, started_at: "x", completed_at: null, model: "m", playbook: { id: "pb", name: "P" }, document: { id: null, name: null, edited_version_id: null }, clauses: [], uncovered: [] }),
        );
        expect((await runToolForTest(tool("mike_revisao_ler"), { project_id: P1, review_id: RUN })).result.content).toEqual([{ type: "text", text: "Revisão running." }]);
        svc.getContractReview.mockResolvedValueOnce(failure("not_found", "Revisão não encontrada."));
        expect((await runToolForTest(tool("mike_revisao_ler"), { project_id: P1, review_id: RUN })).result).toMatchObject({ structuredContent: { error: { code: "not_found" } } });
    });
});

describe("gating", () => {
    it("is for the Legal team with its scope, never for a requester", () => {
        expect(CONTRACT_REVIEW_TOOLS.map((t) => [t.name, t.scope, !!t.recordsRead])).toEqual([
            ["mike_contratos_buscar", "contratos:read", false],
            ["mike_contratos_ficha", "contratos:read", true],
            ["mike_revisao_listar", "revisao:read", false],
            ["mike_revisao_ler", "revisao:read", true],
        ]);
        for (const t of CONTRACT_REVIEW_TOOLS) {
            expect(t.roles).toEqual(["head", "team"]);
            expect(t.access).toBe("read");
        }
    });
});
