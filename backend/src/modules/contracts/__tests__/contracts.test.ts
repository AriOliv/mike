import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const access = vi.hoisted(() => ({
    checkProjectAccess: vi.fn(),
    listAccessibleProjectIds: vi.fn(),
}));
vi.mock("../../../lib/access", () => access);
const gcal = vi.hoisted(() => ({ removeCalendarEvent: vi.fn() }));
vi.mock("../../../lib/gcal", async (actual) => ({
    ...(await actual<typeof import("../../../lib/gcal")>()),
    ...gcal,
}));
vi.mock("../../user/user.service", () => ({
    getUserModelSettings: vi.fn(async () => ({
        tabular_model: null,
        last_selected_chat_model: null,
        api_keys: {},
    })),
}));

import {
    askAcervo,
    createObligation,
    deleteObligation,
    extractContractTerms,
    getDossier,
    listPipeline,
    updatePipelineCard,
} from "../contracts.service";
import { scoreCandidate } from "../contracts.acervo";
import { eventId } from "../../../lib/gcal";

const caller = { userId: "u", userEmail: "u@example.com" };
const role = (projectRole: string) => ({ ok: true, isCreator: false, orgRole: null, projectRole, project: {} });

beforeEach(() => {
    gcal.removeCalendarEvent.mockReset();
    access.checkProjectAccess.mockReset();
    access.listAccessibleProjectIds.mockReset();
});

describe("pipeline", () => {
    it("lists only the cards of projects the caller can see", async () => {
        access.listAccessibleProjectIds.mockResolvedValue(["p1"]);
        const fake = scriptedDb([
            { table: "projects", data: [{ id: "p1", lane: "triagem", lane_updated_at: "2026-10-01" }] },
        ]);
        const result = await listPipeline(fake.db, caller);
        expect(result).toMatchObject({ ok: true, data: { cards: [{ id: "p1" }] } });
        if (!result.ok) return;
        expect(result.data.by_lane.triagem).toHaveLength(1);
        expect(fake.calls[0].filters).toContainEqual(["in", "id", ["p1"]]);
        fake.done();
    });

    it("refuses a viewer who tries to move a card", async () => {
        access.checkProjectAccess.mockResolvedValue(role("viewer"));
        const fake = scriptedDb([]);
        const result = await updatePipelineCard(fake.db, caller, "p1", { lane: "revisao" });
        expect(result).toMatchObject({ ok: false, kind: "forbidden" });
        fake.done();
    });

    it("hides a project the caller cannot see", async () => {
        access.checkProjectAccess.mockResolvedValue({ ok: false });
        const fake = scriptedDb([]);
        expect(await updatePipelineCard(fake.db, caller, "p1", { lane: "revisao" })).toMatchObject({
            ok: false,
            kind: "not_found",
        });
        fake.done();
    });

    it("validates task fields before writing", async () => {
        access.checkProjectAccess.mockResolvedValue(role("editor"));
        const fake = scriptedDb([]);
        expect(await updatePipelineCard(fake.db, caller, "p1", { status: "feito" })).toMatchObject({
            ok: false,
            kind: "validation",
        });
        expect(await updatePipelineCard(fake.db, caller, "p1", { deadline: "amanhã" })).toMatchObject({
            ok: false,
            kind: "validation",
        });
        fake.done();
    });

    it("writes the lane and task fields an editor sends", async () => {
        access.checkProjectAccess.mockResolvedValue(role("editor"));
        const fake = scriptedDb([{ table: "projects", op: "update", data: { id: "p1", lane: "revisao" } }]);
        const result = await updatePipelineCard(fake.db, caller, "p1", {
            lane: "revisao",
            status: "bloqueado",
            assignee_email: "Duda@Example.com",
        });
        expect(result.ok).toBe(true);
        expect(fake.calls[0].payload).toMatchObject({
            lane: "revisao",
            status: "bloqueado",
            assignee_email: "duda@example.com",
        });
        fake.done();
    });
});

describe("project-scoped reads and writes", () => {
    it("does not read a dossier of a project the caller cannot see", async () => {
        access.checkProjectAccess.mockResolvedValue({ ok: false });
        const fake = scriptedDb([]);
        expect(await getDossier(fake.db, caller, "p1")).toMatchObject({ ok: false, kind: "not_found" });
        fake.done();
    });

    it("does not tie an obligation to a project the caller cannot edit", async () => {
        access.checkProjectAccess.mockResolvedValue(role("viewer"));
        const fake = scriptedDb([]);
        const result = await createObligation(fake.db, caller, {
            title: "Aviso de não renovação",
            due_date: "2026-12-01",
            project_id: "p1",
        });
        expect(result).toMatchObject({ ok: false, kind: "forbidden" });
        fake.done();
    });

    it("asks for a model instead of guessing one", async () => {
        access.checkProjectAccess.mockResolvedValue(role("owner"));
        const fake = scriptedDb([]);
        expect(await extractContractTerms(fake.db, caller, "p1")).toMatchObject({
            ok: false,
            kind: "validation",
            code: "model_required",
        });
        fake.done();
    });
});

describe("obligation delete and the calendar mirror", () => {
    const id = "6f1c2a0e-8b4d-4e2a-9c3f-1a2b3c4d5e6f";

    it("removes the event of the row it deleted, by the stored id", async () => {
        const fake = scriptedDb([{ table: "obligations", op: "delete", data: [{ id }] }]);
        expect(await deleteObligation(fake.db, caller, id)).toEqual({ ok: true, data: null });
        expect(fake.calls[0].filters).toContainEqual(["eq", "user_id", "u"]);
        expect(gcal.removeCalendarEvent).toHaveBeenCalledWith(id);
        fake.done();
    });

    it("leaves the calendar alone when nothing of the caller's was deleted", async () => {
        const fake = scriptedDb([{ table: "obligations", op: "delete", data: [] }]);
        await deleteObligation(fake.db, caller, "someone-elses/../../calendars");
        expect(gcal.removeCalendarEvent).not.toHaveBeenCalled();
        fake.done();
    });

    it("only turns a UUID into an event id", () => {
        expect(eventId(id)).toBe("6f1c2a0e8b4d4e2a9c3f1a2b3c4d5e6f");
        expect(() => eventId("x/../../calendars/primary")).toThrow("not a UUID");
    });
});

describe("acervo", () => {
    it("searches only the projects the caller can see", async () => {
        access.listAccessibleProjectIds.mockResolvedValue([]);
        const fake = scriptedDb([]);
        expect(await askAcervo(fake.db, caller, { question: "foro de eleição?" })).toMatchObject({
            ok: true,
            data: { searched: 0, found: false },
        });
        fake.done();
    });

    it("ranks by the share of question terms a contract mentions, accents ignored", () => {
        expect(scoreCandidate("Qual o foro de eleição?", "Contrato — foro de eleicao: São Paulo")).toBe(1);
        expect(scoreCandidate("multa rescisória", "nada relevante")).toBe(0);
    });
});
