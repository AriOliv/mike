import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const contracts = vi.hoisted(() => ({ getHomeSummary: vi.fn() }));
vi.mock("../contracts.service", () => contracts);
const requests = vi.hoisted(() => ({ whoAmI: vi.fn() }));
vi.mock("../../requests/requests.service", () => requests);
vi.mock("../../../lib/supabase", () => ({ createServerSupabase: () => ({}) }));
vi.mock("../../../lib/workspace", () => ({
    resolveWorkspaceFilter: async () => ({ ok: true, workspace: null }),
    sendWorkspaceFailure: vi.fn(),
}));
vi.mock("../../../middleware/auth", () => ({
    requireAuth: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "ana@avenia.io";
        next();
    },
}));

import { homeRouter } from "../contracts.routes";

const app = express();
app.use("/home", homeRouter);

const caller = { userId: "u1", userEmail: "ana@avenia.io" };
const me = (role: string, configured = true) => ({ ok: true, data: { configured, role, area: null, areas: [] } });

beforeEach(() => {
    contracts.getHomeSummary.mockReset().mockResolvedValue({ ok: true, data: { audience: "team" } });
    requests.whoAmI.mockReset();
});

describe("GET /home", () => {
    it("reads a requester's home as a requester, so the portfolio never leaves the team", async () => {
        requests.whoAmI.mockResolvedValue(me("requester"));
        await request(app).get("/home").expect(200);
        expect(contracts.getHomeSummary).toHaveBeenCalledWith({}, caller, expect.any(Date), null, "requester");
    });

    it("reads the head's and the team's home in full", async () => {
        for (const role of ["head", "team"]) {
            requests.whoAmI.mockResolvedValue(me(role));
            await request(app).get("/home").expect(200);
            expect(contracts.getHomeSummary).toHaveBeenLastCalledWith({}, caller, expect.any(Date), null, "team");
        }
    });

    it("keeps the whole home when no legal team is configured: there is nobody to ask", async () => {
        requests.whoAmI.mockResolvedValue(me("requester", false));
        await request(app).get("/home").expect(200);
        expect(contracts.getHomeSummary).toHaveBeenLastCalledWith({}, caller, expect.any(Date), null, "team");
    });

    it("fails rather than guess when the role cannot be read", async () => {
        requests.whoAmI.mockResolvedValue({ ok: false, kind: "error", error: new Error("down") });
        await request(app).get("/home").expect(500);
        expect(contracts.getHomeSummary).not.toHaveBeenCalled();
    });
});
