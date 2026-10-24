import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const contracts = vi.hoisted(() => ({
    listObligations: vi.fn(),
    listObligationAlerts: vi.fn(),
    createObligation: vi.fn(),
    updateObligation: vi.fn(),
    deleteObligation: vi.fn(),
    obligationIcs: vi.fn(),
    listContractAlerts: vi.fn(),
}));
vi.mock("../contracts.service", () => contracts);
const requests = vi.hoisted(() => ({ listLegalTeamMembers: vi.fn(), whoAmI: vi.fn(), listAmendmentsOf: vi.fn() }));
vi.mock("../../requests/requests.service", () => requests);
vi.mock("../../../lib/supabase", () => ({ createServerSupabase: () => ({}) }));
vi.mock("../../../middleware/auth", () => ({
    requireAuth: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "ana@avenia.io";
        next();
    },
}));

import { obligationsRouter, projectContractRouter } from "../contracts.routes";

const app = express();
app.use(express.json());
app.use("/obligations", obligationsRouter);
app.use("/projects/:projectId", projectContractRouter);

const caller = { userId: "u1", userEmail: "ana@avenia.io" };
const team = (...emails: string[]) => ({ ok: true, data: emails.map((email) => ({ user_id: email, email, name: email })) });

beforeEach(() => {
    for (const fn of Object.values(contracts)) fn.mockReset().mockResolvedValue({ ok: true, data: {} });
    requests.listLegalTeamMembers.mockReset();
    requests.listAmendmentsOf.mockReset();
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

describe("a deadline as a calendar file", () => {
    it("downloads as an .ics, never rendered in the page", async () => {
        contracts.obligationIcs.mockResolvedValue({ ok: true, data: { filename: "prazo-2026-12-31.ics", body: "BEGIN:VCALENDAR\r\n" } });
        const res = await request(app).get("/obligations/o1/ics").expect(200);
        expect(res.headers["content-type"]).toContain("text/calendar");
        expect(res.headers["content-disposition"]).toBe('attachment; filename="prazo-2026-12-31.ics"');
        expect(res.text).toBe("BEGIN:VCALENDAR\r\n");
        expect(contracts.obligationIcs).toHaveBeenCalledWith({}, caller, "o1");
    });

    it("answers 404 in Portuguese for a deadline the caller cannot see", async () => {
        contracts.obligationIcs.mockResolvedValue({ ok: false, kind: "not_found", detail: "Não encontrei este prazo." });
        const res = await request(app).get("/obligations/o1/ics").expect(404);
        expect(JSON.stringify(res.body)).toContain("Não encontrei este prazo.");
    });
});

describe("the contract's alerts", () => {
    it("lists a contract's deadlines for whoever can open it", async () => {
        contracts.listContractAlerts.mockResolvedValue({ ok: true, data: [{ id: "o1", days_left: 3 }] });
        const res = await request(app).get("/projects/p1/alerts").expect(200);
        expect(res.body).toEqual([{ id: "o1", days_left: 3 }]);
        expect(contracts.listContractAlerts).toHaveBeenCalledWith({}, caller, "p1");
    });
});

describe("the amendments tied to a contract", () => {
    it("lists them for whoever can open the contract", async () => {
        contracts.listContractAlerts.mockResolvedValue({ ok: true, data: [] });
        requests.listAmendmentsOf.mockResolvedValue({ ok: true, data: [{ id: "r1", code: "LEG-0001" }] });
        const res = await request(app).get("/projects/p1/amendments").expect(200);
        expect(res.body).toEqual([{ id: "r1", code: "LEG-0001" }]);
        expect(contracts.listContractAlerts).toHaveBeenCalledWith({}, caller, "p1");
        expect(requests.listAmendmentsOf).toHaveBeenCalledWith({}, "p1");
    });

    it("answers a contract the caller cannot open exactly like a missing one, and never reads the amendments", async () => {
        contracts.listContractAlerts.mockResolvedValue({ ok: false, kind: "not_found", detail: "Não encontrei este contrato." });
        const res = await request(app).get("/projects/p9/amendments").expect(404);
        expect(JSON.stringify(res.body)).toContain("Não encontrei este contrato.");
        expect(requests.listAmendmentsOf).not.toHaveBeenCalled();
    });
});
