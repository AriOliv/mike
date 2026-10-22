import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const contracts = vi.hoisted(() => ({
    LANES: ["entrada", "triagem", "revisao", "negociacao", "assinatura", "arquivado"] as const,
    listPipeline: vi.fn(),
    countAgentReviews: vi.fn(),
    REVIEW_AGENTS: ["revisor"] as const,
}));
vi.mock("../../contracts/contracts.service", () => contracts);
const regulatory = vi.hoisted(() => ({ visibleScanIds: vi.fn() }));
vi.mock("../../regulatory/regulatory.service", () => regulatory);

import { computeDashboard, DEFAULT_ASSUMPTIONS, getDashboard, parseDashboardQuery } from "../dashboard.service";
import { periodStart, weekOf } from "../dashboard.metrics";

const NOW = new Date("2026-10-20T12:00:00Z");
const caller = { userId: "u1", userEmail: "ana@avenia.io" };

const card = (over: Record<string, unknown>) => ({
    id: "c",
    lane: "entrada",
    status: "em_andamento",
    created_at: "2026-10-01T10:00:00Z",
    lane_updated_at: "2026-10-01T10:00:00Z",
    completed_at: null,
    deadline: null,
    assignee_email: null,
    contract_type: null,
    requester_name: null,
    ...over,
});

const cards = [
    // closed on time in 9 days
    card({ id: "a", lane: "arquivado", status: "concluido", completed_at: "2026-10-10", deadline: "2026-10-12", assignee_email: "duda@avenia.io", contract_type: "NDA", requester_name: "Ana Souza" }),
    // closed late in 19 days
    card({ id: "b", lane: "assinatura", status: "concluido", completed_at: "2026-10-20", deadline: "2026-10-15", assignee_email: "teo@avenia.io", contract_type: "NDA", requester_name: "Bruno Lima" }),
    // open in revision for 5 days, overdue
    card({ id: "c", lane: "revisao", lane_updated_at: "2026-10-15T12:00:00Z", deadline: "2026-10-18", assignee_email: "duda@avenia.io", contract_type: "MSA", requester_name: "Ana Souza" }),
    // open in entrada, created long ago (out of period for "opened")
    card({ id: "d", lane: "entrada", created_at: "2026-01-01T00:00:00Z", lane_updated_at: "2026-10-19T12:00:00Z" }),
];

const inputs = {
    cards: cards as never,
    dossiers: [
        { project_id: "a", source: "generated", created_at: "2026-10-05T00:00:00Z", user_id: "u1" },
        { project_id: "b", source: "import", created_at: "2026-10-06T00:00:00Z", user_id: "u1" },
        { project_id: "c", source: "import", created_at: "2026-10-06T00:00:00Z", user_id: "u1" },
    ],
    terms: [
        { project_id: "a", notice_deadline: "2026-11-01", extracted_at: "2026-10-05T00:00:00Z" },
        { project_id: "b", notice_deadline: "2026-10-01", extracted_at: "2026-09-01T00:00:00Z" },
        { project_id: "c", notice_deadline: null, extracted_at: "2026-10-07T00:00:00Z" },
    ],
    runs: [
        { document_id: "doc-c", user_id: "u1", status: "completed", started_at: "2026-10-08T00:00:00Z", completed_at: "2026-10-08T00:05:00Z" },
        { document_id: "doc-x", user_id: "u2", status: "failed", started_at: "2026-10-08T00:00:00Z", completed_at: null },
    ],
    changes: [
        { status: "lida", impact: "alto", request_project_id: "r1", obligation_id: null, created_at: "2026-10-10T00:00:00Z" },
        { status: "nova", impact: "baixo", request_project_id: null, obligation_id: null, created_at: "2026-10-11T00:00:00Z" },
    ],
    laneEvents: [
        // c: entrada 2026-10-01 → triagem 10-03 → revisao 10-15 (moves out of entrada and triagem)
        { project_id: "c", at: "2026-10-03T10:00:00Z", before: "entrada", after: "triagem" },
        { project_id: "c", at: "2026-10-15T10:00:00Z", before: "triagem", after: "revisao" },
        // b: entrada → assinatura after 4 days; then archived (archived stays are not measured)
        { project_id: "b", at: "2026-10-05T10:00:00Z", before: "entrada", after: "assinatura" },
        { project_id: "b", at: "2026-10-21T10:00:00Z", before: "assinatura", after: "arquivado" },
        { project_id: "b", at: "2026-10-01T09:00:00Z", before: null, after: "entrada" },
    ],
    agentRuns: [
        { project_id: "d", agent: "revisor", status: "succeeded", cost_usd: "0.25", started_at: "2026-10-09T00:00:00Z", finished_at: "2026-10-09T00:04:00Z" },
        { project_id: "d", agent: "extrator", status: "succeeded", cost_usd: 0.1, started_at: "2026-10-09T00:00:00Z" },
        { project_id: "a", agent: "notificador", status: "succeeded", cost_usd: null, started_at: "2026-10-09T00:00:00Z" },
        { project_id: "a", agent: "revisor", status: "failed", cost_usd: 0.05, started_at: "2025-01-01T00:00:00Z" },
    ],
    fichas: [
        {
            project_id: "a",
            ficha: {
                "identificacao.contraparte": { status: "preenchido", review: { state: "confirmado" } },
                "vigencia.data_vencimento": { status: "preenchido", review: { state: "pendente" } },
                "cessao.permitida": { status: "nao_aplicavel", review: { state: "pendente" } },
                "pagamento.valor": { status: "preenchido", review: { state: "corrigido" } },
                broken: null,
            },
        },
        { project_id: "b", ficha: null },
    ],
    // countAgentReviews' answer for the period: the home screen's number.
    agentReviews: 4,
    requestArea: new Map([
        ["a", "Comercial"],
        ["c", "Comercial"],
    ]),
    documentProject: new Map([["doc-c", "c"]]),
};

describe("computeDashboard", () => {
    const d = computeDashboard(inputs, { now: NOW, periodDays: 30, assumptions: DEFAULT_ASSUMPTIONS });

    it("counts volume, by type and by requesting area", () => {
        expect(d.volume).toMatchObject({ opened: 3, closed: 2, open: 2 });
        expect(d.volume.by_type).toEqual([
            { label: "NDA", count: 2 },
            { label: "MSA", count: 1 },
        ]);
        expect(d.volume.by_requester).toEqual([
            { label: "Comercial", count: 2 },
            { label: "Área não informada", count: 1 },
        ]);
        // The requester's name is never used as an area.
        expect(JSON.stringify(d.volume.by_requester)).not.toMatch(/Ana Souza|Bruno Lima/);
        expect(d.volume.weekly.reduce((n, w) => n + w.opened, 0)).toBe(3);
        expect(d.volume.weekly.reduce((n, w) => n + w.closed, 0)).toBe(2);
    });

    it("measures cycle time and what sits in each stage today", () => {
        // completed_at is a date: 8.6 and 18.6 days
        expect(d.cycle.median_days_to_close).toBe(13.6);
        expect(d.cycle.stage_age.find((s) => s.lane === "revisao")).toEqual({ lane: "revisao", open: 1, median_days: 5 });
        expect(d.cycle.stage_age.find((s) => s.lane === "triagem")).toEqual({ lane: "triagem", open: 0, median_days: null });
        expect(d.cycle.stage_age.map((s) => s.lane)).not.toContain("arquivado");
        expect(d.cycle.per_stage_history.find((s) => s.lane === "entrada")).toEqual({ lane: "entrada", moves: 2, median_days: 3 });
        expect(d.cycle.per_stage_history.find((s) => s.lane === "triagem")).toEqual({ lane: "triagem", moves: 1, median_days: 12 });
        expect(d.cycle.per_stage_moves).toBe(3);
    });

    it("measures SLA and the notice deadlines kept", () => {
        expect(d.sla).toEqual({ closed_with_deadline: 2, on_time: 1, rate: 50, open_overdue: 1 });
        expect(d.notice).toEqual({ due_in_30_days: 1, missed_in_period: 1 });
    });

    it("separates contracts reviewed by agents from those reviewed by people", () => {
        expect(d.agents).toEqual({
            contracts_reviewed_by_agents: 4,
            // b and c have an imported analysis and no generated one.
            contracts_reviewed_by_people: 2,
            playbook_runs: 1,
            terms_extracted: 2,
            regulatory_changes_triaged: 2,
            regulatory_turned_into_work: 1,
        });
    });

    it("shows hours saved with the formula it used", () => {
        expect(d.hours_saved.hours).toBe(7.2);
        expect(d.hours_saved.formula).toBe(
            "4 revisões × 90 min + 2 extrações de prazos × 20 min + 2 mudanças regulatórias × 15 min",
        );
    });

    it("counts the Ficha fields a person verified, leaving out what does not apply", () => {
        expect(d.ficha).toEqual({ contracts: 2, fields: 3, verified: 2, rate: 66.7 });
    });

    it("reports adoption per person and never invents an AI cost", () => {
        expect(d.adoption.people[0]).toEqual({ email: "duda@avenia.io", assigned_open: 1, closed: 1, reviews_run: 0 });
        expect(d.adoption.reviews_by_user_id).toEqual([{ user_id: "u1", count: 1 }]);
        expect(d.ai_cost).toEqual({
            total_usd: 0.35,
            runs: 2,
            per_contract_usd: 0.35,
            by_agent: [
                { agent: "revisor", usd: 0.25 },
                { agent: "extrator", usd: 0.1 },
            ],
        });
    });

    it("counts the same closed requests in the volume, the weekly chart, the cycle time and the SLA", () => {
        const sameDay = computeDashboard(
            {
                ...inputs,
                cards: [
                    // closed the day it was opened: 0 d, not dropped
                    card({ id: "s", lane: "arquivado", status: "concluido", created_at: "2026-10-12T15:00:00Z", completed_at: "2026-10-12", deadline: "2026-10-13" }),
                    // no completed_at: the lane move is the close date
                    card({ id: "m", lane: "arquivado", status: "concluido", created_at: "2026-10-02T00:00:00Z", lane_updated_at: "2026-10-06T00:00:00Z" }),
                ] as never,
            },
            { now: NOW, periodDays: 90, assumptions: DEFAULT_ASSUMPTIONS },
        );
        expect(sameDay.volume.closed).toBe(2);
        expect(sameDay.volume.weekly.reduce((n, w) => n + w.closed, 0)).toBe(2);
        expect(sameDay.cycle.closed_measured).toBe(2);
        expect(sameDay.cycle.median_days_to_close).toBe(2);
        expect(sameDay.sla).toMatchObject({ closed_with_deadline: 1, on_time: 1 });
    });

    it("handles an empty base", () => {
        const empty = computeDashboard(
            { cards: [], dossiers: [], terms: [], runs: [], changes: [], laneEvents: [], agentRuns: [], fichas: null, agentReviews: 0, requestArea: new Map(), documentProject: new Map() },
            { now: NOW, periodDays: 90, assumptions: DEFAULT_ASSUMPTIONS },
        );
        expect(empty.cycle.median_days_to_close).toBeNull();
        expect(empty.sla.rate).toBeNull();
        expect(empty.hours_saved.hours).toBe(0);
        expect(empty.volume.weekly.length).toBeGreaterThan(12);
        expect(empty.ai_cost).toBeNull();
        expect(empty.ficha).toBeNull();
        expect(empty.cycle.per_stage_moves).toBe(0);
    });

    it("weeks start on Monday", () => {
        expect(weekOf("2026-10-20T12:00:00Z")).toBe("2026-10-19");
        expect(weekOf("2026-10-25T23:00:00Z")).toBe("2026-10-19");
    });
});

describe("periodStart", () => {
    it("is the same window the dashboard counts in", () => {
        expect(periodStart(NOW, 30)).toBe("2026-09-20T12:00:00.000Z");
    });
});

describe("parseDashboardQuery", () => {
    it("accepts the known periods and sane minute assumptions", () => {
        expect(parseDashboardQuery({ period: "30", min_review: "60", min_terms: "-1", min_regulatory: "abc" })).toEqual({
            periodDays: 30,
            assumptions: { minutes_per_review: 60, minutes_per_terms: 20, minutes_per_regulatory_triage: 15 },
        });
        expect(parseDashboardQuery({ period: "7" }).periodDays).toBe(90);
    });
});

describe("getDashboard", () => {
    beforeEach(() => {
        contracts.listPipeline.mockReset();
        regulatory.visibleScanIds.mockReset();
        contracts.countAgentReviews.mockReset().mockResolvedValue(0);
    });

    const MISSING = { code: "PGRST205", message: "missing" };
    const NO_COLUMN = { code: "42703", message: "column does not exist" };

    it("reads only what belongs to the contracts and scans the caller sees", async () => {
        contracts.listPipeline.mockResolvedValue({ ok: true, data: { cards: [card({ id: "p1" })] } });
        regulatory.visibleScanIds.mockResolvedValue(["s1"]);
        const fake = scriptedDb([
            { table: "dossiers", data: [] },
            { table: "contract_terms", data: [] },
            { table: "documents", data: [{ id: "doc1", project_id: "p1" }] },
            { table: "playbook_runs", data: [] },
            { table: "card_events", data: [] },
            { table: "agent_runs", data: [] },
            { table: "contract_fichas", error: MISSING },
            { table: "projects", error: NO_COLUMN },
            { table: "legal_requests", error: MISSING },
            { table: "legal_requests", error: MISSING },
            { table: "regulatory_changes", data: [] },
        ]);
        const result = await getDashboard(fake.db, caller, { period: "30" }, NOW);
        // Tables other modules add, missing here: the dashboard still answers.
        expect(result).toMatchObject({
            ok: true,
            data: { period_days: 30, volume: { opened: 1, by_requester: [{ label: "Área não informada", count: 1 }] }, ficha: null },
        });
        expect(fake.calls[0].filters).toContainEqual(["in", "project_id", ["p1"]]);
        expect(fake.calls[3].filters).toContainEqual(["in", "document_id", ["doc1"]]);
        expect(fake.calls[4].filters).toContainEqual(["eq", "action", "lane.changed"]);
        expect(fake.calls[10].filters).toContainEqual(["in", "scan_id", ["s1"]]);
        // The reviewed count comes from the one shared function, over the
        // visible contracts and exactly the period's window.
        expect(contracts.countAgentReviews).toHaveBeenCalledWith(fake.db, ["p1"], periodStart(NOW, 30), NOW.toISOString());
        fake.done();
    });

    it("counts reviews like the home screen and groups requests by area, in fallback order", async () => {
        contracts.listPipeline.mockResolvedValue({
            ok: true,
            data: {
                cards: [
                    card({ id: "p1", requester_name: "Ana Souza" }),
                    card({ id: "p2", requester_name: "Bruno Lima" }),
                    card({ id: "p3", requester_name: "Carla Dias" }),
                    card({ id: "p4", requester_name: "Davi Reis" }),
                ],
            },
        });
        regulatory.visibleScanIds.mockResolvedValue([]);
        const fake = scriptedDb([
            { table: "dossiers", data: [] },
            { table: "contract_terms", data: [] },
            { table: "documents", data: [] },
            { table: "card_events", data: [] },
            { table: "agent_runs", data: [] },
            { table: "contract_fichas", data: [] },
            // The card's mirrored area wins.
            { table: "projects", data: [{ id: "p1", requester_area: "Comercial" }, { id: "p2", requester_area: null }] },
            // Then the request's area, then what triage read; "Outra" stays "Outra".
            {
                table: "legal_requests",
                data: [
                    { project_id: "p2", requester_area: "Outra", triage: { area: "Produto" } },
                    { project_id: "p3", requester_area: null, triage: { area: " Financeiro " } },
                    { project_id: "p4", requester_area: "", triage: null },
                ],
            },
        ]);
        contracts.countAgentReviews.mockResolvedValue(2);
        const result = await getDashboard(fake.db, caller, { period: "30" }, NOW);
        if (!result.ok) throw new Error("expected ok");
        expect(result.data.agents.contracts_reviewed_by_agents).toBe(2);
        expect(result.data.volume.by_requester).toEqual(
            expect.arrayContaining([
                { label: "Comercial", count: 1 },
                { label: "Outra", count: 1 },
                { label: "Financeiro", count: 1 },
                { label: "Área não informada", count: 1 },
            ]),
        );
        expect(JSON.stringify(result.data.volume.by_requester)).not.toMatch(/Ana|Bruno|Carla|Davi/);
        // Only the cards without a mirrored area are looked up in requests.
        expect(fake.calls[7].filters).toContainEqual(["in", "project_id", ["p2", "p3", "p4"]]);
        fake.done();
    });

    it("skips the request lookup when every card has its area, and falls back to triage before the area columns exist", async () => {
        contracts.listPipeline.mockResolvedValue({ ok: true, data: { cards: [card({ id: "p1" })] } });
        regulatory.visibleScanIds.mockResolvedValue([]);
        const mirrored = scriptedDb([
            { table: "dossiers", data: [] },
            { table: "contract_terms", data: [] },
            { table: "documents", data: [] },
            { table: "card_events", data: [] },
            { table: "agent_runs", data: [] },
            { table: "contract_fichas", data: [] },
            { table: "projects", data: [{ id: "p1", requester_area: "Produto" }] },
        ]);
        const first = await getDashboard(mirrored.db, caller, {}, NOW);
        expect(first).toMatchObject({ ok: true, data: { volume: { by_requester: [{ label: "Produto", count: 1 }] } } });
        mirrored.done();

        const triageOnly = scriptedDb([
            { table: "dossiers", data: [] },
            { table: "contract_terms", data: [] },
            { table: "documents", data: [] },
            { table: "card_events", data: [] },
            { table: "agent_runs", data: [] },
            { table: "contract_fichas", data: [] },
            { table: "projects", error: NO_COLUMN },
            { table: "legal_requests", error: { code: "PGRST204", message: "no column" } },
            { table: "legal_requests", data: [{ project_id: "p1", triage: { area: "Compras" } }] },
        ]);
        const second = await getDashboard(triageOnly.db, caller, {}, NOW);
        expect(second).toMatchObject({ ok: true, data: { volume: { by_requester: [{ label: "Compras", count: 1 }] } } });
        triageOnly.done();
    });

    it("reads the Ficha when the database has it", async () => {
        contracts.listPipeline.mockResolvedValue({ ok: true, data: { cards: [card({ id: "p1" })] } });
        regulatory.visibleScanIds.mockResolvedValue([]);
        const fake = scriptedDb([
            { table: "dossiers", data: [] },
            { table: "contract_terms", data: [] },
            { table: "documents", data: [] },
            { table: "card_events", data: [] },
            { table: "agent_runs", data: [] },
            { table: "contract_fichas", data: [{ project_id: "p1", ficha: { x: { status: "preenchido", review: { state: "confirmado" } } } }] },
            { table: "projects", data: [{ id: "p1", requester_area: "Produto" }] },
        ]);
        expect(await getDashboard(fake.db, caller, {}, NOW)).toMatchObject({
            ok: true,
            data: { ficha: { contracts: 1, fields: 1, verified: 1, rate: 100 } },
        });
        fake.done();
    });

    it("narrows to the active workspace, the Início's cut", async () => {
        contracts.listPipeline.mockResolvedValue({
            ok: true,
            data: { cards: [card({ id: "p1", org_id: "o1" }), card({ id: "p2", org_id: null }), card({ id: "p3", org_id: "o2" })] },
        });
        regulatory.visibleScanIds.mockResolvedValue([]);
        const steps = [
            { table: "dossiers", data: [] },
            { table: "contract_terms", data: [] },
            { table: "documents", data: [] },
            { table: "card_events", data: [] },
            { table: "agent_runs", data: [] },
            { table: "contract_fichas", data: [] },
            { table: "projects", data: [] },
            { table: "legal_requests", data: [] },
        ];
        const team = scriptedDb(steps);
        expect(await getDashboard(team.db, caller, {}, NOW, "o1")).toMatchObject({ ok: true, data: { volume: { opened: 1 } } });
        expect(team.calls[0].filters).toContainEqual(["in", "project_id", ["p1"]]);
        expect(contracts.countAgentReviews).toHaveBeenLastCalledWith(team.db, ["p1"], expect.any(String), NOW.toISOString());
        const personal = scriptedDb(steps);
        await getDashboard(personal.db, caller, {}, NOW, "personal");
        expect(personal.calls[0].filters).toContainEqual(["in", "project_id", ["p2"]]);
    });

    it("passes on a pipeline failure and reports a real read error", async () => {
        contracts.listPipeline.mockResolvedValue({ ok: false, kind: "error", error: new Error("x") });
        expect(await getDashboard(scriptedDb([]).db, caller, {})).toMatchObject({ ok: false });

        contracts.listPipeline.mockResolvedValue({ ok: true, data: { cards: [card({ id: "p1" })] } });
        regulatory.visibleScanIds.mockResolvedValue([]);
        const order = [
            "dossiers",
            "contract_terms",
            "documents",
            "playbook_runs",
            "card_events",
            "agent_runs",
            "contract_fichas",
            "projects",
            "legal_requests",
            "regulatory_changes",
        ];
        for (const failAt of order) {
            const steps = order.slice(0, order.indexOf(failAt) + 1).map((table) =>
                table === failAt
                    ? { table, error: { message: "x" } }
                    : { table, data: table === "documents" ? [{ id: "d", project_id: "p1" }] : [] },
            );
            if (failAt === "regulatory_changes") regulatory.visibleScanIds.mockResolvedValueOnce(["s1"]);
            const fake = scriptedDb(steps);
            expect(await getDashboard(fake.db, caller, {}, NOW)).toMatchObject({ ok: false, kind: "error" });
        }
    });
});
