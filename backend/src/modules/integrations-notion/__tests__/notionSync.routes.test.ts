import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
    getNotionConnection: vi.fn(),
    connectNotion: vi.fn(),
    disconnectNotion: vi.fn(),
    listNotionDatabases: vi.fn(),
    describeNotionBoard: vi.fn(),
    saveNotionMapping: vi.fn(),
}));
vi.mock("../notionSync.service", () => service);
vi.mock("../../../lib/supabase", () => ({ createServerSupabase: () => ({}) }));
vi.mock("../../../middleware/auth", () => ({
    requireAuth: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "head@exemplo.com";
        next();
    },
}));

import { notionIntegrationRouter } from "../notionSync.routes";

const app = express();
app.use(express.json());
app.use("/orgs/:orgId/integrations/notion", notionIntegrationRouter);
const caller = { userId: "u1", userEmail: "head@exemplo.com" };

beforeEach(() => {
    for (const fn of Object.values(service)) fn.mockReset().mockResolvedValue({ ok: true, data: {} });
});

describe("notion integration routes", () => {
    it("reads, connects and disconnects for the organization in the path", async () => {
        await request(app).get("/orgs/o1/integrations/notion").expect(200);
        expect(service.getNotionConnection).toHaveBeenCalledWith({}, caller, "o1");
        await request(app).put("/orgs/o1/integrations/notion/token").send({ token: "ntn_x" }).expect(200);
        expect(service.connectNotion).toHaveBeenCalledWith({}, caller, "o1", "ntn_x");
        await request(app).put("/orgs/o1/integrations/notion/token").send("x").expect(200);
        expect(service.connectNotion).toHaveBeenLastCalledWith({}, caller, "o1", undefined);
        await request(app).delete("/orgs/o1/integrations/notion/token").expect(200);
        expect(service.disconnectNotion).toHaveBeenCalledWith({}, caller, "o1");
    });

    it("lists bases, describes one and saves the mapping with only the known fields", async () => {
        await request(app).get("/orgs/o1/integrations/notion/databases").expect(200);
        expect(service.listNotionDatabases).toHaveBeenCalledWith({}, caller, "o1");
        await request(app).get("/orgs/o1/integrations/notion/board?database_id=abc").expect(200);
        expect(service.describeNotionBoard).toHaveBeenCalledWith({}, caller, "o1", "abc");
        await request(app)
            .put("/orgs/o1/integrations/notion/mapping")
            .send({ database_id: "abc", field_map: {}, stage_map: {}, poll_minutes: 10, sync_enabled: true })
            .expect(200);
        expect(service.saveNotionMapping).toHaveBeenCalledWith({}, caller, "o1", { database_id: "abc", field_map: {}, stage_map: {}, poll_minutes: 10 });
    });

    it("answers a refusal with its status and sentence", async () => {
        service.connectNotion.mockResolvedValue({ ok: false, kind: "forbidden", detail: "Só quem administra a organização pode mudar a integração com o Notion." });
        const res = await request(app).put("/orgs/o1/integrations/notion/token").send({ token: "x" }).expect(403);
        expect(res.body).toEqual({ detail: "Só quem administra a organização pode mudar a integração com o Notion." });
    });
});
