// The Painel do Legal over MCP: the head only, the token's workspace, and
// team totals instead of a list of named people. Fictional data.

import { beforeEach, describe, expect, it, vi } from "vitest";

const metrics = vi.hoisted(() => ({ getDashboard: vi.fn() }));
vi.mock("../dashboard.metrics", () => metrics);
vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn(async () => undefined) }));

import { failure, ok } from "../../../lib/serviceResult";
import { runToolForTest } from "../../mcp/__tests__/runToolForTest";
import { DASHBOARD_TOOLS } from "../dashboard.mcp";

const tool = DASHBOARD_TOOLS[0];
const dashboard = {
    period_days: 90,
    generated_at: "2026-10-21T12:00:00Z",
    volume: { opened: 12, closed: 3, open: 9, weekly: [], by_type: [], by_requester: [] },
    agents: { contracts_reviewed_by_agents: 6, contracts_reviewed_by_people: 0, playbook_runs: 0, terms_extracted: 5, regulatory_changes_triaged: 4, regulatory_turned_into_work: 0 },
    hours_saved: { hours: 11.7, assumptions: {}, formula: "6 revisões × 90 min" },
    adoption: {
        people: [
            { email: "duda@exemplo.test", assigned_open: 3, closed: 2, reviews_run: 0 },
            { email: "teo@exemplo.test", assigned_open: 1, closed: 1, reviews_run: 0 },
        ],
        reviews_by_user_id: [{ user_id: "u1", count: 4 }],
    },
    ai_cost: null,
};

beforeEach(() => metrics.getDashboard.mockReset());

describe("mike_painel_metricas", () => {
    it("reads the period in the token's workspace and keeps people's names out", async () => {
        metrics.getDashboard.mockResolvedValue(ok(dashboard));
        const { result, ctx } = await runToolForTest(tool, { periodo: 30 }, { role: "head", workspace: "org-1" });
        expect(metrics.getDashboard).toHaveBeenCalledWith(ctx.db, ctx.caller, { period: "30" }, expect.any(Date), "org-1");
        expect(result.structuredContent).toMatchObject({
            volume: { opened: 12 },
            hours_saved: { hours: 11.7, formula: "6 revisões × 90 min" },
            adoption: { people: 2, assigned_open: 4, closed: 3, reviews_run: 4 },
        });
        expect(JSON.stringify(result)).not.toMatch(/duda@|teo@|u1/);
        expect(result.content).toEqual([
            { type: "text", text: "Últimos 90 dias: 12 pedido(s) recebido(s), 3 concluído(s), 9 em aberto; 6 contrato(s) revisado(s) por agentes; 11.7 h poupadas (estimativa)." },
        ]);
    });

    it("defaults to 90 days and is for the head of Legal only", async () => {
        metrics.getDashboard.mockResolvedValue(ok(dashboard));
        await runToolForTest(tool, {}, { role: "head" });
        expect(metrics.getDashboard.mock.calls[0][2]).toEqual({ period: "90" });
        expect(tool).toMatchObject({ scope: "painel:read", roles: ["head"] });
        const team = await runToolForTest(tool, {}, { role: "team" });
        expect(team.result).toMatchObject({ isError: true, structuredContent: { error: { code: "forbidden" } } });
        expect((await runToolForTest(tool, { periodo: 45 }, { role: "head" })).result).toMatchObject({ structuredContent: { error: { code: "invalid_input" } } });
        metrics.getDashboard.mockResolvedValueOnce(failure("validation", "x"));
        expect((await runToolForTest(tool, {}, { role: "head" })).result).toMatchObject({ isError: true });
    });
});
