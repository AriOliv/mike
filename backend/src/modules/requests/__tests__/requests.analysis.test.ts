// The analysis a request unlocks and the alert it may raise: the checklist
// closing starts it for the team, the panel's button says what is missing,
// and a critical risk alerts the Head once per request, inside the app.
// contract-review's functions are stubbed; synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, uuid } from "./memoryDb";

vi.mock("../../../lib/llm", () => ({ completeText: vi.fn() }));
vi.mock("../../user/user.service", () => ({
    getUserModelSettings: vi.fn(async () => ({ tabular_model: "test-model", last_selected_chat_model: null, api_keys: {} })),
}));
const enqueue = vi.hoisted(() => ({ enqueueDbJob: vi.fn(async () => ({ id: "job", deduped: false })) }));
vi.mock("../../../lib/dbq/enqueue", () => enqueue);
const text = vi.hoisted(() => ({ read: vi.fn((_args: Record<string, unknown>): unknown => null) }));
const review = vi.hoisted(() => ({
    startAnalystAnalysis: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true, data: { analysis_id: "an-1", queued: true } })),
    getLatestAnalysis: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true, data: null })),
}));
vi.mock("../../contract-review/contractReview.service", () => review);

import {
    answerIntake,
    createRequest,
    getRequestAnalysis,
    handleAnalysisReady,
    handleRequestAnalysisStart,
    listCriticalAlerts,
    requestAnalysis,
} from "../requests.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const HEAD = { userId: "aaaaaaaa-0000-4000-8000-000000000001", userEmail: "head@avenia.io" };
const ANALYST = { userId: "aaaaaaaa-0000-4000-8000-000000000002", userEmail: "duda@avenia.io" };
const REQUESTER = { userId: "bbbbbbbb-0000-4000-8000-000000000001", userEmail: "ana@avenia.io" };

const ALL: Record<string, unknown> = {
    aprovacao: "Diretoria comercial",
    contraparte: "Nuvem Fictícia S.A.",
    empresa_signataria: "Exemplo Pagamentos Ltda.",
    motivo_condicoes: "Hospedagem; R$ 12 mil por mês.",
    de_acordo: true,
    inicio: "01/11/2026",
    valor_recorrencia: "R$ 12.000,00 mensais",
    confidencial: { value: "sim", detail: "As duas partes" },
};

function world(extra: Record<string, Record<string, unknown>[]> = {}) {
    let number = 0;
    return memoryDb(
        {
            legal_teams: [{ org_id: ORG, sla_days: {}, auto_assign: false, intake_template: [], created_at: "2026-01-01" }],
            org_members: [
                { org_id: ORG, user_id: HEAD.userId, role: "owner", created_at: "2026-01-01" },
                { org_id: ORG, user_id: ANALYST.userId, role: "member", created_at: "2026-01-02" },
            ],
            user_profiles: [
                { user_id: HEAD.userId, email: "head@avenia.io", display_name: "Marina" },
                { user_id: ANALYST.userId, email: "duda@avenia.io", display_name: "Duda" },
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
                        intake: {},
                        intake_completed_at: null,
                        critical_alert_at: null,
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
                read_document_text: (args) => text.read(args),
                create_project_with_memory: (args, tables) => {
                    const row = { id: uuid(), user_id: args.p_user_id, name: args.p_name, org_id: args.p_org_id };
                    (tables.projects ??= []).push(row);
                    return row;
                },
            },
        },
    );
}


async function newRequest(w: ReturnType<typeof world>) {
    const r = await createRequest(w.db, REQUESTER, { kind: "revisao", counterparty: "Nuvem Fictícia S.A.", context: "Contrato de nuvem." });
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.data.request.id;
}

const kinds = () => (enqueue.enqueueDbJob.mock.calls as unknown as [unknown, { kind: string }][]).map((c) => c[1].kind);

beforeEach(() => {
    enqueue.enqueueDbJob.mockClear();
    review.startAnalystAnalysis.mockClear();
    review.getLatestAnalysis.mockClear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("starting the analysis", () => {
    it("is queued once when the checklist closes, not before", async () => {
        const w = world();
        const id = await newRequest(w);
        await answerIntake(w.db, REQUESTER, id, { answers: ALL });
        expect(kinds()).not.toContain("request.analysis_start");
        await answerIntake(w.db, REQUESTER, id, { answers: { dados_pessoais: "não" } });
        expect(enqueue.enqueueDbJob).toHaveBeenCalledWith(
            w.db,
            expect.objectContaining({ kind: "request.analysis_start", payload: { request_id: id }, dedupeKey: `analysis-start:${id}` }),
        );
        await answerIntake(w.db, REQUESTER, id, { answers: { inicio: "15/11/2026" } });
        expect(kinds().filter((k) => k === "request.analysis_start")).toHaveLength(1);
    });

    it("the job runs as the team's owner with the checklist's labels and values", async () => {
        const w = world();
        const id = await newRequest(w);
        await answerIntake(w.db, REQUESTER, id, { answers: { ...ALL, dados_pessoais: "não" } });
        const projectId = w.table("legal_requests")[0].project_id;
        expect(await handleRequestAnalysisStart(w.db, { payload: { request_id: id } })).toEqual({ analysis_id: "an-1", queued: true });
        const [db, caller, project, input] = review.startAnalystAnalysis.mock.calls[0] as [unknown, { userId: string }, string, { request_id: string; intake: { key: string; label: string; value: string }[] }];
        expect(db).toBe(w.db);
        expect(caller.userId).toBe(HEAD.userId);
        expect(project).toBe(projectId);
        expect(input.request_id).toBe(id);
        expect(input.intake).toHaveLength(9);
        expect(input.intake.find((i) => i.key === "confidencial")).toEqual({
            key: "confidencial",
            label: "Há compartilhamento de informação confidencial?",
            value: "Sim. As duas partes",
            source: "requester",
        });
    });

    it("the job waits for a contract, skips a closed request or an open checklist, and retries a real failure", async () => {
        const w = world();
        const id = await newRequest(w);
        expect(await handleRequestAnalysisStart(w.db, { payload: { request_id: id } })).toEqual({ skipped: "intake_open" });
        await answerIntake(w.db, REQUESTER, id, { answers: { ...ALL, dados_pessoais: "não" } });
        review.startAnalystAnalysis.mockResolvedValueOnce({ ok: false, kind: "validation", detail: "Envie o contrato.", code: "no_document" });
        expect(await handleRequestAnalysisStart(w.db, { payload: { request_id: id } })).toEqual({ skipped: "no_document" });
        review.startAnalystAnalysis.mockResolvedValueOnce({ ok: false, kind: "error", error: new Error("db down") });
        await expect(handleRequestAnalysisStart(w.db, { payload: { request_id: id } })).rejects.toThrow("db down");
        w.table("legal_requests")[0].status = "cancelado";
        expect(await handleRequestAnalysisStart(w.db, { payload: { request_id: id } })).toEqual({ skipped: "closed" });
        expect(await handleRequestAnalysisStart(w.db, { payload: { request_id: "x" } })).toEqual({ skipped: "missing" });
    });

    it("from the panel: the team only, and an open checklist says what is missing", async () => {
        const w = world();
        const id = await newRequest(w);
        expect(await requestAnalysis(w.db, REQUESTER, id)).toMatchObject({ ok: false, kind: "forbidden" });
        const open = await requestAnalysis(w.db, ANALYST, id);
        expect(open).toMatchObject({ ok: false, kind: "conflict", code: "intake_incomplete" });
        expect(open.ok ? "" : (open as { detail: string }).detail).toMatch(/^Falta completar o checklist: Quem aprovou a contratação\?; Nome da contraparte;/);
        await answerIntake(w.db, ANALYST, id, { answers: { ...ALL, dados_pessoais: "não" } });
        expect(await requestAnalysis(w.db, ANALYST, id)).toEqual({ ok: true, data: { analysis_id: "an-1", queued: true } });
        expect((review.startAnalystAnalysis.mock.calls.at(-1) as unknown[])[1]).toBe(ANALYST);
    });

    it("the draft analysis is the team's to read, never the requester's", async () => {
        const w = world();
        const id = await newRequest(w);
        expect(await getRequestAnalysis(w.db, REQUESTER, id)).toMatchObject({ ok: false, kind: "forbidden" });
        expect(await getRequestAnalysis(w.db, ANALYST, id)).toEqual({ ok: true, data: null });
        expect(review.getLatestAnalysis).toHaveBeenCalledWith(w.db, ANALYST, w.table("legal_requests")[0].project_id);
    });
});

describe("the critical alert", () => {
    it("alerts the Head once per request, logs it, and lists it while the request is open", async () => {
        const w = world();
        const id = await newRequest(w);
        const payload = { analysis_id: "an-1", project_id: "p", request_id: id, critical: 2, attention: 3 };
        expect(await handleAnalysisReady(w.db, { payload: { ...payload, critical: 0 } })).toEqual({ alerted: false, reason: "no_critical" });
        expect(await handleAnalysisReady(w.db, { payload })).toEqual({ alerted: true, critical: 2 });
        expect(await handleAnalysisReady(w.db, { payload: { ...payload, analysis_id: "an-2" } })).toEqual({
            alerted: false,
            reason: "already_alerted",
        });
        const alerts = w.table("card_events").filter((e) => e.action === "request.critical_alert");
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({ actor_type: "agent", after: { code: "LEG-0001", critical: 2, attention: 3 } });

        expect(await listCriticalAlerts(w.db, HEAD)).toMatchObject({
            ok: true,
            data: { alerts: [{ request_id: id, code: "LEG-0001", critical: 2, alerted_at: "2026-10-22T12:00:00.000Z" }] },
        });
        // Only the Head gets the alert list; it leaves once the request closes.
        expect(await listCriticalAlerts(w.db, ANALYST)).toEqual({ ok: true, data: { alerts: [] } });
        expect(await listCriticalAlerts(w.db, REQUESTER)).toEqual({ ok: true, data: { alerts: [] } });
        w.table("legal_requests")[0].status = "entregue";
        expect(await listCriticalAlerts(w.db, HEAD)).toEqual({ ok: true, data: { alerts: [] } });
    });

    it("never sends anything out of the app", async () => {
        const w = world();
        const id = await newRequest(w);
        const before = w.table("legal_request_notifications").length;
        await handleAnalysisReady(w.db, { payload: { analysis_id: "an-1", request_id: id, critical: 1, attention: 0 } });
        expect(w.table("legal_request_notifications")).toHaveLength(before);
    });
});
