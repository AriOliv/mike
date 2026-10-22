import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({ getDashboard: vi.fn() }));
vi.mock("../dashboard.service", () => service);
vi.mock("../../../lib/supabase", () => ({ createServerSupabase: () => ({}) }));
const workspace = vi.hoisted(() => ({ resolveWorkspaceFilter: vi.fn(), sendWorkspaceFailure: vi.fn() }));
vi.mock("../../../lib/workspace", () => workspace);
vi.mock("../../../middleware/auth", () => ({
    requireAuth: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "ana@avenia.io";
        next();
    },
}));

import { dashboardRouter } from "../dashboard.routes";

const app = express();
app.use("/dashboard", dashboardRouter);

beforeEach(() => {
    service.getDashboard.mockReset().mockResolvedValue({ ok: true, data: { period_days: 90 } });
    workspace.resolveWorkspaceFilter.mockReset();
    workspace.sendWorkspaceFailure.mockReset().mockImplementation((res: express.Response) => res.status(404).end());
});

describe("GET /dashboard", () => {
    it("reads the dashboard in the active workspace", async () => {
        workspace.resolveWorkspaceFilter.mockResolvedValue({ ok: true, workspace: "o1" });
        await request(app).get("/dashboard?period=30&workspace=o1").expect(200, { period_days: 90 });
        expect(workspace.resolveWorkspaceFilter).toHaveBeenCalledWith({}, "u1", "o1");
        expect(service.getDashboard).toHaveBeenCalledWith(
            {},
            { userId: "u1", userEmail: "ana@avenia.io" },
            { period: "30", workspace: "o1" },
            expect.any(Date),
            "o1",
        );
    });

    it("refuses a workspace the caller is not in", async () => {
        workspace.resolveWorkspaceFilter.mockResolvedValue({ ok: false, kind: "not_found" });
        await request(app).get("/dashboard?workspace=o9").expect(404);
        expect(service.getDashboard).not.toHaveBeenCalled();
    });

    it("maps a service failure", async () => {
        workspace.resolveWorkspaceFilter.mockResolvedValue({ ok: true, workspace: null });
        service.getDashboard.mockResolvedValue({ ok: false, kind: "error", error: new Error("down") });
        await request(app).get("/dashboard").expect(500);
    });
});
