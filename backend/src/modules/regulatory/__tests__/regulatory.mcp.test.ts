// The radar's MCP tools over the radar's own functions: same visibility, the
// affected contracts the person cannot open stay a count. Fictional acts.

import { beforeEach, describe, expect, it, vi } from "vitest";

const changes = vi.hoisted(() => ({ listChanges: vi.fn(), getChange: vi.fn() }));
vi.mock("../regulatory.changes", () => changes);
vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn(async () => undefined) }));

import { failure, ok } from "../../../lib/serviceResult";
import { runToolForTest } from "../../mcp/__tests__/runToolForTest";
import { REGULATORY_TOOLS } from "../regulatory.mcp";

const tool = (name: string) => REGULATORY_TOOLS.find((t) => t.name === name)!;
// The preview seed's fixed ids are not RFC variant uuids; Postgres takes them, so must the tools.
const CHANGE = "00000000-0000-4000-e000-000000000001";

const change = (over: Record<string, unknown> = {}) => ({
    id: CHANGE,
    scan_id: "s1",
    source: "bcb",
    title: "Resolução BCB nº 9.001 (fictícia)",
    act_type: "Resolução BCB",
    issuer: "BCB",
    published_at: "2026-10-19",
    url: "https://www.bcb.gov.br/exemplo",
    summary: "Muda o prazo de liquidação.",
    summary_quote: "o prazo passa a ser D+1",
    impact: "alto",
    impact_reason: "Afeta contratos de liquidação.",
    effective_date: "2026-12-01",
    suggested_action: "Revisar cláusula de liquidação.",
    status: "nova",
    starred: false,
    request_project_id: null,
    obligation_id: null,
    affected: [{ project_id: "p1", name: "Parceria — Zeta", counterparty: "Zeta", term: "liquidação", quote: "liquidação em D+2" }],
    affected_hidden: 2,
    ...over,
});

beforeEach(() => {
    changes.listChanges.mockReset();
    changes.getChange.mockReset();
    process.env.FRONTEND_URL = "https://mike.exemplo.test";
});

describe("mike_radar_mudancas", () => {
    it("reads the open tab by default and shapes each change with its official quote", async () => {
        changes.listChanges.mockResolvedValue(ok({ changes: [change(), change({ id: "c2", impact: "baixo", status: "lida", request_project_id: "p9" })], tabs: { todas: 2, nao_lidas: 1, favoritas: 0, arquivadas: 3 } }));
        const { result, ctx } = await runToolForTest(tool("mike_radar_mudancas"), { busca: "liquidação", limite: 1 });
        expect(changes.listChanges).toHaveBeenCalledWith(ctx.db, ctx.caller, { tab: "todas", q: "liquidação" });
        expect(result.structuredContent).toMatchObject({
            total: 2,
            contagem: { abertas: 2, nao_lidas: 1, favoritas: 0, arquivadas: 3 },
            mudancas: [
                {
                    change_id: CHANGE,
                    orgao: "BCB",
                    url_oficial: "https://www.bcb.gov.br/exemplo",
                    citacao_oficial: "o prazo passa a ser D+1",
                    impacto: "alto",
                    vigencia: "2026-12-01",
                    situacao: "nova",
                    contratos_afetados: 3,
                    link: "https://mike.exemplo.test/radar-regulatorio",
                },
            ],
        });
        expect(result.content).toEqual([{ type: "text", text: "2 mudança(s), 1 de impacto alto; 1 não lida(s)." }]);
    });

    it("maps the tabs, marks what became work, and says when a tab is empty", async () => {
        changes.listChanges.mockResolvedValueOnce(ok({ changes: [change({ request_project_id: "p9" }), change({ obligation_id: "o1" })], tabs: { todas: 0, nao_lidas: 0, favoritas: 0, arquivadas: 2 } }));
        const { result } = await runToolForTest(tool("mike_radar_mudancas"), { aba: "arquivadas" });
        expect(changes.listChanges.mock.calls[0][2]).toMatchObject({ tab: "arquivadas" });
        expect((result.structuredContent as { mudancas: { situacao: string }[] }).mudancas.map((m) => m.situacao)).toEqual(["virou_pedido", "nos_prazos"]);
        changes.listChanges.mockResolvedValueOnce(ok({ changes: [], tabs: { todas: 0, nao_lidas: 0, favoritas: 0, arquivadas: 0 } }));
        expect((await runToolForTest(tool("mike_radar_mudancas"), { aba: "nao_lidas" })).result.content).toEqual([{ type: "text", text: "Nenhuma mudança regulatória nesta aba." }]);
    });
});

describe("mike_radar_contratos_afetados", () => {
    it("lists the contracts the person can open, and only counts the others", async () => {
        changes.getChange.mockResolvedValue(ok(change()));
        const { result, ctx } = await runToolForTest(tool("mike_radar_contratos_afetados"), { change_id: CHANGE });
        expect(changes.getChange).toHaveBeenCalledWith(ctx.db, ctx.caller, CHANGE);
        expect(result.structuredContent).toMatchObject({
            afetados: [{ project_id: "p1", contrato: "Parceria — Zeta", termo: "liquidação", trecho: "liquidação em D+2", link: "https://mike.exemplo.test/projects/p1/review" }],
            ocultos: 2,
        });
        expect(JSON.stringify(result.structuredContent)).not.toMatch(/p2|p3/);
        expect(result.content).toEqual([{ type: "text", text: "Resolução BCB nº 9.001 (fictícia): impacto alto, 1 contrato(s) afetado(s) e 2 que você não vê." }]);
    });

    it("keeps not_found for a change outside the person's scans", async () => {
        changes.getChange.mockResolvedValue(failure("not_found", "Mudança não encontrada."));
        expect((await runToolForTest(tool("mike_radar_contratos_afetados"), { change_id: CHANGE })).result).toMatchObject({
            isError: true,
            structuredContent: { error: { code: "not_found", message: "Mudança não encontrada." } },
        });
    });

    it("is for the Legal team with radar:read", () => {
        for (const t of REGULATORY_TOOLS) expect(t).toMatchObject({ scope: "radar:read", roles: ["head", "team"], access: "read" });
    });
});
