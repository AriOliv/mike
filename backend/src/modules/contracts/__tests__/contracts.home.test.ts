import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const access = vi.hoisted(() => ({
    checkProjectAccess: vi.fn(),
    listAccessibleProjectIds: vi.fn(),
}));
vi.mock("../../../lib/access", () => access);

import { getHomeSummary } from "../contracts.service";

const caller = { userId: "u", userEmail: "Duda@Example.com" };
const NOW = new Date("2026-10-20T12:00:00Z");

const projects = [
    { id: "p1", name: "NDA Polaris", counterparty: "Polaris", lane: "revisao", requester_name: "Ana", deadline: null, watched_folder_id: "f1" },
    { id: "p2", name: "MSA Trópico", counterparty: "Trópico", lane: "triagem", requester_name: null, deadline: "2026-10-24", watched_folder_id: null },
];
const review = (id: string, project: string, extra: Record<string, unknown>) => ({
    id,
    project_id: project,
    document_id: `d-${project}`,
    version_id: `v-${id}`,
    status: "ready",
    step: null,
    aligned: 8,
    needs_review: 6,
    deviates: 3,
    summary: "s",
    error: null,
    assignee_email: null,
    playbook_id: "pb1",
    playbook_run_id: "run",
    updated_at: "2026-10-20T10:00:00Z",
    finished_at: "2026-10-20T10:00:00Z",
    ...extra,
});

beforeEach(() => {
    access.listAccessibleProjectIds.mockReset();
});

describe("getHomeSummary", () => {
    it("builds the greeting, counters, queue, deadlines and activity since the last visit", async () => {
        access.listAccessibleProjectIds.mockResolvedValue(["p1", "p2"]);
        const fake = scriptedDb([
            { table: "home_visits", data: { previous_seen_at: "2026-10-18T00:00:00Z", last_seen_at: "2026-10-19T09:00:00Z" } },
            { table: "home_visits", op: "update" },
            { table: "projects", data: projects },
            {
                table: "contract_reviews",
                data: [
                    review("r-old", "p1", { updated_at: "2026-10-01T00:00:00Z", finished_at: "2026-10-01T00:00:00Z" }),
                    review("r1", "p1", { assignee_email: "duda@example.com" }),
                    review("r2", "p2", { status: "failed", updated_at: "2026-10-20T11:00:00Z", finished_at: null }),
                ],
            },
            { table: "document_versions", data: [{ id: "v-r1", filename: "NDA.docx" }] },
            {
                table: "contract_terms",
                data: [
                    { project_id: "p1", notice_deadline: "2026-11-01", notice_days: 61, term_end: "2027-01-01", auto_renewal: true },
                    { project_id: "p2", notice_deadline: "2026-09-01", term_end: null, auto_renewal: null },
                ],
            },
            { table: "watched_folders", data: null },
            {
                table: "card_events",
                data: [
                    { id: 1, project_id: "p1", at: "2026-10-20T09:00:00Z", action: "review.completed" },
                    { id: 2, project_id: "gone", at: "2026-10-20T11:00:00Z", action: "comment.added" },
                ],
            },
        ]);
        const result = await getHomeSummary(fake.db, caller, NOW);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const home = result.data;
        expect(home.since).toBe("2026-10-19T09:00:00Z");
        expect(fake.calls[1].payload).toMatchObject({ previous_seen_at: "2026-10-19T09:00:00Z" });
        // One row per card, the newest review wins.
        expect(home.reviews.map((r) => r.id)).toEqual(["r2", "r1"]);
        expect(home.reviews[1]).toMatchObject({
            filename: "NDA.docx",
            project_name: "NDA Polaris",
            notice_deadline: "2026-11-01",
            notice_days: 61,
            watched_folder_id: "f1",
        });
        expect(home.reviews[0]).toMatchObject({ filename: null, notice_deadline: "2026-09-01" });
        expect(home.greeting).toEqual({ reviewed: 1, failed: 1, notices_closing: 1, ready: 1 });
        expect(home.counters).toEqual({ ready: 1, mine: 1, notices_30d: 1, folders: 1 });
        // A deadline already past is not "closing".
        expect(home.deadlines).toEqual([
            expect.objectContaining({ project_id: "p1", days_left: 12, auto_renewal: true }),
        ]);
        expect(home.activity.map((e) => e.id)).toEqual([2, 1]);
        expect(home.activity[1].project_name).toBe("NDA Polaris");
        expect(home.activity[0].project_name).toBe("");
        fake.done();
    });

    it("starts a first visit with no 'since' and an empty home", async () => {
        access.listAccessibleProjectIds.mockResolvedValue([]);
        const fake = scriptedDb([
            { table: "home_visits", data: null },
            { table: "home_visits", op: "insert" },
            { table: "watched_folders", data: null },
        ]);
        const result = await getHomeSummary(fake.db, { userId: "u" }, NOW);
        expect(result).toMatchObject({
            ok: true,
            data: {
                since: null,
                counters: { ready: 0, mine: 0, notices_30d: 0, folders: 0 },
                reviews: [],
                deadlines: [],
                activity: [],
            },
        });
        fake.done();
    });

    it("keeps counting from the same point on a reload within the hour", async () => {
        access.listAccessibleProjectIds.mockResolvedValue([]);
        const fake = scriptedDb([
            { table: "home_visits", data: { previous_seen_at: null, last_seen_at: "2026-10-20T11:30:00Z" } },
            { table: "watched_folders", data: null },
        ]);
        expect(await getHomeSummary(fake.db, caller, NOW)).toMatchObject({ data: { since: null } });
        fake.done();
    });

    it("maps any read failure to an internal error", async () => {
        access.listAccessibleProjectIds.mockResolvedValue([]);
        for (const steps of [
            [{ table: "home_visits", error: { message: "a" } }],
            [{ table: "home_visits", data: null }, { table: "home_visits", op: "insert", error: { message: "b" } }],
            [
                { table: "home_visits", data: { previous_seen_at: null, last_seen_at: "2026-10-01T00:00:00Z" } },
                { table: "home_visits", op: "update", error: { message: "c" } },
            ],
            [{ table: "home_visits", data: null }, { table: "home_visits", op: "insert" }, { table: "watched_folders", error: { message: "d" } }],
        ]) {
            expect(await getHomeSummary(scriptedDb(steps).db, caller, NOW)).toMatchObject({ ok: false, kind: "error" });
        }
        access.listAccessibleProjectIds.mockResolvedValue(["p1"]);
        const fake = scriptedDb([
            { table: "home_visits", data: null },
            { table: "home_visits", op: "insert" },
            { table: "projects", error: { message: "e" } },
        ]);
        expect(await getHomeSummary(fake.db, caller, NOW)).toMatchObject({ kind: "error" });
        fake.done();
    });
});
