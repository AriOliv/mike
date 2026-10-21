import { describe, expect, it } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { countAgentReviews, REVIEW_AGENTS } from "../dashboard.reviews";

describe("countAgentReviews", () => {
    it("counts distinct contracts a reviewer run or an automatic review finished in the window", async () => {
        const fake = scriptedDb([
            { table: "agent_runs", data: [{ project_id: "a" }, { project_id: "a" }, { project_id: "b" }] },
            { table: "contract_reviews", data: [{ project_id: "b" }, { project_id: "c" }] },
        ]);
        expect(await countAgentReviews(fake.db, ["a", "b", "c", "d"], "2026-10-01T00:00:00Z", "2026-10-20T00:00:00Z")).toBe(3);

        const [runs, reviews] = fake.calls;
        expect(runs.filters).toEqual([
            ["in", "project_id", ["a", "b", "c", "d"]],
            ["in", "agent", [...REVIEW_AGENTS]],
            ["eq", "status", "succeeded"],
            ["gte", "finished_at", "2026-10-01T00:00:00Z"],
            ["lt", "finished_at", "2026-10-20T00:00:00Z"],
        ]);
        expect(reviews.filters).toEqual([
            ["in", "project_id", ["a", "b", "c", "d"]],
            ["in", "status", ["ready", "done"]],
            ["gte", "finished_at", "2026-10-01T00:00:00Z"],
            ["lt", "finished_at", "2026-10-20T00:00:00Z"],
        ]);
        fake.done();
    });

    it("leaves an open end open", async () => {
        const fake = scriptedDb([
            { table: "agent_runs", data: [] },
            { table: "contract_reviews", data: [] },
        ]);
        expect(await countAgentReviews(fake.db, ["a"], null)).toBe(0);
        expect(fake.calls[0].filters.map((f) => f[0])).not.toContain("gte");
        expect(fake.calls[0].filters.map((f) => f[0])).not.toContain("lt");
        fake.done();
    });

    it("counts the reviewer runs alone on a database without contract_reviews", async () => {
        const fake = scriptedDb([
            { table: "agent_runs", data: [{ project_id: "a" }] },
            { table: "contract_reviews", error: { code: "PGRST205", message: "missing" } },
        ]);
        expect(await countAgentReviews(fake.db, ["a"], null)).toBe(1);
        fake.done();
    });

    it("reads in slices and surfaces a real error", async () => {
        const ids = Array.from({ length: 201 }, (_, i) => `p${i}`);
        const sliced = scriptedDb([
            { table: "agent_runs", data: [] },
            { table: "contract_reviews", data: [] },
            { table: "agent_runs", data: [{ project_id: "p200" }] },
            { table: "contract_reviews", data: [] },
        ]);
        expect(await countAgentReviews(sliced.db, ids, null)).toBe(1);
        expect(sliced.calls[2].filters[0]).toEqual(["in", "project_id", ["p200"]]);
        sliced.done();

        const runsErr = scriptedDb([{ table: "agent_runs", error: { message: "down" } }]);
        await expect(countAgentReviews(runsErr.db, ["a"], null)).rejects.toEqual({ message: "down" });
        const reviewsErr = scriptedDb([
            { table: "agent_runs", data: [] },
            { table: "contract_reviews", error: { code: "42501", message: "denied" } },
        ]);
        await expect(countAgentReviews(reviewsErr.db, ["a"], null)).rejects.toMatchObject({ code: "42501" });
    });
});
