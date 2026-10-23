import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
    assignRequest: vi.fn(),
    createRequest: vi.fn(),
    decideTriage: vi.fn(),
    deliverRequest: vi.fn(),
    getRequest: vi.fn(),
    getTerms: vi.fn(),
    setTerms: vi.fn(),
    inviteParticipant: vi.fn(),
    listRequests: vi.fn(),
    postMessage: vi.fn(),
    revokeParticipant: vi.fn(),
    whoAmI: vi.fn(),
    getRenewalSettings: vi.fn(),
    setRenewalSettings: vi.fn(),
}));
vi.mock("../requests.service", () => service);
vi.mock("../../../lib/supabase", () => ({ createServerSupabase: () => ({}) }));
vi.mock("../../../middleware/auth", () => ({
    requireAuth: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "ana@avenia.io";
        next();
    },
}));

import { requestsRouter } from "../requests.routes";

const app = express();
app.use(express.json());
app.use("/requests", requestsRouter);

const caller = { userId: "u1", userEmail: "ana@avenia.io" };
const okData = (data: unknown) => ({ ok: true, data });

beforeEach(() => {
    for (const fn of Object.values(service)) fn.mockReset();
});

describe("requests routes", () => {
    it("lists the queue, or only the caller's with ?mine=1", async () => {
        service.listRequests.mockResolvedValue(okData({ items: [] }));
        await request(app).get("/requests").expect(200);
        expect(service.listRequests).toHaveBeenLastCalledWith({}, caller, { mine: false });
        await request(app).get("/requests?mine=1").expect(200);
        expect(service.listRequests).toHaveBeenLastCalledWith({}, caller, { mine: true });
    });

    it("answers 201 for a new request and 200 for a deduplicated one", async () => {
        service.createRequest.mockResolvedValueOnce(okData({ request: { id: "r" }, deduplicated: false }));
        await request(app).post("/requests").send({ kind: "nda" }).expect(201);
        expect(service.createRequest).toHaveBeenCalledWith({}, caller, { kind: "nda" });
        service.createRequest.mockResolvedValueOnce(okData({ request: { id: "r" }, deduplicated: true }));
        await request(app).post("/requests").send({ kind: "nda" }).expect(200);
        service.createRequest.mockResolvedValueOnce({ ok: false, kind: "validation", detail: "Escolha o tipo de pedido." });
        const bad = await request(app).post("/requests").send("x").expect(400);
        expect(bad.body).toEqual({ detail: "Escolha o tipo de pedido." });
        expect(service.createRequest).toHaveBeenLastCalledWith({}, caller, {});
    });

    it("answers 422 with the field when a validation names one, so the form paints that field", async () => {
        service.createRequest.mockResolvedValueOnce({
            ok: false,
            kind: "validation",
            code: "field:counterparty_email",
            detail: "Esse e-mail não parece certo. Confira e tente de novo.",
        });
        const bad = await request(app).post("/requests").send({ kind: "nda", counterparty_email: "x" }).expect(422);
        expect(bad.body).toEqual({
            detail: "Esse e-mail não parece certo. Confira e tente de novo.",
            field: "counterparty_email",
        });
        // a validation without a field keeps its 400
        service.createRequest.mockResolvedValueOnce({ ok: false, kind: "validation", code: "outro", detail: "Escolha o tipo de pedido." });
        await request(app).post("/requests").send({}).expect(400);
    });

    it("maps every action onto its service call and status", async () => {
        const view = okData({ id: "r" });
        service.whoAmI.mockResolvedValue(okData({ role: "head" }));
        service.getRequest.mockResolvedValue(view);
        service.assignRequest.mockResolvedValue(view);
        service.decideTriage.mockResolvedValue(view);
        service.postMessage.mockResolvedValue(view);
        service.deliverRequest.mockResolvedValue(view);
        service.inviteParticipant.mockResolvedValue(view);
        service.revokeParticipant.mockResolvedValue(view);

        await request(app).get("/requests/me").expect(200, { role: "head" });
        await request(app).get("/requests/r").expect(200, { id: "r" });
        await request(app).post("/requests/r/assign").send({ assignee_id: "d" }).expect(200);
        expect(service.assignRequest).toHaveBeenCalledWith({}, caller, "r", { assignee_id: "d" });
        await request(app).post("/requests/r/triage").send({ decision: "accepted" }).expect(200);
        await request(app).post("/requests/r/messages").send({ body: "oi" }).expect(201);
        await request(app).post("/requests/r/deliver").send({ message: "ok" }).expect(200);
        await request(app).post("/requests/r/participants").send({ email: "x@y.z" }).expect(201);
        await request(app).delete("/requests/r/participants/p").expect(200);
        expect(service.revokeParticipant).toHaveBeenCalledWith({}, caller, "r", "p");
    });

    it("hides a request the caller may not see, and never leaks an internal error", async () => {
        service.getRequest.mockResolvedValue({ ok: false, kind: "not_found", detail: "Pedido não encontrado." });
        await request(app).get("/requests/r").expect(404, { detail: "Pedido não encontrado." });
        service.getRequest.mockResolvedValue({ ok: false, kind: "error", error: new Error("db password=secret") });
        const res = await request(app).get("/requests/r").expect(500);
        expect(JSON.stringify(res.body)).not.toContain("secret");
        service.getRequest.mockRejectedValue(new Error("boom"));
        await request(app).get("/requests/r").expect(500);
    });

    it("reads and saves the contract's terms through the service", async () => {
        service.getTerms.mockResolvedValueOnce(okData({ term_end: null }));
        await request(app).get("/requests/r1/terms").expect(200);
        expect(service.getTerms).toHaveBeenCalledWith({}, caller, "r1");
        service.setTerms.mockResolvedValueOnce(okData({ term_months: 12 }));
        await request(app).put("/requests/r1/terms").send({ term_months: 12 }).expect(200);
        expect(service.setTerms).toHaveBeenCalledWith({}, caller, "r1", { term_months: 12 });
        service.setTerms.mockResolvedValueOnce({ ok: false, kind: "validation", code: "field:term_months", detail: "Use um prazo de 1 mês ou mais." });
        const bad = await request(app).put("/requests/r1/terms").send({ term_months: 0 }).expect(422);
        expect(bad.body).toEqual({ detail: "Use um prazo de 1 mês ou mais.", field: "term_months" });
    });
});

describe("renewal settings routes", () => {
    it("reads the switch before an id would swallow the path", async () => {
        service.getRenewalSettings.mockResolvedValue(okData({ enabled: true, lead_days: 60 }));
        const res = await request(app).get("/requests/renewal-settings").expect(200);
        expect(res.body).toEqual({ enabled: true, lead_days: 60 });
        expect(service.getRenewalSettings).toHaveBeenCalledWith({}, caller);
        expect(service.getRequest).not.toHaveBeenCalled();
    });

    it("changes it from the body", async () => {
        service.setRenewalSettings.mockResolvedValue(okData({ enabled: false, lead_days: 30 }));
        await request(app).put("/requests/renewal-settings").send({ enabled: false, lead_days: 30 }).expect(200);
        expect(service.setRenewalSettings).toHaveBeenCalledWith({}, caller, { enabled: false, lead_days: 30 });
    });

    it("passes a refusal through, in Portuguese", async () => {
        service.setRenewalSettings.mockResolvedValue({ ok: false, kind: "forbidden", detail: "Só a liderança do Legal pode fazer isso." });
        const res = await request(app).put("/requests/renewal-settings").send({ enabled: true }).expect(403);
        expect(JSON.stringify(res.body)).toContain("Só a liderança do Legal pode fazer isso.");
    });
});

