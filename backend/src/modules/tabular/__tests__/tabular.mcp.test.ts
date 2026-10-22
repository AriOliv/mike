// The Controle de Contratos over MCP: lists in the token's workspace, reads
// the grid through getTabularReviewDetail (which already drops rows of
// documents the person cannot read). Fictional data only.

import { beforeEach, describe, expect, it, vi } from "vitest";

const reviews = vi.hoisted(() => ({ listTabularReviews: vi.fn(), getTabularReviewDetail: vi.fn() }));
vi.mock("../tabular.reviews", () => reviews);
vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn(async () => undefined) }));

import { failure, ok } from "../../../lib/serviceResult";
import { runToolForTest } from "../../mcp/__tests__/runToolForTest";
import { TABULAR_TOOLS } from "../tabular.mcp";

const tool = (name: string) => TABULAR_TOOLS.find((t) => t.name === name)!;
const REVIEW = "00000000-0000-4000-d000-000000000001";

beforeEach(() => {
    reviews.listTabularReviews.mockReset();
    reviews.getTabularReviewDetail.mockReset();
    process.env.FRONTEND_URL = "https://mike.exemplo.test";
});

describe("mike_controle_listar", () => {
    it("lists the person's grids in the token's workspace, newest first", async () => {
        reviews.listTabularReviews.mockResolvedValue(
            ok([{ id: REVIEW, title: "Controle de Contratos", columns_config: [{ index: 0, name: "Vigência" }, { index: 1, name: "Multa" }], document_ids: ["d1", "d2"], updated_at: "2026-10-21T09:00:00Z" }]),
        );
        const { result, ctx } = await runToolForTest(tool("mike_controle_listar"), { busca: "controle" }, { workspace: "org-1" });
        expect(reviews.listTabularReviews).toHaveBeenCalledWith(ctx.db, expect.objectContaining({
            userId: ctx.caller.userId,
            userEmail: ctx.caller.userEmail,
            scope: "all",
            searchTerm: "controle",
            sort: { key: "updated", direction: "desc" },
            workspace: "org-1",
            pagination: { limit: 20, offset: 0 },
        }));
        expect(result.structuredContent).toEqual({
            tabelas: [{ review_id: REVIEW, titulo: "Controle de Contratos", colunas: ["Vigência", "Multa"], documentos: 2, atualizada_em: "2026-10-21T09:00:00Z", link: `https://mike.exemplo.test/tabular-reviews/${REVIEW}` }],
        });
        reviews.listTabularReviews.mockResolvedValueOnce(ok([]));
        expect((await runToolForTest(tool("mike_controle_listar"), {})).result.content).toEqual([{ type: "text", text: "Nenhuma tabela de análise." }]);
    });
});

describe("mike_controle_ler", () => {
    const detail = {
        review: { title: "Controle de Contratos", columns_config: [{ index: 1, name: "Multa" }, { index: 0, name: "Vigência" }], is_running: false },
        rows: [
            { id: "r2", label: "nda-beta.pdf", sort_index: 1 },
            { id: "r1", label: "saas-nuvem.pdf", sort_index: 0 },
        ],
        cells: [
            { row_id: "r1", column_index: 0, content: { summary: "Até 31/03/2027", flag: "green" }, citations: [{ quote: "vigerá até 31/03/2027" }], status: "done" },
            { row_id: "r1", column_index: 1, content: { summary: "20% do valor", flag: "red" }, citations: [], status: "done" },
            { row_id: "r2", column_index: 0, content: null, citations: null, status: "pending" },
        ],
        documents: [],
    };

    it("reads the grid in row and column order, with flags and citations", async () => {
        reviews.getTabularReviewDetail.mockResolvedValue(ok(detail));
        const { result, ctx } = await runToolForTest(tool("mike_controle_ler"), { review_id: REVIEW });
        expect(reviews.getTabularReviewDetail).toHaveBeenCalledWith(ctx.db, { reviewId: REVIEW, userId: ctx.caller.userId, userEmail: ctx.caller.userEmail });
        expect(result.structuredContent).toMatchObject({
            titulo: "Controle de Contratos",
            colunas: ["Vigência", "Multa"],
            total_linhas: 2,
            proximo: null,
            linhas: [
                {
                    documento: "saas-nuvem.pdf",
                    celulas: {
                        "Vigência": { valor: "Até 31/03/2027", sinal: "ok", situacao: "done", citacoes: [{ quote: "vigerá até 31/03/2027" }] },
                        Multa: { valor: "20% do valor", sinal: "risco", situacao: "done", citacoes: [] },
                    },
                },
                { documento: "nda-beta.pdf", celulas: { "Vigência": { valor: null, sinal: null, situacao: "pending" }, Multa: { valor: null, situacao: "vazia" } } },
            ],
        });
        expect(result.content).toEqual([{ type: "text", text: "Controle de Contratos: 2 documento(s) × 2 coluna(s)." }]);
    });

    it("pages by rows, says when it is still generating, and keeps not_found", async () => {
        reviews.getTabularReviewDetail.mockResolvedValueOnce(ok({ ...detail, review: { ...detail.review, is_running: true } }));
        const page = await runToolForTest(tool("mike_controle_ler"), { review_id: REVIEW, limite: 1 });
        expect(page.result.structuredContent).toMatchObject({ proximo: 1 });
        expect((page.result.structuredContent as { linhas: unknown[] }).linhas).toHaveLength(1);
        expect(page.result.content).toEqual([{ type: "text", text: "Controle de Contratos: 2 documento(s) × 2 coluna(s) (ainda gerando)." }]);

        reviews.getTabularReviewDetail.mockResolvedValueOnce(failure("not_found", "Review not found"));
        expect((await runToolForTest(tool("mike_controle_ler"), { review_id: REVIEW })).result).toMatchObject({
            structuredContent: { error: { code: "not_found", message: "Tabela não encontrada." } },
        });
        reviews.getTabularReviewDetail.mockResolvedValueOnce({ ok: false, kind: "status", status: 403, body: {} });
        expect((await runToolForTest(tool("mike_controle_ler"), { review_id: REVIEW })).result).toMatchObject({ structuredContent: { error: { code: "forbidden" } } });
        reviews.getTabularReviewDetail.mockResolvedValueOnce({ ok: false, kind: "status", status: 502, body: {} });
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect((await runToolForTest(tool("mike_controle_ler"), { review_id: REVIEW })).result).toMatchObject({ structuredContent: { error: { code: "internal" } } });
        spy.mockRestore();
    });

    it("is for the Legal team with controle:read", () => {
        for (const t of TABULAR_TOOLS) expect(t).toMatchObject({ scope: "controle:read", roles: ["head", "team"], access: "read" });
    });
});
