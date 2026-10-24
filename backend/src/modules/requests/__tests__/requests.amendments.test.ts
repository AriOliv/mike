// An amendment tied to its contract (U-05) now acts on it: delivering one that
// sets a term moves the parent's end of term and notice deadline, the card says
// so, and the renewal sweep does not open a second request for a contract that
// already has an amendment under way. Synthetic data only.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb } from "./memoryDb";

const enqueue = vi.hoisted(() => ({ enqueueDbJob: vi.fn(async (_db: unknown, _input: unknown) => ({ id: "job", deduped: false })) }));
vi.mock("../../../lib/dbq/enqueue", () => enqueue);
vi.mock("../../user/user.service", () => ({ getUserModelSettings: vi.fn() }));

import { deliverRequest, listAmendmentsOf, runRenewalSweep } from "../requests.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const HEAD = { userId: "aaaaaaaa-0000-4000-8000-000000000001", userEmail: "head@avenia.io" };
const PARENT = "cccccccc-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-10T15:00:00Z");

type Rows = Record<string, Record<string, unknown>[]>;

function world(extra: Rows = {}, termsRow: Record<string, unknown> | null = { project_id: PARENT, user_id: "owner-1", auto_renewal: true, term_end: "2027-01-05", notice_days: 30, notice_deadline: "2026-12-06", sources: { notice_days: "cláusula 9" } }) {
    let number = 0;
    return memoryDb(
        {
            legal_teams: [{ org_id: ORG, sla_days: {}, auto_assign: false, intake_template: [], created_at: "2026-01-01", renewal_enabled: true, renewal_lead_days: 60 }],
            org_members: [{ org_id: ORG, user_id: HEAD.userId, role: "owner", created_at: "2026-01-01" }],
            user_profiles: [{ user_id: HEAD.userId, email: "head@avenia.io", display_name: "Marina" }],
            projects: [
                { id: PARENT, user_id: "owner-1", name: "Contrato de nuvem", counterparty: "Nuvem Fictícia S.A.", org_id: ORG, archived_at: null },
                { id: "p-foreign", user_id: "x", name: "Contrato de outra org", counterparty: null, org_id: OTHER_ORG, archived_at: null },
            ],
            contract_terms: termsRow ? [termsRow] : [],
            obligations: [
                { id: "ob-vig", project_id: PARENT, origin: "renewal", kind: "vigencia", due_date: "2027-01-05", title: "Fim da vigência (renova automaticamente)", status: "aberto", owner_email: "duda@avenia.io" },
                { id: "ob-avi", project_id: PARENT, origin: "renewal", kind: "aviso_previo", due_date: "2026-12-06", title: "Prazo limite para avisar não renovação (30 dias de aviso prévio)", status: "aberto", owner_email: null },
                { id: "ob-ren", project_id: PARENT, origin: "renewal", kind: "renovacao", due_date: "2026-09-07", title: "Decidir sobre renovação — janela de aviso fecha em breve", status: "aberto", owner_email: null },
            ],
            ...extra,
        },
        {
            defaults: {
                legal_requests: () => {
                    number += 1;
                    const now = new Date().toISOString();
                    return {
                        number, status: "em_andamento", paused_at: null, paused_seconds: 0, assignee_id: null, assigned_at: null,
                        summary: null, triage: null, delivery: null, delivered_at: null, source: { channel: "form" },
                        intake: {}, intake_completed_at: null, critical_alert_at: null, idempotency_key: null, created_at: now, updated_at: now,
                    };
                },
                card_events: () => ({ at: new Date().toISOString() }),
                legal_request_notifications: () => ({ status: "pending", attempts: 0, created_at: new Date().toISOString() }),
                legal_request_stages: () => ({ left_at: null }),
            },
            rpc: {
                create_project_with_memory: (args, tables) => {
                    const row = { id: `new-${(tables.projects ?? []).length}`, user_id: args.p_user_id, name: args.p_name, org_id: args.p_org_id };
                    (tables.projects ??= []).push(row);
                    return row;
                },
            },
        },
    );
}

const amendment = (over: Record<string, unknown> = {}) => ({
    id: "dddddddd-0000-4000-8000-000000000001",
    org_id: ORG,
    kind: "aditivo",
    title: "Aditivo de prazo",
    requester_id: "r1",
    requester_email: "ana@avenia.io",
    requester_name: "Ana",
    counterparty: "Nuvem Fictícia S.A.",
    context: "Prorrogar a vigência.",
    urgency: "normal",
    needed_by: null,
    due_at: "2026-11-20T12:00:00Z",
    delivered_at: null,
    number: 1,
    created_at: "2026-11-01T12:00:00Z",
    updated_at: "2026-11-01T12:00:00Z",
    project_id: null,
    parent_project_id: PARENT,
    term_start: "2027-01-06",
    term_months: 12,
    ...over,
});

const deliver = (w: ReturnType<typeof world>) => deliverRequest(w.db, HEAD, "dddddddd-0000-4000-8000-000000000001", { message: "Aditivo assinado." });
const obligation = (w: ReturnType<typeof world>, kind: string) => w.table("obligations").find((o) => o.project_id === PARENT && o.kind === kind)!;

beforeEach(() => enqueue.enqueueDbJob.mockClear());

describe("delivering an amendment that sets a term", () => {
    it("moves the parent's end of term and notice deadline, keeping the notice period and who owns the deadline", async () => {
        const w = world({ legal_requests: [amendment()] });
        const result = await deliver(w);
        expect(result.ok).toBe(true);
        const terms = w.table("contract_terms").find((t) => t.project_id === PARENT)!;
        // 2027-01-06 + 12 months − 1 day = 2028-01-05; 30 days of notice before it.
        expect(terms).toMatchObject({ term_end: "2028-01-05", notice_days: 30, notice_deadline: "2027-12-06", auto_renewal: true });
        expect((terms.sources as Record<string, string>).term_end).toMatch(/^Aditivo LEG-\d{4}$/);
        expect((terms.sources as Record<string, string>).notice_days).toBe("cláusula 9");
        expect(obligation(w, "vigencia")).toMatchObject({ id: "ob-vig", due_date: "2028-01-05", owner_email: "duda@avenia.io" });
        expect(obligation(w, "aviso_previo")).toMatchObject({ id: "ob-avi", due_date: "2027-12-06" });
        expect(obligation(w, "renovacao")).toMatchObject({ id: "ob-ren", due_date: "2027-09-07" });
    });

    it("says on the contract's card what changed and which amendment did it", async () => {
        const w = world({ legal_requests: [amendment()] });
        await deliver(w);
        const event = w.table("card_events").find((e) => e.project_id === PARENT && e.action === "terms.amended")!;
        expect(event).toMatchObject({ field: "term_end", before: "2027-01-05", actor_type: "user", actor_id: HEAD.userId, actor_name: "Marina" });
        expect(event.after).toMatchObject({ term_end: "2028-01-05", notice_deadline: "2027-12-06" });
    });

    it("reopens a deadline the team had closed for the old date", async () => {
        const w = world({ legal_requests: [amendment()] });
        Object.assign(obligation(w, "vigencia"), { status: "feito", done: true });
        await deliver(w);
        expect(obligation(w, "vigencia")).toMatchObject({ due_date: "2028-01-05", status: "aberto", done: false });
    });

    it("does nothing when the term already ends that day (a retry, or an amendment that repeats it)", async () => {
        const w = world({ legal_requests: [amendment({ term_start: "2026-01-06", term_months: 12 })] }, { project_id: PARENT, user_id: "owner-1", term_end: "2027-01-05", notice_days: 30, notice_deadline: "2026-12-06", sources: {} });
        await deliver(w);
        expect(w.table("card_events").some((e) => e.action === "terms.amended")).toBe(false);
        expect(obligation(w, "vigencia").due_date).toBe("2027-01-05");
    });

    it("leaves the contract alone for an amendment with no link, no start, no months, or another kind", async () => {
        for (const over of [{ parent_project_id: null }, { term_start: null }, { term_months: null }, { kind: "parecer" }]) {
            const w = world({ legal_requests: [amendment(over)] });
            const result = await deliver(w);
            expect(result.ok).toBe(true);
            expect(w.table("contract_terms")[0]).toMatchObject({ term_end: "2027-01-05" });
            expect(w.table("card_events").some((e) => e.action === "terms.amended")).toBe(false);
        }
    });

    it("never touches a contract of another organization or an archived one", async () => {
        const foreign = world({ legal_requests: [amendment({ parent_project_id: "p-foreign" })] });
        foreign.table("contract_terms").push({ project_id: "p-foreign", user_id: "x", term_end: "2027-01-05", notice_days: 30 });
        await deliver(foreign);
        expect(foreign.table("contract_terms").find((t) => t.project_id === "p-foreign")).toMatchObject({ term_end: "2027-01-05" });

        const archived = world({ legal_requests: [amendment()] });
        Object.assign(archived.table("projects").find((p) => p.id === PARENT)!, { archived_at: "2026-10-01" });
        await deliver(archived);
        expect(archived.table("contract_terms")[0]).toMatchObject({ term_end: "2027-01-05" });
    });

    it("sets the term of a contract that had none read yet, with no notice deadline to invent", async () => {
        const w = world({ legal_requests: [amendment()] }, null);
        w.table("obligations").length = 0;
        await deliver(w);
        expect(w.table("contract_terms")[0]).toMatchObject({ project_id: PARENT, user_id: "owner-1", term_end: "2028-01-05", notice_days: null, notice_deadline: null });
        expect(w.table("obligations").map((o) => o.kind)).toEqual(["vigencia"]);
    });

    it("still delivers when applying the term fails", async () => {
        const w = world({ legal_requests: [amendment()] });
        const failing = memoryDb({ ...Object.fromEntries(Object.entries(w.tables)) }, { fail: (table, op) => (table === "contract_terms" && op !== "select" ? { message: "boom" } : null) });
        const result = await deliverRequest(failing.db, HEAD, "dddddddd-0000-4000-8000-000000000001", { message: "Aditivo assinado." });
        expect(result.ok).toBe(true);
        expect(failing.table("legal_requests")[0]).toMatchObject({ status: "entregue" });
    });
});

describe("the renewal sweep and an amendment already under way", () => {
    const sweep = () => ({ now: NOW });
    const dueWorld = (requests: Record<string, unknown>[]) => {
        const w = world({ legal_requests: requests }, { project_id: PARENT, user_id: "owner-1", term_end: "2027-01-05", notice_days: 30, notice_deadline: "2026-12-06", sources: {} });
        return w;
    };

    it("opens no request for a contract that has an open amendment, and claims nothing", async () => {
        const w = dueWorld([amendment({ status: "em_andamento" })]);
        const result = await runRenewalSweep(w.db, sweep().now);
        expect(result).toMatchObject({ opened: 0, skipped: 1, failed: 0 });
        expect(w.table("contract_renewal_requests")).toHaveLength(0);
        expect(w.table("legal_requests")).toHaveLength(1);
    });

    it.each(["novo", "em_triagem", "em_andamento", "aguardando_solicitante"])("counts %s as under way", async (status) => {
        const w = dueWorld([amendment({ status })]);
        expect(await runRenewalSweep(w.db, sweep().now)).toMatchObject({ opened: 0, skipped: 1 });
    });

    it.each(["entregue", "cancelado"])("opens the renewal when the amendment is %s", async (status) => {
        const w = dueWorld([amendment({ status })]);
        expect(await runRenewalSweep(w.db, sweep().now)).toMatchObject({ opened: 1, skipped: 0 });
    });

    it("is not stopped by an amendment tied to another contract, or by one of another kind", async () => {
        const w = dueWorld([
            amendment({ id: "dddddddd-0000-4000-8000-000000000002", parent_project_id: "p-foreign", status: "em_andamento" }),
            amendment({ id: "dddddddd-0000-4000-8000-000000000003", kind: "parecer", status: "em_andamento" }),
        ]);
        expect(await runRenewalSweep(w.db, sweep().now)).toMatchObject({ opened: 1, skipped: 0 });
    });

    it("opens it on a later sweep once the amendment is delivered", async () => {
        const w = dueWorld([amendment({ status: "em_andamento" })]);
        expect(await runRenewalSweep(w.db, sweep().now)).toMatchObject({ opened: 0, skipped: 1 });
        Object.assign(w.table("legal_requests")[0], { status: "cancelado" });
        expect(await runRenewalSweep(w.db, sweep().now)).toMatchObject({ opened: 1, skipped: 0 });
    });
});

describe("amendments listed for the contract", () => {
    it("lists the amendments tied to it, newest first, with code, status and the term each sets", async () => {
        const w = world({
            legal_requests: [
                amendment({ id: "a1", number: 7, status: "entregue", delivered_at: "2026-11-01T00:00:00Z" }),
                amendment({ id: "a2", number: 9, status: "em_andamento", term_start: null, title: "Aditivo de valor" }),
                amendment({ id: "a3", number: 8, parent_project_id: "p-foreign", title: "De outro contrato" }),
                amendment({ id: "a4", number: 10, kind: "parecer", title: "Parecer" }),
            ],
        });
        const result = await listAmendmentsOf(w.db, PARENT);
        expect(result.ok && result.data).toEqual([
            { id: "a2", code: "LEG-0009", title: "Aditivo de valor", status: "em_andamento", delivered_at: null, term_end: null },
            { id: "a1", code: "LEG-0007", title: "Aditivo de prazo", status: "entregue", delivered_at: "2026-11-01T00:00:00Z", term_end: "2028-01-05" },
        ]);
    });

    it("answers with an empty list when nothing is tied to the contract", async () => {
        expect(await listAmendmentsOf(world().db, PARENT)).toEqual({ ok: true, data: [] });
    });
});
