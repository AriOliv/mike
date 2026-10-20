import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const access = vi.hoisted(() => ({
    checkProjectAccess: vi.fn(),
    listAccessibleProjectIds: vi.fn(),
}));
vi.mock("../../../lib/access", () => access);

import {
    finishAgentRun,
    listCardEvents,
    recordCardEvent,
    startAgentRun,
} from "../contracts.service";

const caller = { userId: "u", userEmail: "u@example.com" };
const viewer = { ok: true, isCreator: false, orgRole: null, projectRole: "viewer", project: {} };

beforeEach(() => {
    access.checkProjectAccess.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("recordCardEvent", () => {
    it("appends an agent event with its run and an agent source", async () => {
        const fake = scriptedDb([{ table: "card_events", op: "insert", data: { id: 7 } }]);
        const id = await recordCardEvent(fake.db, {
            projectId: "p1",
            actorType: "agent",
            actorId: "agent:revisor@1",
            actorName: "Agente de revisão",
            action: "review.completed",
            after: { sources: 3 },
            runId: "r1",
        });
        expect(id).toBe(7);
        expect(fake.calls[0].payload).toEqual({
            project_id: "p1",
            org_id: null,
            actor_type: "agent",
            actor_id: "agent:revisor@1",
            actor_name: "Agente de revisão",
            on_behalf_of: null,
            action: "review.completed",
            field: null,
            before: null,
            after: { sources: 3 },
            run_id: "r1",
            source: "agent",
        });
        fake.done();
    });

    it("keeps an explicit source and who a bot acted for", async () => {
        const fake = scriptedDb([{ table: "card_events", op: "insert", data: { id: 8 } }]);
        await recordCardEvent(fake.db, {
            projectId: "p1",
            actorType: "hermes",
            actorId: "hermes:docbot",
            action: "request.created",
            source: "mcp",
            onBehalfOf: "ana@example.com",
            orgId: "o1",
        });
        expect(fake.calls[0].payload).toMatchObject({
            source: "mcp",
            on_behalf_of: "ana@example.com",
            org_id: "o1",
        });
        fake.done();
    });

    it("returns null instead of throwing when the insert fails", async () => {
        const fake = scriptedDb([{ table: "card_events", op: "insert", error: { message: "x" } }]);
        expect(
            await recordCardEvent(fake.db, {
                projectId: "p1",
                actorType: "user",
                actorId: "u",
                action: "comment.added",
            }),
        ).toBeNull();
        fake.done();
    });
});

describe("listCardEvents", () => {
    it("hides the feed of a card the caller cannot see", async () => {
        access.checkProjectAccess.mockResolvedValue({ ok: false });
        const fake = scriptedDb([]);
        expect(await listCardEvents(fake.db, caller, "p1")).toMatchObject({ ok: false, kind: "not_found" });
        fake.done();
    });

    it("lists a card's events newest first, with a bounded limit", async () => {
        access.checkProjectAccess.mockResolvedValue(viewer);
        const fake = scriptedDb([{ table: "card_events", data: [{ id: 2 }, { id: 1 }] }]);
        const result = await listCardEvents(fake.db, caller, "p1", 5000);
        expect(result).toEqual({ ok: true, data: [{ id: 2 }, { id: 1 }] });
        expect(fake.calls[0].filters).toEqual([
            ["eq", "project_id", "p1"],
            ["order", "at", { ascending: false }],
            ["limit", 200],
        ]);
        fake.done();
    });

    it("falls back to the default limit for nonsense and maps errors", async () => {
        access.checkProjectAccess.mockResolvedValue(viewer);
        const fake = scriptedDb([
            { table: "card_events", data: null },
            { table: "card_events", error: { message: "down" } },
        ]);
        expect(await listCardEvents(fake.db, caller, "p1", Number.NaN)).toEqual({ ok: true, data: [] });
        expect(fake.calls[0].filters).toContainEqual(["limit", 50]);
        expect(await listCardEvents(fake.db, caller, "p1")).toMatchObject({ ok: false, kind: "error" });
        fake.done();
    });
});

describe("agent runs", () => {
    it("opens a run and closes it with its outcome", async () => {
        const fake = scriptedDb([
            { table: "agent_runs", op: "insert", data: { id: "r1" } },
            { table: "agent_runs", op: "update" },
        ]);
        const id = await startAgentRun(fake.db, {
            projectId: "p1",
            agent: "revisor",
            agentVersion: "1",
            dedupeKey: "revisor:p1:sha",
        });
        expect(id).toBe("r1");
        expect(fake.calls[0].payload).toMatchObject({ status: "running", dedupe_key: "revisor:p1:sha" });
        await finishAgentRun(fake.db, "r1", { status: "succeeded", output: { counts: {} } });
        expect(fake.calls[1].payload).toMatchObject({ status: "succeeded", output: { counts: {} } });
        expect(fake.calls[1].filters).toEqual([["eq", "id", "r1"]]);
        fake.done();
    });

    it("throws when a run cannot be opened, but not when it cannot be closed", async () => {
        const fake = scriptedDb([
            { table: "agent_runs", op: "insert", error: { message: "x" } },
            { table: "agent_runs", op: "update", error: { message: "y" } },
        ]);
        await expect(
            startAgentRun(fake.db, { projectId: "p1", agent: "revisor", agentVersion: "1" }),
        ).rejects.toMatchObject({ message: "x" });
        await expect(finishAgentRun(fake.db, "r1", { status: "failed", error: "z" })).resolves.toBeUndefined();
        fake.done();
    });
});
