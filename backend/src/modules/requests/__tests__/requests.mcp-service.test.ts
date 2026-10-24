// What the MCP tools need from the requests service: the client acting for
// a person is recorded as such, the channel keeps the client's name, the
// team moves the card between stages, and the plan travels with the status.
// Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, uuid } from "./memoryDb";

const llm = vi.hoisted(() => ({ completeText: vi.fn() }));
vi.mock("../../../lib/llm", () => llm);
vi.mock("../../user/user.service", () => ({
    getUserModelSettings: vi.fn(async () => ({ tabular_model: "test-model", last_selected_chat_model: null, api_keys: {} })),
}));
vi.mock("../../../lib/dbq/enqueue", () => ({ enqueueDbJob: vi.fn(async () => ({ id: "job", deduped: false })) }));

import {
    assignRequest,
    createRequest,
    getRequestPlan,
    handleRequestTriage,
    listRequests,
    moveRequestStage,
    postMessage,
    requestPlan,
    type McpActor,
} from "../requests.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const HEAD = { userId: "aaaaaaaa-0000-4000-8000-000000000001", userEmail: "head@avenia.io" };
const ANALYST = { userId: "aaaaaaaa-0000-4000-8000-000000000002", userEmail: "duda@avenia.io" };
const REQUESTER = { userId: "bbbbbbbb-0000-4000-8000-000000000001", userEmail: "ana@avenia.io" };

function mcp(caller: { userId: string; userEmail: string }, name: string) {
    const actor: McpActor = {
        actorType: "agent",
        actorId: "mcp:claude-desktop",
        actorName: `claude-desktop em nome de ${name}`,
        onBehalfOf: caller.userEmail,
        source: "mcp",
    };
    return { ...caller, actor };
}

function world() {
    let number = 0;
    return memoryDb(
        {
            legal_teams: [{ org_id: ORG, sla_days: {}, auto_assign: false, created_at: "2026-01-01" }],
            org_members: [
                { org_id: ORG, user_id: HEAD.userId, role: "owner", created_at: "2026-01-01" },
                { org_id: ORG, user_id: ANALYST.userId, role: "member", created_at: "2026-01-02" },
            ],
            user_profiles: [
                { user_id: HEAD.userId, email: "head@avenia.io", display_name: "Marina" },
                { user_id: ANALYST.userId, email: "duda@avenia.io", display_name: "Duda" },
                { user_id: REQUESTER.userId, email: "ana@avenia.io", display_name: "Ana" },
            ],
        },
        {
            defaults: {
                legal_requests: () => {
                    number += 1;
                    const now = new Date().toISOString();
                    return {
                        number,
                        status: "novo",
                        paused_at: null,
                        paused_seconds: 0,
                        assignee_id: null,
                        assigned_at: null,
                        summary: null,
                        triage: null,
                        delivery: null,
                        delivered_at: null,
                        source: { channel: "form" },
                        idempotency_key: null,
                        created_at: now,
                        updated_at: now,
                    };
                },
                card_events: () => ({ at: new Date().toISOString() }),
                legal_request_notifications: () => ({ status: "pending", attempts: 0, created_at: new Date().toISOString() }),
                legal_request_messages: () => ({ created_at: new Date().toISOString() }),
                legal_request_participants: () => ({ revoked_at: null, created_at: new Date().toISOString() }),
            },
            rpc: {
                create_project_with_memory: (args, tables) => {
                    const row = { id: uuid(), user_id: args.p_user_id, name: args.p_name, org_id: args.p_org_id };
                    (tables.projects ??= []).push(row);
                    return row;
                },
            },
        },
    );
}

async function viaMcp(w: ReturnType<typeof world>) {
    const created = await createRequest(w.db, mcp(REQUESTER, "Ana"), {
        kind: "nda",
        counterparty: "Polaris Tecnologia",
        context: "Vamos trocar dados de clientes para um piloto.",
        requester_area: "Comercial",
        source: { channel: "mcp", client: "claude-desktop" },
    });
    if (!created.ok) throw new Error(JSON.stringify(created));
    return created.data.request;
}

beforeEach(() => {
    llm.completeText.mockReset();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("a request through an assistant (MCP)", () => {
    it("records the client acting for the person, the channel mcp:<client> and the chosen area", async () => {
        const w = world();
        const view = await viaMcp(w);
        expect(w.table("legal_requests")[0]).toMatchObject({
            source: { channel: "mcp", client: "claude-desktop" },
            requester_area: "Comercial",
            requester_area_source: "form",
            requester_id: REQUESTER.userId,
        });
        expect(w.table("card_events")[0]).toMatchObject({
            action: "request.created",
            actor_type: "agent",
            actor_id: "mcp:claude-desktop",
            actor_name: "claude-desktop em nome de Ana",
            on_behalf_of: REQUESTER.userEmail,
            source: "mcp",
            after: { channel: "mcp:claude-desktop" },
        });
        const list = await listRequests(w.db, HEAD);
        expect(list.ok && list.data.items.find((i) => i.id === view.id)?.channel).toBe("mcp");
    });

    it("every team move through the assistant is the client's, on the person's behalf", async () => {
        const w = world();
        const view = await viaMcp(w);
        await assignRequest(w.db, mcp(ANALYST, "Duda"), view.id, { assignee_id: ANALYST.userId });
        await postMessage(w.db, mcp(ANALYST, "Duda"), view.id, { body: "Tem a minuta?", kind: "question" });
        const events = w.table("card_events").slice(1);
        expect(events.map((e) => e.action)).toEqual(["assignee.changed", "request.question"]);
        for (const e of events) {
            expect(e).toMatchObject({ actor_type: "agent", actor_id: "mcp:claude-desktop", on_behalf_of: ANALYST.userEmail, source: "mcp" });
        }
        // The message itself stays the person's.
        expect(w.table("legal_request_messages")[0]).toMatchObject({ author_id: ANALYST.userId, author_name: "Duda" });
    });

    it("without an actor, events stay the person's at a screen", async () => {
        const w = world();
        const created = await createRequest(w.db, REQUESTER, { kind: "nda", context: "Piloto com a Polaris." });
        if (!created.ok) throw new Error("create");
        await assignRequest(w.db, ANALYST, created.data.request.id, { assignee_id: ANALYST.userId });
        expect(w.table("card_events").map((e) => [e.actor_type, e.actor_id])).toEqual([
            ["user", REQUESTER.userId],
            ["user", ANALYST.userId],
        ]);
    });
});

describe("moveRequestStage", () => {
    it("lets the team move the card, logs it, and the requester's step follows", async () => {
        const w = world();
        const view = await viaMcp(w);
        expect(await moveRequestStage(w.db, REQUESTER, view.id, { lane: "assinatura" })).toMatchObject({
            ok: false,
            kind: "forbidden",
        });
        expect(await moveRequestStage(w.db, ANALYST, view.id, { lane: "lixo" })).toMatchObject({
            ok: false,
            kind: "validation",
            detail: "Escolha uma etapa: Entrada, Triagem, Revisão, Negociação, Assinatura, Arquivado.",
        });
        const moved = await moveRequestStage(w.db, mcp(ANALYST, "Duda"), view.id, { lane: "assinatura" });
        expect(moved).toMatchObject({ ok: true, data: { lane: "assinatura", step: "assinatura" } });
        expect(w.table("projects")[0]).toMatchObject({ lane: "assinatura" });
        expect(w.table("card_events").at(-1)).toMatchObject({
            action: "lane.changed",
            field: "lane",
            before: "entrada",
            after: "assinatura",
            actor_id: "mcp:claude-desktop",
        });
        // Same stage again: nothing new is logged.
        const count = w.table("card_events").length;
        await moveRequestStage(w.db, ANALYST, view.id, { lane: "assinatura" });
        expect(w.table("card_events")).toHaveLength(count);
    });
});

describe("plan", () => {
    it("returns the status with the plan; the requester sees what to send but not the playbook step", async () => {
        const w = world();
        const view = await viaMcp(w);
        llm.completeText.mockResolvedValue(
            '{"kind":"nda","counterparty":"Polaris","summary":"x","missing":["CNPJ da contraparte"]}',
        );
        await handleRequestTriage(w.db, { payload: { request_id: view.id } });
        const row = w.table("legal_requests")[0];
        row.triage = { ...(row.triage as object), playbook_name: "NDA padrão" };

        const team = await getRequestPlan(w.db, HEAD, view.id);
        expect(team.ok && team.data.plan.map((s) => s.id)).toEqual([
            "triagem",
            "atribuicao",
            "revisao",
            "solicitante",
            "analise",
            "devolutiva",
        ]);
        const mine = await getRequestPlan(w.db, REQUESTER, view.id);
        expect(mine).toMatchObject({ ok: true, data: { request: { audience: "requester" } } });
        if (!mine.ok) return;
        expect(mine.data.plan.map((s) => s.id)).not.toContain("revisao");
        expect(mine.data.plan.find((s) => s.id === "solicitante")).toMatchObject({
            task: "enviar: CNPJ da contraparte",
            state: "a_fazer",
        });
        expect(mine.data.request).not.toHaveProperty("triage");
    });

    it("hides the request from whoever has nothing to do with it", async () => {
        const w = world();
        const view = await viaMcp(w);
        const stranger = { userId: "bbbbbbbb-0000-4000-8000-000000000009", userEmail: "x@avenia.io" };
        expect(await getRequestPlan(w.db, stranger, view.id)).toMatchObject({ ok: false, kind: "not_found" });
    });

    it("marks each step's state as the request moves", () => {
        const base = { assignee_name: "Duda", requester_name: null, requester_email: "ana@avenia.io", answered: false };
        expect(requestPlan({ ...base, status: "novo", assignee_name: null, triage: null }).map((s) => s.state)).toEqual([
            "rodando",
            "a_fazer",
            "a_fazer",
            "a_fazer",
        ]);
        const waiting = requestPlan({ ...base, status: "aguardando_solicitante", triage: { kind: "nda" } });
        expect(waiting.find((s) => s.id === "solicitante")).toMatchObject({
            owner: { kind: "requester", name: "ana@avenia.io" },
            task: "responder a pergunta do Legal",
            state: "aguardando",
        });
        expect(requestPlan({ ...base, status: "em_andamento", triage: { kind: "nda" } }).find((s) => s.id === "analise")?.state).toBe(
            "rodando",
        );
        const done = requestPlan({ ...base, status: "entregue", answered: true, triage: { kind: "nda", missing: ["x"] } });
        expect(done.every((s) => s.state === "feito")).toBe(true);
    });
});
