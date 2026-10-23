// The spine of a request (U-13): the stage catalogue, who holds the ball, the
// history and the strip. No model anywhere. Synthetic data only.
import { describe, expect, it, vi } from "vitest";
import { memoryDb, uuid } from "./memoryDb";

const enqueue = vi.hoisted(() => ({ enqueueDbJob: vi.fn(async () => ({ id: "job", deduped: false })) }));
vi.mock("../../../lib/dbq/enqueue", () => enqueue);

import {
    assignRequest,
    buildStrip,
    createRequest,
    currentStage,
    deliverRequest,
    getRequest,
    laneOfStage,
    moveStage,
    STAGE_CATALOG,
    STAGES,
    stageOwner,
    syncStage,
    type RequestTeamView,
} from "../requests.service";
import { COUNTED_STAGES, requesterStep, stageOfLane, stepOfStage } from "../requests.stages";
import { loadStageHistory } from "../requests.stages";

const ORG = "11111111-1111-4111-8111-111111111111";
const HEAD = { userId: "aaaaaaaa-0000-4000-8000-000000000001", userEmail: "head@avenia.io" };
const DUDA = { userId: "aaaaaaaa-0000-4000-8000-000000000002", userEmail: "duda@avenia.io" };
const REQUESTER = { userId: "bbbbbbbb-0000-4000-8000-000000000001", userEmail: "ana@avenia.io" };

function world() {
    let number = 0;
    return memoryDb(
        {
            legal_teams: [{ org_id: ORG, sla_days: {}, auto_assign: false, intake_template: [], assignment_rules: [], created_at: "2026-01-01" }],
            org_members: [
                { org_id: ORG, user_id: HEAD.userId, role: "owner", created_at: "2026-01-01" },
                { org_id: ORG, user_id: DUDA.userId, role: "member", created_at: "2026-01-02" },
            ],
            user_profiles: [
                { user_id: HEAD.userId, email: "head@avenia.io", display_name: "Marina" },
                { user_id: DUDA.userId, email: "duda@avenia.io", display_name: "Duda" },
                { user_id: REQUESTER.userId, email: "ana@avenia.io", display_name: "Ana" },
            ],
        },
        {
            defaults: {
                legal_requests: () => {
                    number += 1;
                    const now = new Date().toISOString();
                    return {
                        number, status: "novo", paused_at: null, paused_seconds: 0, assignee_id: null, assigned_at: null,
                        assigned_by: null, summary: null, triage: null, delivery: null, delivered_at: null,
                        source: { channel: "form" }, intake: {}, intake_completed_at: null, critical_alert_at: null,
                        idempotency_key: null, created_at: now, updated_at: now,
                    };
                },
                card_events: () => ({ at: new Date().toISOString() }),
                legal_request_notifications: () => ({ status: "pending", attempts: 0, created_at: new Date().toISOString() }),
                legal_request_messages: () => ({ created_at: new Date().toISOString() }),
                legal_request_participants: () => ({ revoked_at: null, created_at: new Date().toISOString() }),
                legal_request_stages: () => ({ left_at: null }),
            },
            rpc: {
                create_project_with_memory: (args, tables) => {
                    const row = { id: uuid(), user_id: args.p_user_id, name: args.p_name, org_id: args.p_org_id, lane: null };
                    (tables.projects ??= []).push(row);
                    return row;
                },
            },
        },
    );
}

const agent = { kind: "agent", id: null, name: "Agente de triagem" } as const;
const person = { kind: "person", id: DUDA.userId, name: "Duda" } as const;

describe("the catalogue", () => {
    it("has seven stages, and every stage names a lane and a step", () => {
        expect(STAGES).toHaveLength(7);
        for (const stage of STAGES) {
            expect(STAGE_CATALOG[stage].label).toBeTruthy();
            expect(laneOfStage(stage)).toBe(STAGE_CATALOG[stage].lane);
        }
        expect(stepOfStage("checklist")).toBe("em_analise");
        expect(stepOfStage("assinatura")).toBe("assinatura");
    });

    it("counts five stages in 'etapa 3 de 5': the two ends do not count", () => {
        expect(COUNTED_STAGES).toEqual(["triagem", "checklist", "analise", "negociacao", "assinatura"]);
        expect(STAGES.filter((s) => !COUNTED_STAGES.includes(s))).toEqual(["recebido", "concluido"]);
    });

    it("maps a lane back to its stage, and an unknown lane to nothing", () => {
        expect(stageOfLane("revisao")).toBe("analise");
        expect(stageOfLane("arquivado")).toBe("concluido");
        expect(stageOfLane("outra")).toBeNull();
        expect(stageOfLane(null)).toBeNull();
    });

    it("keeps the four steps whoever asked sees, exactly as before", () => {
        expect(requesterStep("novo", "entrada")).toBe("recebido");
        expect(requesterStep("em_triagem", null)).toBe("recebido");
        expect(requesterStep("em_andamento", "triagem")).toBe("em_analise");
        expect(requesterStep("aguardando_solicitante", "entrada")).toBe("em_analise");
        expect(requesterStep("novo", "negociacao")).toBe("recebido");
        expect(requesterStep("em_andamento", "negociacao")).toBe("em_analise");
        expect(requesterStep("em_andamento", "assinatura")).toBe("assinatura");
        expect(requesterStep("em_andamento", "arquivado")).toBe("concluido");
        expect(requesterStep("cancelado", "revisao")).toBe("concluido");
        expect(requesterStep("entregue", null)).toBe("concluido");
    });
});

describe("which stage a request is in", () => {
    const at = (over: Partial<Parameters<typeof currentStage>[0]>) =>
        currentStage({ status: "em_andamento", lane: "triagem", triaged: true, checklistOpen: false, ...over });

    it("is received until the triage has read it, then in triage", () => {
        expect(at({ status: "novo", lane: "entrada", triaged: false })).toBe("recebido");
        expect(at({ status: "novo", lane: null, triaged: false })).toBe("recebido");
        expect(at({ status: "em_triagem", lane: "triagem", triaged: false })).toBe("triagem");
        expect(at({ status: "em_triagem", lane: "triagem", triaged: true })).toBe("triagem");
    });

    it("is the checklist while the requester still owes answers, until the analysis starts", () => {
        expect(at({ status: "em_andamento", checklistOpen: true })).toBe("checklist");
        expect(at({ status: "em_triagem", checklistOpen: true })).toBe("checklist");
        expect(at({ status: "em_andamento", checklistOpen: false })).toBe("analise");
    });

    it("follows the pipeline lane from review onwards, whatever the checklist says", () => {
        expect(at({ lane: "revisao", checklistOpen: true })).toBe("analise");
        expect(at({ lane: "negociacao" })).toBe("negociacao");
        expect(at({ lane: "assinatura" })).toBe("assinatura");
    });

    it("is concluded when delivered, cancelled or archived", () => {
        expect(at({ status: "entregue" })).toBe("concluido");
        expect(at({ status: "cancelado", lane: "revisao" })).toBe("concluido");
        expect(at({ lane: "arquivado" })).toBe("concluido");
    });
});

describe("who holds the ball", () => {
    const ctx = (over: Partial<Parameters<typeof stageOwner>[1]> = {}) => ({
        assignee: { id: DUDA.userId, name: "Duda" },
        requester: { name: "Ana", email: "ana@avenia.io" },
        waitingOnRequester: false,
        ...over,
    });

    it("is the triage agent until someone has the request, then that person", () => {
        expect(stageOwner("triagem", ctx({ assignee: null }))).toEqual(agent);
        expect(stageOwner("recebido", ctx({ assignee: null }))).toEqual(agent);
        expect(stageOwner("triagem", ctx())).toEqual(person);
    });

    it("is the requester in the checklist and whenever the team waits on them", () => {
        expect(stageOwner("checklist", ctx())).toEqual({ kind: "requester", id: null, name: "Ana" });
        expect(stageOwner("analise", ctx({ waitingOnRequester: true }))).toEqual({ kind: "requester", id: null, name: "Ana" });
        expect(stageOwner("checklist", ctx({ requester: { name: null, email: "ana@avenia.io" } })).name).toBe("ana@avenia.io");
    });

    it("is the person in analysis, negotiation and signature, and nobody when there is none or it is over", () => {
        for (const stage of ["analise", "negociacao", "assinatura"] as const) expect(stageOwner(stage, ctx())).toEqual(person);
        expect(stageOwner("analise", ctx({ assignee: null }))).toEqual({ kind: "none", id: null, name: null });
        expect(stageOwner("concluido", ctx())).toEqual({ kind: "none", id: null, name: null });
    });
});

describe("the history", () => {
    it("opens a row, closes it when the stage changes, and does not stack identical rows", async () => {
        const w = world();
        const rid = uuid();
        expect((await moveStage(w.db, rid, "recebido", agent, "pedido recebido", new Date("2026-10-22T10:00:00Z"))).moved).toBe(true);
        expect((await moveStage(w.db, rid, "recebido", agent, null, new Date("2026-10-22T10:05:00Z"))).moved).toBe(false);
        expect((await moveStage(w.db, rid, "triagem", person, "x".repeat(300), new Date("2026-10-22T11:00:00Z"))).moved).toBe(true);

        const rows = await loadStageHistory(w.db, rid);
        expect(rows.map((r) => r.stage)).toEqual(["recebido", "triagem"]);
        expect(rows[0].left_at).toBe("2026-10-22T11:00:00.000Z");
        expect(rows[1].left_at).toBeNull();
        expect(rows[1].note).toHaveLength(140);
    });

    it("opens a new row when the owner changes inside the same stage, so the timeline says who had it", async () => {
        const w = world();
        const rid = uuid();
        await moveStage(w.db, rid, "analise", person, null, new Date("2026-10-22T10:00:00Z"));
        await moveStage(w.db, rid, "analise", { kind: "person", id: HEAD.userId, name: "Marina" }, "responsável definido", new Date("2026-10-23T10:00:00Z"));
        const rows = await loadStageHistory(w.db, rid);
        expect(rows.map((r) => r.owner_name)).toEqual(["Duda", "Marina"]);
        expect(rows.filter((r) => r.left_at === null)).toHaveLength(1);
    });

    it("never fails the caller when the database does", async () => {
        const broken = memoryDb({}, { fail: () => ({ message: "boom" }) });
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        expect(await moveStage(broken.db, uuid(), "recebido", agent)).toEqual({ moved: false });
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    it("tells when a later write fails after the open row was read", async () => {
        const inner = world();
        const rid = uuid();
        await moveStage(inner.db, rid, "recebido", agent);
        const seeded = memoryDb({ legal_request_stages: inner.table("legal_request_stages") }, {
            defaults: { legal_request_stages: () => ({ left_at: null }) },
            fail: (t, op) => (t === "legal_request_stages" && op === "update" ? { message: "boom" } : null),
        });
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        expect((await moveStage(seeded.db, rid, "triagem", agent)).moved).toBe(false);
        spy.mockRestore();
    });
});

describe("the strip", () => {
    const row = (stage: (typeof STAGES)[number], enteredAt: string, leftAt: string | null = null) =>
        ({ stage, owner_kind: "person", owner_id: DUDA.userId, owner_name: "Duda", entered_at: enteredAt, left_at: leftAt, note: null }) as const;

    it("marks what is behind as done, the current one with who and since when, and the rest as pending", () => {
        const strip = buildStrip("checklist", { kind: "requester", id: null, name: "Ana" }, [
            row("recebido", "2026-10-21T10:00:00Z", "2026-10-21T10:01:00Z"),
            row("triagem", "2026-10-21T10:01:00Z", "2026-10-21T11:00:00Z"),
            row("checklist", "2026-10-21T11:00:00Z"),
        ]);
        expect(strip.label).toBe("Checklist");
        expect(strip.position).toEqual({ index: 2, of: 5 });
        expect(strip.since).toBe("2026-10-21T11:00:00Z");
        expect(strip.strip.map((s) => s.state)).toEqual(["concluida", "concluida", "atual", "pendente", "pendente", "pendente", "pendente"]);
        expect(strip.strip[2]).toMatchObject({ owner: { name: "Ana" }, since: "2026-10-21T11:00:00Z" });
        expect(strip.strip[0]).toMatchObject({ owner: null, since: null });
    });

    it("has no position on the two ends, and everything is done once concluded", () => {
        expect(buildStrip("recebido", agent, []).position).toBeNull();
        const done = buildStrip("concluido", { kind: "none", id: null, name: null }, []);
        expect(done.position).toBeNull();
        expect(done.strip.every((s) => s.state === "concluida" || s.stage === "concluido")).toBe(true);
    });

    it("leaves 'since' empty for a request older than the history", () => {
        expect(buildStrip("analise", person, []).since).toBeNull();
    });
});

describe("on a real request", () => {
    async function open(w: ReturnType<typeof world>) {
        const r = await createRequest(w.db, REQUESTER, { kind: "nda", counterparty: "Nuvem Fictícia S.A.", context: "NDA." });
        if (!r.ok) throw new Error(JSON.stringify(r));
        return r.data.request.id;
    }
    const teamView = async (w: ReturnType<typeof world>, id: string) => {
        const v = await getRequest(w.db, HEAD, id);
        if (!v.ok) throw new Error(JSON.stringify(v));
        return v.data as RequestTeamView;
    };

    it("starts received, follows the assignment and the delivery, and records each step with its reason", async () => {
        const w = world();
        const id = await open(w);
        expect((await loadStageHistory(w.db, id)).map((r) => r.stage)).toEqual(["recebido"]);

        const assigned = await assignRequest(w.db, HEAD, id, { assignee_id: DUDA.userId });
        expect(assigned.ok).toBe(true);
        const view = await teamView(w, id);
        expect(view.stage).toMatchObject({ stage: "checklist", owner: { kind: "requester" } });
        expect(view.stages.map((s) => s.stage)).toEqual(["recebido", "checklist"]);
        expect(view.stages[1].note).toBe("responsável definido");

        const delivered = await deliverRequest(w.db, HEAD, id, { message: "Validação técnica concluída." });
        expect(delivered.ok).toBe(true);
        const closed = await teamView(w, id);
        expect(closed.stage.stage).toBe("concluido");
        expect(closed.stage.strip.every((s) => s.state === "concluida")).toBe(true);
        expect(closed.stages.at(-1)).toMatchObject({ stage: "concluido", note: "devolutiva enviada" });
        expect(closed.stages.filter((s) => s.left_at === null)).toHaveLength(1);
    });

    it("picks up a card moved on the board the next time anyone looks, and never shows it to whoever asked", async () => {
        const w = world();
        const id = await open(w);
        await assignRequest(w.db, HEAD, id, { assignee_id: DUDA.userId });
        const req = w.table("legal_requests").find((r) => r.id === id)!;
        req.intake_completed_at = "2026-10-22T12:00:00Z";
        w.table("projects").find((p) => p.id === req.project_id)!.lane = "negociacao";

        const view = await teamView(w, id);
        expect(view.stage).toMatchObject({ stage: "negociacao", owner: { name: "Duda" } });

        const asked = await getRequest(w.db, REQUESTER, id);
        expect(asked.ok && asked.data).toMatchObject({ step: "em_analise" });
        expect(asked.ok && "stage" in asked.data).toBe(false);
        expect(asked.ok && "stages" in asked.data).toBe(false);
    });

    it("syncs a request that has no card and no owner without failing", async () => {
        const w = world();
        const out = await syncStage(w.db, {
            id: uuid(), org_id: ORG, project_id: null, status: "novo", assignee_id: null,
            requester_name: null, requester_email: "ana@avenia.io", triage: null, intake_completed_at: null,
        });
        expect(out.stage).toBe("recebido");
        expect(out.owner).toEqual(agent);
    });
});
