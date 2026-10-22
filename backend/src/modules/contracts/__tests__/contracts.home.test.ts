import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const access = vi.hoisted(() => ({
    checkProjectAccess: vi.fn(),
    listAccessibleProjectIds: vi.fn(),
}));
vi.mock("../../../lib/access", () => access);

import { getHomeSummary } from "../contracts.service";
import { countAgentReviews, fichaHeadline, requestCode, saoPauloDate } from "../contracts.home";

const caller = { userId: "u", userEmail: "Duda@Example.com" };
const NOW = new Date("2026-10-20T12:00:00Z");

const projects = [
    { id: "p1", org_id: null, name: "NDA Polaris", counterparty: "Polaris", lane: "revisao", requester_name: "Ana", deadline: null, watched_folder_id: "f1" },
    { id: "p2", org_id: "o1", name: "MSA Trópico", counterparty: "Trópico", lane: "triagem", requester_name: null, deadline: "2026-10-24", watched_folder_id: null },
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
                    review("r1", "p1", { assignee_email: "Duda@Example.com" }),
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
            {
                table: "contract_fichas",
                data: [
                    {
                        project_id: "p1",
                        ficha: {
                            a: { status: "encontrado", review: { state: "confirmado" } },
                            b: { status: "encontrado", review: { state: "pendente" } },
                            c: { status: "nao_aplicavel", review: { state: "pendente" } },
                            d: null,
                        },
                    },
                ],
            },
            { table: "legal_requests", data: [{ id: "req-1", number: 142, project_id: "p1" }] },
            { table: "user_profiles", data: [{ user_id: "u", email: "duda@example.com", display_name: "Duda Lima" }] },
            {
                table: "card_events",
                data: [
                    { project_id: "p2", after: { name: "Duda" } },
                    { project_id: "p2", after: { name: "older pick" } },
                    { project_id: "p1", after: { email: "ana@x.com" } },
                    { project_id: "p1", after: null },
                ],
            },
            { table: "watched_folders", data: null },
            // Last 90 days, then since the last visit.
            { table: "agent_runs", data: [{ project_id: "p1" }] },
            { table: "contract_reviews", data: [{ project_id: "p1" }, { project_id: "p2" }, { project_id: "p3" }] },
            { table: "agent_runs", data: [{ project_id: "p1" }] },
            { table: "contract_reviews", data: [{ project_id: "p1" }, { project_id: "p2" }] },
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
        expect(home.reviews[0]).toMatchObject({
            filename: null,
            notice_deadline: "2026-09-01",
            suggested_assignee: "Duda",
            ficha: null,
            assignee_name: null,
            request: null,
        });
        // Someone already owns r1, so the agent's pick is not shown; the owner shows by name.
        expect(home.reviews[1]).toMatchObject({
            suggested_assignee: null,
            assignee_name: "Duda Lima",
            ficha: { verified: 1, total: 2 },
            request: { id: "req-1", code: "LEG-0142" },
        });
        expect(home.greeting).toEqual({ reviewed: 2, reviewed_90d: 3, failed: 1, notices_closing: 1, ready: 1 });
        // The shared count, in the legal dashboard's default window, then since the last visit.
        expect(fake.calls[11].filters).toContainEqual(["gte", "finished_at", "2026-07-22T12:00:00.000Z"]);
        expect(fake.calls[11].filters).toContainEqual(["lt", "finished_at", "2026-10-20T12:00:00.000Z"]);
        expect(fake.calls[13].filters).toContainEqual(["gte", "finished_at", "2026-10-19T09:00:00Z"]);
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

    it("narrows to the active workspace", async () => {
        access.listAccessibleProjectIds.mockResolvedValue(["p1", "p2"]);
        const fake = scriptedDb([
            { table: "home_visits", data: { previous_seen_at: null, last_seen_at: "2026-10-20T11:30:00Z" } },
            { table: "projects", data: projects },
            { table: "contract_reviews", data: [review("r2", "p2", {})] },
            { table: "document_versions", data: [] },
            { table: "contract_terms", data: [] },
            { table: "contract_fichas", error: { code: "42P01" } },
            { table: "legal_requests", error: { code: "PGRST205" } },
            { table: "card_events", data: [] },
            { table: "watched_folders", data: null },
            { table: "agent_runs", data: [] },
            { table: "contract_reviews", data: [{ project_id: "p1" }] },
            { table: "card_events", data: [] },
        ]);
        const result = await getHomeSummary(fake.db, caller, NOW, "o1");
        expect(result).toMatchObject({
            ok: true,
            data: { reviews: [{ id: "r2", ficha: null }], greeting: { reviewed: 1, reviewed_90d: 1 } },
        });
        expect(fake.calls[2].filters).toContainEqual(["in", "project_id", ["p2"]]);
        // Same cut as the counters, the queue and the legal dashboard: only o1's card.
        expect(fake.calls[9].filters).toContainEqual(["in", "project_id", ["p2"]]);
        fake.done();
    });

    it("counts contracts reviewed by agents from runs or finished reviews, once each", async () => {
        const ids = Array.from({ length: 201 }, (_, i) => `p${i}`);
        const fake = scriptedDb([
            { table: "agent_runs", data: [{ project_id: "p0" }, { project_id: "p0" }] },
            { table: "contract_reviews", data: [{ project_id: "p0" }, { project_id: "p1" }] },
            { table: "agent_runs", data: null },
            { table: "contract_reviews", data: [{ project_id: "p200" }] },
        ]);
        expect(await countAgentReviews(fake.db, ids, null)).toBe(3);
        expect(fake.calls[0].filters).toEqual([
            ["in", "project_id", ids.slice(0, 200)],
            ["in", "agent", ["revisor"]],
            ["eq", "status", "succeeded"],
        ]);
        expect(fake.calls[1].filters).toEqual([
            ["in", "project_id", ids.slice(0, 200)],
            ["in", "status", ["ready", "done"]],
        ]);
        fake.done();
        const period = scriptedDb([
            { table: "agent_runs", data: [] },
            { table: "contract_reviews", data: [{ project_id: "p1" }] },
        ]);
        expect(await countAgentReviews(period.db, ["p1"], "2026-10-01", "2026-10-15")).toBe(1);
        for (const call of period.calls) {
            expect(call.filters).toContainEqual(["gte", "finished_at", "2026-10-01"]);
            expect(call.filters).toContainEqual(["lt", "finished_at", "2026-10-15"]);
        }
        period.done();
        const failing = scriptedDb([{ table: "agent_runs", error: { message: "down" } }]);
        await expect(countAgentReviews(failing.db, ["p1"], "2026-10-19")).rejects.toMatchObject({ message: "down" });
    });

    it("reads the Ficha's headline by its own rule, and the request code", () => {
        expect(fichaHeadline(null)).toBeNull();
        expect(fichaHeadline({})).toBeNull();
        expect(fichaHeadline({ a: { status: "encontrado" }, b: { review: { state: "corrigido" } } })).toEqual({
            verified: 1,
            total: 2,
        });
        expect(requestCode(7)).toBe("LEG-0007");
        expect(requestCode(12345)).toBe("LEG-12345");
    });

    it("rethrows a Ficha or request read failure that is not a missing table", async () => {
        access.listAccessibleProjectIds.mockResolvedValue(["p1"]);
        const base = [
            { table: "home_visits", data: { previous_seen_at: null, last_seen_at: "2026-10-20T11:30:00Z" } },
            { table: "projects", data: projects },
            { table: "contract_reviews", data: [] },
            { table: "document_versions", data: [] },
            { table: "contract_terms", data: [] },
        ];
        expect(
            await getHomeSummary(scriptedDb([...base, { table: "contract_fichas", error: { message: "x" } }]).db, caller, NOW),
        ).toMatchObject({ kind: "error" });
        expect(
            await getHomeSummary(
                scriptedDb([...base, { table: "contract_fichas", data: [] }, { table: "legal_requests", error: { code: "500" } }])
                    .db,
                caller,
                NOW,
            ),
        ).toMatchObject({ kind: "error" });
    });

    it("dates deadlines in São Paulo, not UTC", () => {
        // 23:30 in São Paulo on the 20th is already the 21st in UTC.
        expect(saoPauloDate(new Date("2026-10-21T02:30:00Z"))).toBe("2026-10-20");
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
