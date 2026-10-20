import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const contracts = vi.hoisted(() => ({
    LANES: ["entrada", "triagem", "revisao", "negociacao", "assinatura", "arquivado"] as const,
    listPipeline: vi.fn(),
}));
vi.mock("../../contracts/contracts.service", () => contracts);
const regulatory = vi.hoisted(() => ({ visibleScanIds: vi.fn() }));
vi.mock("../../regulatory/regulatory.service", () => regulatory);

import { computeDashboard, DEFAULT_ASSUMPTIONS, getDashboard, parseDashboardQuery } from "../dashboard.service";
import { weekOf } from "../dashboard.metrics";

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
    card({ id: "a", lane: "arquivado", status: "concluido", completed_at: "2026-10-10", deadline: "2026-10-12", assignee_email: "duda@avenia.io", contract_type: "NDA", requester_name: "Comercial" }),
    // closed late in 19 days
    card({ id: "b", lane: "assinatura", status: "concluido", completed_at: "2026-10-20", deadline: "2026-10-15", assignee_email: "teo@avenia.io", contract_type: "NDA", requester_name: "Produto" }),
    // open in revision for 5 days, overdue
    card({ id: "c", lane: "revisao", lane_updated_at: "2026-10-15T12:00:00Z", deadline: "2026-10-18", assignee_email: "duda@avenia.io", contract_type: "MSA", requester_name: "Comercial" }),
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
        expect(d.volume.by_requester[0]).toEqual({ label: "Comercial", count: 2 });
        expect(d.volume.weekly.reduce((n, w) => n + w.opened, 0)).toBe(3);
        expect(d.volume.weekly.reduce((n, w) => n + w.closed, 0)).toBe(2);
    });

    it("measures cycle time and what sits in each stage today", () => {
        // completed_at is a date: 8.6 and 18.6 days
        expect(d.cycle.median_days_to_close).toBe(13.6);
        expect(d.cycle.stage_age.find((s) => s.lane === "revisao")).toEqual({ lane: "revisao", open: 1, median_days: 5 });
        expect(d.cycle.stage_age.find((s) => s.lane === "triagem")).toEqual({ lane: "triagem", open: 0, median_days: null });
        expect(d.cycle.stage_age.map((s) => s.lane)).not.toContain("arquivado");
        expect(d.cycle.per_stage_history).toBeNull();
    });

    it("measures SLA and the notice deadlines kept", () => {
        expect(d.sla).toEqual({ closed_with_deadline: 2, on_time: 1, rate: 50, open_overdue: 1 });
        expect(d.notice).toEqual({ due_in_30_days: 1, missed_in_period: 1 });
    });

    it("separates contracts reviewed by agents from those reviewed by people", () => {
        expect(d.agents).toEqual({
            contracts_reviewed_by_agents: 2,
            contracts_reviewed_by_people: 1,
            playbook_runs: 1,
            terms_extracted: 2,
            regulatory_changes_triaged: 2,
            regulatory_turned_into_work: 1,
        });
    });

    it("shows hours saved with the formula it used", () => {
        expect(d.hours_saved.hours).toBe(4.2);
        expect(d.hours_saved.formula).toBe(
            "2 revisões × 90 min + 2 extrações de prazos × 20 min + 2 mudanças regulatórias × 15 min",
        );
    });

    it("reports adoption per person and never invents an AI cost", () => {
        expect(d.adoption.people[0]).toEqual({ email: "duda@avenia.io", assigned_open: 1, closed: 1, reviews_run: 0 });
        expect(d.adoption.reviews_by_user_id).toEqual([{ user_id: "u1", count: 1 }]);
        expect(d.ai_cost).toBeNull();
    });

    it("handles an empty base", () => {
        const empty = computeDashboard(
            { cards: [], dossiers: [], terms: [], runs: [], changes: [], documentProject: new Map() },
            { now: NOW, periodDays: 90, assumptions: DEFAULT_ASSUMPTIONS },
        );
        expect(empty.cycle.median_days_to_close).toBeNull();
        expect(empty.sla.rate).toBeNull();
        expect(empty.hours_saved.hours).toBe(0);
        expect(empty.volume.weekly.length).toBeGreaterThan(12);
    });

    it("weeks start on Monday", () => {
        expect(weekOf("2026-10-20T12:00:00Z")).toBe("2026-10-19");
        expect(weekOf("2026-10-25T23:00:00Z")).toBe("2026-10-19");
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
    });

    it("reads only what belongs to the contracts and scans the caller sees", async () => {
        contracts.listPipeline.mockResolvedValue({ ok: true, data: { cards: [card({ id: "p1" })] } });
        regulatory.visibleScanIds.mockResolvedValue(["s1"]);
        const fake = scriptedDb([
            { table: "dossiers", data: [] },
            { table: "contract_terms", data: [] },
            { table: "documents", data: [{ id: "doc1", project_id: "p1" }] },
            { table: "playbook_runs", data: [] },
            { table: "regulatory_changes", data: [] },
        ]);
        const result = await getDashboard(fake.db, caller, { period: "30" }, NOW);
        expect(result).toMatchObject({ ok: true, data: { period_days: 30, volume: { opened: 1 } } });
        expect(fake.calls[0].filters).toContainEqual(["in", "project_id", ["p1"]]);
        expect(fake.calls[3].filters).toContainEqual(["in", "document_id", ["doc1"]]);
        expect(fake.calls[4].filters).toContainEqual(["in", "scan_id", ["s1"]]);
        fake.done();
    });

    it("passes on a pipeline failure and reports a read error", async () => {
        contracts.listPipeline.mockResolvedValue({ ok: false, kind: "error", error: new Error("x") });
        expect(await getDashboard(scriptedDb([]).db, caller, {})).toMatchObject({ ok: false });

        contracts.listPipeline.mockResolvedValue({ ok: true, data: { cards: [card({ id: "p1" })] } });
        regulatory.visibleScanIds.mockResolvedValue([]);
        for (const failAt of ["dossiers", "contract_terms", "documents", "playbook_runs", "regulatory_changes"]) {
            const order = ["dossiers", "contract_terms", "documents", "playbook_runs", "regulatory_changes"];
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
