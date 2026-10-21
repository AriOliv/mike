import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, uuid } from "./memoryDb";

const llm = vi.hoisted(() => ({ completeText: vi.fn() }));
vi.mock("../../../lib/llm", () => llm);
const settings = vi.hoisted(() => ({
    getUserModelSettings: vi.fn(async () => ({
        tabular_model: "test-model",
        last_selected_chat_model: null,
        api_keys: {},
    })),
}));
vi.mock("../../user/user.service", () => settings);
const enqueue = vi.hoisted(() => ({ enqueueDbJob: vi.fn(async () => ({ id: "job", deduped: false })) }));
vi.mock("../../../lib/dbq/enqueue", () => enqueue);

import {
    assignRequest,
    createRequest,
    decideTriage,
    deliverRequest,
    getRequest,
    handleRequestNotify,
    handleRequestTriage,
    inviteParticipant,
    listRequests,
    postMessage,
    revokeParticipant,
    whoAmI,
    type RequestTeamView,
} from "../requests.service";
import { setMailTransport } from "../../../lib/mailer";

const ORG = "11111111-1111-4111-8111-111111111111";
const HEAD = { userId: "aaaaaaaa-0000-4000-8000-000000000001", userEmail: "head@avenia.io" };
const ANALYST = { userId: "aaaaaaaa-0000-4000-8000-000000000002", userEmail: "duda@avenia.io" };
const ANALYST2 = { userId: "aaaaaaaa-0000-4000-8000-000000000003", userEmail: "teo@avenia.io" };
const REQUESTER = { userId: "bbbbbbbb-0000-4000-8000-000000000001", userEmail: "Ana@Avenia.io" };
const STRANGER = { userId: "bbbbbbbb-0000-4000-8000-000000000002", userEmail: "x@avenia.io" };
const FIRM = { userId: "cccccccc-0000-4000-8000-000000000001", userEmail: "socio@escritorio.com.br" };

function world(extra: Record<string, Record<string, unknown>[]> = {}) {
    let number = 0;
    return memoryDb(
        {
            legal_teams: [{ org_id: ORG, sla_days: {}, auto_assign: false, created_at: "2026-01-01" }],
            org_members: [
                { org_id: ORG, user_id: HEAD.userId, role: "owner", created_at: "2026-01-01" },
                { org_id: ORG, user_id: ANALYST.userId, role: "member", created_at: "2026-01-02" },
                { org_id: ORG, user_id: ANALYST2.userId, role: "member", created_at: "2026-01-03" },
            ],
            user_profiles: [
                { user_id: HEAD.userId, email: "head@avenia.io", display_name: "Marina" },
                { user_id: ANALYST.userId, email: "duda@avenia.io", display_name: "Duda" },
                { user_id: ANALYST2.userId, email: "teo@avenia.io", display_name: "Téo" },
                { user_id: REQUESTER.userId, email: "ana@avenia.io", display_name: "Ana" },
            ],
            ...extra,
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

async function newRequest(w: ReturnType<typeof world>, body: Record<string, unknown> = {}) {
    const result = await createRequest(w.db, REQUESTER, {
        kind: "nda",
        counterparty: "Polaris Tecnologia",
        context: "Vamos trocar dados de clientes para um piloto.",
        ...body,
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.data.request;
}

beforeEach(() => {
    llm.completeText.mockReset();
    enqueue.enqueueDbJob.mockClear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z")); // a Tuesday
});
afterEach(() => {
    vi.useRealTimers();
    setMailTransport(null);
});

describe("createRequest", () => {
    it("creates the request, its card on Entrada, the event, the e-mail and the triage job", async () => {
        const w = world();
        const view = await newRequest(w);
        expect(view.code).toBe("LEG-0001");
        expect(view.title).toBe("NDA · Polaris Tecnologia");
        expect(view.status).toBe("novo");
        expect(view.step).toBe("recebido");
        // NDA: 1 business day.
        expect(view.due_at).toBe("2026-10-21T12:00:00.000Z");
        expect(view.audience).toBe("requester");
        expect(view).not.toHaveProperty("triage");

        const [card] = w.table("projects");
        expect(card).toMatchObject({
            org_id: ORG,
            lane: "entrada",
            status: "a_fazer",
            visibility: "organization",
            contract_type: "NDA",
            counterparty: "Polaris Tecnologia",
        });
        const [request] = w.table("legal_requests");
        expect(request).toMatchObject({ requester_email: "ana@avenia.io", project_id: card.id });
        expect(w.table("card_events")[0]).toMatchObject({ action: "request.created", actor_type: "user" });
        expect(w.table("legal_request_notifications")[0]).toMatchObject({
            template: "request.created",
            recipient: "ana@avenia.io",
        });
        expect(enqueue.enqueueDbJob).toHaveBeenCalledWith(
            w.db,
            expect.objectContaining({ kind: "request.triage", dedupeKey: `triage:${request.id}` }),
        );
    });

    it("validates the kind and asks for at least one sentence", async () => {
        const w = world();
        expect(await createRequest(w.db, REQUESTER, { kind: "x" })).toMatchObject({ ok: false, kind: "validation" });
        expect(await createRequest(w.db, REQUESTER, { kind: "parecer" })).toMatchObject({
            ok: false,
            detail: "Conte em uma frase o que você precisa.",
        });
        expect(
            await createRequest(w.db, REQUESTER, { kind: "parecer", context: "x", needed_by: "amanhã" }),
        ).toMatchObject({ ok: false, kind: "validation" });
        expect(
            await createRequest(w.db, REQUESTER, { kind: "parecer", context: "x", document_ids: Array.from({ length: 6 }, () => uuid()) }),
        ).toMatchObject({ ok: false, kind: "validation" });
        expect(await createRequest(w.db, { userId: "u" }, { kind: "nda", context: "x" })).toMatchObject({
            ok: false,
            kind: "validation",
        });
    });

    it("says the team is not set up instead of failing", async () => {
        const w = world({ legal_teams: [] });
        expect(await createRequest(w.db, REQUESTER, { kind: "nda", context: "x" })).toMatchObject({
            ok: false,
            kind: "unavailable",
            code: "legal_team_missing",
        });
        expect(await whoAmI(w.db, REQUESTER)).toMatchObject({ ok: true, data: { configured: false } });
    });

    it("returns the same request for a repeated idempotency key (chat bot retries)", async () => {
        const w = world();
        const first = await createRequest(w.db, REQUESTER, {
            kind: "parecer",
            context: "Posso assinar com cláusula de exclusividade?",
            idempotency_key: "slack:C1:123.45",
            source: { channel: "slack", channel_id: "C1", thread_ts: "123.45", bot: "docbot", junk: "x" },
        });
        const again = await createRequest(w.db, REQUESTER, {
            kind: "parecer",
            context: "de novo",
            idempotency_key: "slack:C1:123.45",
        });
        expect(first).toMatchObject({ ok: true, data: { deduplicated: false } });
        expect(again).toMatchObject({ ok: true, data: { deduplicated: true } });
        expect(w.table("legal_requests")).toHaveLength(1);
        expect(w.table("legal_requests")[0].source).toEqual({
            channel: "slack",
            channel_id: "C1",
            thread_ts: "123.45",
            bot: "docbot",
        });
        expect(w.table("card_events")[0]).toMatchObject({
            actor_type: "hermes",
            actor_id: "hermes:docbot",
            on_behalf_of: "ana@avenia.io",
        });
    });

    it("moves only the requester's own standalone uploads onto the card", async () => {
        const mine = uuid();
        const someoneElses = uuid();
        const inOtherOrg = uuid();
        const w = world({
            documents: [
                { id: mine, user_id: REQUESTER.userId, project_id: null, workflow_id: null, org_id: null, organizations: null },
                { id: someoneElses, user_id: STRANGER.userId, project_id: null, workflow_id: null, org_id: null, organizations: null },
                {
                    id: inOtherOrg,
                    user_id: REQUESTER.userId,
                    project_id: null,
                    workflow_id: null,
                    org_id: "other",
                    organizations: { kind: "team", personal_user_id: null },
                },
            ],
        });
        await newRequest(w, { document_ids: [mine, someoneElses, inOtherOrg] });
        const card = w.table("projects")[0];
        const docs = Object.fromEntries(w.table("documents").map((d) => [d.id, d.project_id]));
        expect(docs).toEqual({ [mine]: card.id, [someoneElses]: null, [inOtherOrg]: null });
    });

    it("uses the requester's sooner date and the team's own SLA table", async () => {
        const w = world({ legal_teams: [{ org_id: ORG, sla_days: { contrato_novo: 10 }, created_at: "2026-01-01" }] });
        const soon = await newRequest(w, { kind: "contrato_novo", needed_by: "2026-10-22" });
        expect(soon.due_at).toBe("2026-10-22T23:59:59.000Z");
        const urgent = await newRequest(w, { kind: "contrato_novo", urgency: "urgente" });
        // 10 business days / 3 → 3 business days.
        expect(urgent.due_at).toBe("2026-10-23T12:00:00.000Z");
    });
});

describe("who sees what", () => {
    it("shows the team view to members and the narrow view to the requester, hides it from others", async () => {
        const w = world();
        const view = await newRequest(w);
        const team = await getRequest(w.db, ANALYST, view.id);
        expect(team).toMatchObject({ ok: true, data: { audience: "team", can_decide: false, lane: "entrada" } });
        expect(await getRequest(w.db, HEAD, view.id)).toMatchObject({ ok: true, data: { can_decide: true } });
        expect(await getRequest(w.db, STRANGER, view.id)).toMatchObject({ ok: false, kind: "not_found" });
        expect(await getRequest(w.db, STRANGER, "nope")).toMatchObject({ ok: false, kind: "not_found" });
    });

    it("lists the queue for the team and only their own for a requester", async () => {
        const w = world();
        await newRequest(w);
        await createRequest(w.db, STRANGER, { kind: "parecer", context: "Outra dúvida" });

        const queue = await listRequests(w.db, HEAD);
        expect(queue).toMatchObject({ ok: true, data: { scope: "team", is_head: true } });
        if (!queue.ok) return;
        expect(queue.data.items).toHaveLength(2);
        expect(queue.data.counts.sem_dono).toBe(2);
        expect(queue.data.team.map((m) => m.name)).toEqual(["Marina", "Duda", "Téo"]);

        const mine = await listRequests(w.db, REQUESTER);
        expect(mine).toMatchObject({ ok: true, data: { scope: "requester", team: [] } });
        if (!mine.ok) return;
        expect(mine.data.items.map((i) => i.code)).toEqual(["LEG-0001"]);
        expect(mine.data.items[0].project_id).toBeNull();

        const teamAsRequester = await listRequests(w.db, ANALYST, { mine: true });
        expect(teamAsRequester).toMatchObject({ ok: true, data: { scope: "requester", items: [] } });
    });
});

describe("triage agent", () => {
    it("classifies, summarizes, suggests the least loaded analyst and a playbook, and waits for the Head", async () => {
        const w = world({
            playbooks: [{ id: "pb-nda", name: "Playbook NDA Avenia", org_id: ORG, visibility: "organization", updated_at: "2026-10-01" }],
        });
        const view = await newRequest(w);
        // Duda already has one open request; Téo none; the Head none either.
        w.table("legal_requests").push({
            id: uuid(),
            org_id: ORG,
            assignee_id: ANALYST.userId,
            kind: "nda",
            status: "em_andamento",
            assigned_at: "2026-10-10",
        });
        llm.completeText.mockResolvedValue(
            '```json\n{"kind":"nda","counterparty":"Polaris Tecnologia S.A.","area":"Comercial","summary":"Comercial precisa de um NDA com a Polaris para um piloto com dados de clientes.","missing":["minuta da contraparte", ""]}\n```',
        );
        const result = await handleRequestTriage(w.db, { payload: { request_id: view.id }, id: "job-1" });
        expect(result).toEqual({ triaged: true, auto_assigned: false });

        const row = w.table("legal_requests").find((r) => r.id === view.id)!;
        expect(row.status).toBe("em_triagem");
        expect(row.summary).toMatch(/NDA com a Polaris/);
        expect(row.assignee_id).toBeNull();
        expect(row.triage).toMatchObject({
            kind: "nda",
            counterparty: "Polaris Tecnologia S.A.",
            area: "Comercial",
            missing: ["minuta da contraparte"],
            assignee_name: "Marina",
            playbook_id: "pb-nda",
            ai: true,
            decision: null,
        });
        expect((row.triage as { assignee_reason: string }).assignee_reason).toMatch(/^Marina: 0 pedidos abertos/);
        expect(w.table("agent_runs")[0]).toMatchObject({ agent: "triagem", status: "succeeded", model_resolved: "test-model" });
        expect(w.table("card_events").map((e) => e.action)).toEqual([
            "request.created",
            "request.triaged",
            "assignee.suggested",
        ]);

        // A decided triage is never redone.
        await decideTriage(w.db, HEAD, view.id, { decision: "rejected", reason: "já tem dono" });
        expect(await handleRequestTriage(w.db, { payload: { request_id: view.id } })).toEqual({ skipped: "decided" });
        expect(await handleRequestTriage(w.db, { payload: { request_id: uuid() } })).toEqual({ skipped: "missing" });
    });

    it("still suggests an assignee when the model fails, and assigns at once when the team asked for it", async () => {
        const w = world({ legal_teams: [{ org_id: ORG, sla_days: {}, auto_assign: true, created_at: "2026-01-01" }] });
        const view = await newRequest(w);
        llm.completeText.mockRejectedValue(new Error("provider down"));
        expect(await handleRequestTriage(w.db, { payload: { request_id: view.id } })).toEqual({
            triaged: true,
            auto_assigned: true,
        });
        const row = w.table("legal_requests")[0];
        expect(row.triage).toMatchObject({ ai: false, kind: "nda" });
        // Nobody has open work: ties go alphabetically (Duda, Marina, Téo).
        expect(row.assignee_id).toBe(ANALYST.userId);
        expect(w.table("projects")[0].assignee_email).toBe("duda@avenia.io");
        expect(w.table("card_events").at(-1)).toMatchObject({ action: "assignee.changed", actor_type: "agent" });
    });
});

describe("the team works the request", () => {
    async function triaged(w: ReturnType<typeof world>) {
        const view = await newRequest(w);
        llm.completeText.mockResolvedValue('{"kind":"revisao","counterparty":null,"summary":"x","missing":[]}');
        await handleRequestTriage(w.db, { payload: { request_id: view.id } });
        return view;
    }

    it("only the Head decides the triage; accepting applies kind and assignee and moves the card", async () => {
        const w = world();
        const view = await triaged(w);
        expect(await decideTriage(w.db, ANALYST, view.id, { decision: "accepted" })).toMatchObject({
            ok: false,
            kind: "forbidden",
        });
        expect(await decideTriage(w.db, REQUESTER, view.id, { decision: "accepted" })).toMatchObject({
            ok: false,
            kind: "forbidden",
        });
        expect(await decideTriage(w.db, HEAD, view.id, { decision: "maybe" })).toMatchObject({ ok: false, kind: "validation" });

        const accepted = await decideTriage(w.db, HEAD, view.id, { decision: "accepted" });
        expect(accepted).toMatchObject({ ok: true, data: { kind: "revisao", status: "em_andamento", lane: "triagem" } });
        const card = w.table("projects")[0];
        expect(card).toMatchObject({ contract_type: "Revisão de contrato", assignee_email: "duda@avenia.io", status: "em_andamento" });
        expect(w.table("legal_request_notifications").map((n) => n.template)).toEqual([
            "request.created",
            "request.assigned",
        ]);
    });

    it("reopens a decided triage (Desfazer) and logs it", async () => {
        const w = world();
        const view = await triaged(w);
        expect(await decideTriage(w.db, HEAD, view.id, { decision: "reopened" })).toMatchObject({ ok: true });
        await decideTriage(w.db, HEAD, view.id, { decision: "rejected", reason: "duplicado" });
        const reopened = await decideTriage(w.db, HEAD, view.id, { decision: "reopened" });
        expect(reopened).toMatchObject({ ok: true, data: { triage: { decision: null } } });
        if (!reopened.ok) return;
        expect(reopened.data.triage).not.toHaveProperty("reject_reason");
        expect(w.table("card_events").at(-1)).toMatchObject({ action: "triage.reopened", before: { decision: "rejected" } });
    });

    it("editing applies the Head's values instead of the agent's", async () => {
        const w = world();
        const view = await triaged(w);
        const edited = await decideTriage(w.db, HEAD, view.id, {
            decision: "edited",
            kind: "nda",
            counterparty: "Polaris",
            assignee_id: ANALYST2.userId,
        });
        expect(edited).toMatchObject({ ok: true, data: { kind: "nda", counterparty: "Polaris", assignee_name: "Téo" } });
        expect(await decideTriage(w.db, HEAD, view.id, { decision: "edited", kind: "bogus" })).toMatchObject({
            ok: false,
            kind: "validation",
        });
    });

    it("refuses to decide a triage that has not run", async () => {
        const w = world();
        const view = await newRequest(w);
        expect(await decideTriage(w.db, HEAD, view.id, { decision: "accepted" })).toMatchObject({
            ok: false,
            kind: "conflict",
        });
    });

    it("assigns by hand, rejects outsiders and the requester, and can un-assign", async () => {
        const w = world();
        const view = await newRequest(w);
        expect(await assignRequest(w.db, REQUESTER, view.id, { assignee_id: ANALYST.userId })).toMatchObject({
            ok: false,
            kind: "forbidden",
        });
        expect(await assignRequest(w.db, ANALYST, view.id, { assignee_id: STRANGER.userId })).toMatchObject({
            ok: false,
            kind: "validation",
        });
        expect(await assignRequest(w.db, ANALYST, view.id, {})).toMatchObject({ ok: false, kind: "validation" });
        const taken = await assignRequest(w.db, ANALYST, view.id, { assignee_id: ANALYST.userId });
        expect(taken).toMatchObject({ ok: true, data: { assignee_name: "Duda", status: "em_andamento" } });
        // Same assignee again is a no-op.
        await assignRequest(w.db, ANALYST, view.id, { assignee_id: ANALYST.userId });
        expect(w.table("legal_request_notifications").filter((n) => n.template === "request.assigned")).toHaveLength(1);

        const list = await listRequests(w.db, ANALYST);
        expect(list.ok && list.data.counts.meus).toBe(1);
        const released = await assignRequest(w.db, ANALYST, view.id, { assignee_id: null });
        expect(released).toMatchObject({ ok: true, data: { assignee_id: null } });
    });

    it("a question pauses the SLA and an answer resumes it with the paused time added", async () => {
        const w = world();
        const view = await newRequest(w);
        await assignRequest(w.db, ANALYST, view.id, { assignee_id: ANALYST.userId });
        const asked = await postMessage(w.db, ANALYST, view.id, { kind: "question", body: "Tem a minuta deles?" });
        expect(asked).toMatchObject({ ok: true, data: { status: "aguardando_solicitante", sla: "pausado" } });
        expect(w.table("projects")[0].status).toBe("bloqueado");
        expect(w.table("legal_request_notifications").at(-1)).toMatchObject({ template: "request.question" });

        vi.setSystemTime(new Date("2026-10-20T15:00:00Z"));
        const answered = await postMessage(w.db, REQUESTER, view.id, { kind: "question", body: "Sim, segue." });
        expect(answered).toMatchObject({ ok: true, data: { status: "em_andamento" } });
        if (!answered.ok) return;
        expect(answered.data.messages.map((m) => m.kind)).toEqual(["question", "answer"]);
        expect(w.table("legal_requests")[0].paused_seconds).toBe(3 * 3600);
        // Due date pushed by the 3 hours spent waiting.
        expect(answered.data.due_at).toBe("2026-10-21T15:00:00.000Z");
        expect(await postMessage(w.db, REQUESTER, view.id, { body: "  " })).toMatchObject({ ok: false, kind: "validation" });
    });

    it("delivers with a message and the card's documents, mails the requester, and closes", async () => {
        const doc = uuid();
        const w = world();
        const view = await newRequest(w);
        const card = w.table("projects")[0];
        w.table("documents").push({ id: doc, project_id: card.id, current_version_id: "v1" });
        w.table("document_versions").push({ id: "v1", document_id: doc, filename: "NDA Polaris - revisado.docx" });
        expect(await deliverRequest(w.db, ANALYST, view.id, {})).toMatchObject({ ok: false, kind: "validation" });
        expect(await deliverRequest(w.db, REQUESTER, view.id, { message: "x" })).toMatchObject({ ok: false, kind: "forbidden" });
        const delivered = await deliverRequest(w.db, ANALYST, view.id, {
            message: "Pode assinar com as 2 alterações marcadas.",
            document_ids: [doc, uuid()],
        });
        expect(delivered).toMatchObject({ ok: true, data: { status: "entregue", step: "concluido", sla: "encerrado" } });
        const mine = await getRequest(w.db, REQUESTER, view.id);
        expect(mine).toMatchObject({
            ok: true,
            data: { delivery: { message: "Pode assinar com as 2 alterações marcadas.", documents: [{ filename: "NDA Polaris - revisado.docx" }] } },
        });
        expect(w.table("projects")[0]).toMatchObject({ status: "concluido", completed_at: "2026-10-20" });
        expect(await deliverRequest(w.db, ANALYST, view.id, { message: "de novo" })).toMatchObject({ ok: false, kind: "conflict" });
        expect(await postMessage(w.db, REQUESTER, view.id, { body: "obrigada" })).toMatchObject({ ok: false, kind: "conflict" });
    });
});

describe("outside participants", () => {
    it("an invited firm sees and answers that one request until revoked; a viewer only reads", async () => {
        const w = world();
        const view = await newRequest(w);
        const other = await newRequest(w, { counterparty: "Outra" });
        expect(await inviteParticipant(w.db, REQUESTER, view.id, { email: FIRM.userEmail })).toMatchObject({
            ok: false,
            kind: "forbidden",
        });
        expect(await inviteParticipant(w.db, ANALYST, view.id, { email: "nope" })).toMatchObject({ ok: false, kind: "validation" });
        expect(await inviteParticipant(w.db, ANALYST, view.id, { email: "ana@avenia.io" })).toMatchObject({
            ok: false,
            kind: "validation",
        });
        const invited = await inviteParticipant(w.db, ANALYST, view.id, {
            email: FIRM.userEmail,
            label: "Escritório X · Societário",
            days: 30,
        });
        expect(invited).toMatchObject({ ok: true });
        const participant = (invited as { data: RequestTeamView }).data.participants[0];
        expect(participant).toMatchObject({ email: FIRM.userEmail, role: "external", label: "Escritório X · Societário" });
        expect(participant.expires_at).toBe("2026-11-19T12:00:00.000Z");
        expect(w.table("legal_request_notifications").at(-1)).toMatchObject({ template: "request.invited", recipient: FIRM.userEmail });

        expect(await getRequest(w.db, FIRM, view.id)).toMatchObject({ ok: true, data: { audience: "guest" } });
        expect(await getRequest(w.db, FIRM, other.id)).toMatchObject({ ok: false, kind: "not_found" });
        const firmList = await listRequests(w.db, FIRM);
        expect(firmList.ok && firmList.data.items.map((i) => i.code)).toEqual(["LEG-0001"]);
        expect(await postMessage(w.db, FIRM, view.id, { body: "Ok, revisamos a cláusula 7." })).toMatchObject({ ok: true });
        const queue = await listRequests(w.db, HEAD);
        expect(queue.ok && queue.data.items.find((i) => i.id === view.id)?.external).toBe(true);

        // Expired invitations stop working.
        vi.setSystemTime(new Date("2026-12-01T12:00:00Z"));
        expect(await getRequest(w.db, FIRM, view.id)).toMatchObject({ ok: false });
        vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));

        const revoked = await revokeParticipant(w.db, HEAD, view.id, participant.id);
        expect(revoked).toMatchObject({ ok: true });
        expect(await getRequest(w.db, FIRM, view.id)).toMatchObject({ ok: false, kind: "not_found" });
        expect(await revokeParticipant(w.db, HEAD, view.id, uuid())).toMatchObject({ ok: false, kind: "not_found" });

        await inviteParticipant(w.db, ANALYST, view.id, { email: "comercial@avenia.io", role: "viewer" });
        const viewer = { userId: uuid(), userEmail: "comercial@avenia.io" };
        expect(await getRequest(w.db, viewer, view.id)).toMatchObject({ ok: true });
        expect(await postMessage(w.db, viewer, view.id, { body: "oi" })).toMatchObject({ ok: false, kind: "forbidden" });
    });
});

describe("e-mail outbox", () => {
    it("sends pending e-mails once, retries failures, and skips when SMTP is off", async () => {
        const w = world();
        await newRequest(w);
        // SMTP off: skipped.
        delete process.env.SMTP_URL;
        expect(await handleRequestNotify(w.db)).toMatchObject({ sent: 0 });
        expect(w.table("legal_request_notifications")[0].status).toBe("skipped");

        await newRequest(w);
        const sent: { to: string; subject: string }[] = [];
        setMailTransport(async (mail) => {
            sent.push(mail);
        });
        expect(await handleRequestNotify(w.db)).toMatchObject({ sent: 1, failed: 0 });
        expect(sent[0]).toMatchObject({ to: "ana@avenia.io", subject: "LEG-0002 recebido: NDA · Polaris Tecnologia" });
        expect(await handleRequestNotify(w.db)).toMatchObject({ sent: 0 });

        await newRequest(w);
        setMailTransport(async () => {
            throw new Error("smtp 451");
        });
        expect(await handleRequestNotify(w.db)).toMatchObject({ failed: 1 });
        const last = w.table("legal_request_notifications").at(-1)!;
        expect(last).toMatchObject({ status: "pending", attempts: 1, last_error: "smtp 451" });
        last.attempts = 4;
        await handleRequestNotify(w.db);
        expect(last.status).toBe("failed");
    });
});

describe("whoAmI", () => {
    it("tells the frontend which screen to show", async () => {
        const w = world();
        expect(await whoAmI(w.db, HEAD)).toMatchObject({ ok: true, data: { role: "head" } });
        expect(await whoAmI(w.db, ANALYST)).toMatchObject({ ok: true, data: { role: "team" } });
        expect(await whoAmI(w.db, REQUESTER)).toMatchObject({ ok: true, data: { role: "requester", configured: true } });
    });
});
