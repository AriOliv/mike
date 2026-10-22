import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
    getLegalAgent: vi.fn(),
    saveLegalAgentSettings: vi.fn(),
    saveLegalAgentChannel: vi.fn(),
    getLegalAgentChannelSetup: vi.fn(),
    setLegalAgentChannelStatus: vi.fn(),
    deleteLegalAgentChannel: vi.fn(),
    listMyChatLinks: vi.fn(),
    revokeMyChatLink: vi.fn(),
    previewChatLink: vi.fn(),
    confirmChatLink: vi.fn(),
}));
vi.mock("../legalAgent.service", () => service);
vi.mock("../../../lib/supabase", () => ({ createServerSupabase: () => ({}) }));
vi.mock("../../../middleware/auth", () => ({
    requireAuth: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "head@avenia.io";
        next();
    },
}));

import { chatLinksRouter, legalAgentRouter } from "../legalAgent.routes";

const app = express();
app.use(express.json());
app.use("/orgs/:orgId/legal-agent", legalAgentRouter);
app.use("/chat-links", chatLinksRouter);

const caller = { userId: "u1", userEmail: "head@avenia.io" };
const okData = (data: unknown) => ({ ok: true, data });

beforeEach(() => {
    for (const fn of Object.values(service)) fn.mockReset().mockResolvedValue(okData({}));
});

describe("legal agent routes", () => {
    it("reads and saves the settings of the organization in the path", async () => {
        await request(app).get("/orgs/o1/legal-agent").expect(200);
        expect(service.getLegalAgent).toHaveBeenCalledWith({}, caller, "o1");
        await request(app).put("/orgs/o1/legal-agent").send({ tone: "formal" }).expect(200);
        expect(service.saveLegalAgentSettings).toHaveBeenCalledWith({}, caller, "o1", { tone: "formal" });
    });

    it("creates a channel with 201 and edits it, passing only the known fields", async () => {
        await request(app)
            .post("/orgs/o1/legal-agent/channels")
            .send({ kind: "slack", name: "S", config: { workspace: "A" }, status: "configurado" })
            .expect(201);
        expect(service.saveLegalAgentChannel).toHaveBeenCalledWith({}, caller, "o1", {
            kind: "slack",
            name: "S",
            config: { workspace: "A" },
            platform_team_id: undefined,
        });
        await request(app).put("/orgs/o1/legal-agent/channels/c1").send("x").expect(200);
        expect(service.saveLegalAgentChannel).toHaveBeenLastCalledWith({}, caller, "o1", {
            id: "c1",
            kind: undefined,
            name: undefined,
            config: undefined,
            platform_team_id: undefined,
        });
    });

    it("serves the setup, changes the status and deletes", async () => {
        await request(app).get("/orgs/o1/legal-agent/channels/c1/setup").expect(200);
        expect(service.getLegalAgentChannelSetup).toHaveBeenCalledWith({}, caller, "o1", "c1");
        await request(app).patch("/orgs/o1/legal-agent/channels/c1").send({ status: "pausado" }).expect(200);
        expect(service.setLegalAgentChannelStatus).toHaveBeenCalledWith({}, caller, "o1", "c1", "pausado");
        await request(app).delete("/orgs/o1/legal-agent/channels/c1").expect(200);
        expect(service.deleteLegalAgentChannel).toHaveBeenCalledWith({}, caller, "o1", "c1");
    });

    it("lists and revokes the caller's chat links, and confirms a link from the chat", async () => {
        await request(app).get("/orgs/o1/legal-agent/links").expect(200);
        expect(service.listMyChatLinks).toHaveBeenCalledWith({}, caller, "o1");
        await request(app).delete("/orgs/o1/legal-agent/links/l1").expect(200);
        expect(service.revokeMyChatLink).toHaveBeenCalledWith({}, caller, "o1", "l1");
        await request(app).get("/chat-links/preview?t=abc").expect(200);
        expect(service.previewChatLink).toHaveBeenCalledWith({}, caller, "abc");
        await request(app).post("/chat-links/confirm").send({ t: "abc" }).expect(200);
        expect(service.confirmChatLink).toHaveBeenCalledWith({}, caller, "abc");
    });

    it("answers a failure with its status and the sentence for the person", async () => {
        service.saveLegalAgentSettings.mockResolvedValue({
            ok: false,
            kind: "forbidden",
            detail: "Só quem administra a organização pode mudar o agente do Legal.",
        });
        const res = await request(app).put("/orgs/o1/legal-agent").send({}).expect(403);
        expect(res.body).toEqual({ detail: "Só quem administra a organização pode mudar o agente do Legal." });
    });
});
