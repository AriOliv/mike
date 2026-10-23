import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const contracts = vi.hoisted(() => ({
    listObligations: vi.fn(),
    listObligationAlerts: vi.fn(),
    createObligation: vi.fn(),
    updateObligation: vi.fn(),
    deleteObligation: vi.fn(),
}));
vi.mock("../contracts.service", () => contracts);
const requests = vi.hoisted(() => ({ listLegalTeamMembers: vi.fn(), whoAmI: vi.fn() }));
vi.mock("../../requests/requests.service", () => requests);
vi.mock("../../../lib/supabase", () => ({ createServerSupabase: () => ({}) }));
vi.mock("../../../middleware/auth", () => ({
    requireAuth: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "ana@avenia.io";
        next();
    },
}));

import { obligationsRouter } from "../contracts.routes";

const app = express();
app.use(express.json());
app.use("/obligations", obligationsRouter);

const caller = { userId: "u1", userEmail: "ana@avenia.io" };
const team = (...emails: string[]) => ({ ok: true, data: emails.map((email) => ({ user_id: email, email, name: email })) });

beforeEach(() => {
    for (const fn of Object.values(contracts)) fn.mockReset().mockResolvedValue({ ok: true, data: {} });
    requests.listLegalTeamMembers.mockReset();
});

describe("/obligations owners and alerts", () => {
    it("serves the alerts before an id would swallow the path", async () => {
        contracts.listObligationAlerts.mockResolvedValue({ ok: true, data: [{ id: "o1", days_left: 2 }] });
        const res = await request(app).get("/obligations/alerts").expect(200);
        expect(res.body).toEqual([{ id: "o1", days_left: 2 }]);
        expect(contracts.listObligationAlerts).toHaveBeenCalledWith({}, caller);
    });

    it("lists the people a deadline can be handed to", async () => {
        requests.listLegalTeamMembers.mockResolvedValue(team("bia@avenia.io"));
        const res = await request(app).get("/obligations/owners").expect(200);
        expect(res.body).toEqual([{ user_id: "bia@avenia.io", email: "bia@avenia.io", name: "bia@avenia.io" }]);
    });

    it("checks a named owner against the legal team on create and update", async () => {
        requests.listLegalTeamMembers.mockResolvedValue(team("bia@avenia.io"));
        await request(app).post("/obligations").send({ title: "A", due_date: "2026-11-20", owner_email: "bia@avenia.io" }).expect(201);
        expect(contracts.createObligation).toHaveBeenCalledWith({}, caller, expect.anything(), { members: ["bia@avenia.io"] });
        await request(app).patch("/obligations/o1").send({ owner_email: "bia@avenia.io" }).expect(200);
        expect(contracts.updateObligation).toHaveBeenCalledWith({}, caller, "o1", expect.anything(), { members: ["bia@avenia.io"] });
    });

    it("does not ask for the team when no owner is named", async () => {
        await request(app).post("/obligations").send({ title: "A", due_date: "2026-11-20" }).expect(201);
        await request(app).patch("/obligations/o1").send({ owner_email: "" }).expect(200);
        await request(app).patch("/obligations/o1").send({ done: true }).expect(200);
        expect(requests.listLegalTeamMembers).not.toHaveBeenCalled();
        expect(contracts.createObligation).toHaveBeenCalledWith({}, caller, expect.anything(), {});
    });

    it("lets any valid e-mail through when the deployment has no legal team", async () => {
        requests.listLegalTeamMembers.mockResolvedValue({ ok: false, kind: "unavailable", detail: "x" });
        await request(app).post("/obligations").send({ title: "A", due_date: "2026-11-20", owner_email: "x@y.io" }).expect(201);
        expect(contracts.createObligation).toHaveBeenCalledWith({}, caller, expect.anything(), {});
    });

    it("lets nobody outside the team name an owner", async () => {
        requests.listLegalTeamMembers.mockResolvedValue({ ok: false, kind: "forbidden", detail: "x" });
        await request(app).post("/obligations").send({ title: "A", due_date: "2026-11-20", owner_email: "x@y.io" }).expect(201);
        expect(contracts.createObligation).toHaveBeenCalledWith({}, caller, expect.anything(), { members: [] });
    });
});
