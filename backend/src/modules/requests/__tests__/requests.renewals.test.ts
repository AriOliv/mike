// A contract's end opens its renewal request: the team's switch and lead
// time, and the sweep that opens one request per contract and term, once.
// Synthetic data only.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb } from "./memoryDb";

const enqueue = vi.hoisted(() => ({ enqueueDbJob: vi.fn(async (_db: unknown, _input: unknown) => ({ id: "job", deduped: false })) }));
vi.mock("../../../lib/dbq/enqueue", () => enqueue);
vi.mock("../../user/user.service", () => ({ getUserModelSettings: vi.fn() }));

import {
    enqueueRenewalSweep,
    getRenewalSettings,
    handleRenewalSweep,
    runRenewalSweep,
    setRenewalSettings,
    DEFAULT_RENEWAL_LEAD_DAYS,
    RENEWAL_JOB_KIND,
} from "../requests.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const HEAD = { userId: "aaaaaaaa-0000-4000-8000-000000000001", userEmail: "head@avenia.io" };
const ANALYST = { userId: "aaaaaaaa-0000-4000-8000-000000000002", userEmail: "duda@avenia.io" };
const STRANGER = { userId: "bbbbbbbb-0000-4000-8000-000000000009", userEmail: "x@avenia.io" };
// 2026-11-10 12:00 in São Paulo.
const NOW = new Date("2026-11-10T15:00:00Z");

function world(team: Record<string, unknown> = {}, extra: Record<string, Record<string, unknown>[]> = {}) {
    let number = 0;
    return memoryDb(
        {
            legal_teams: [{ org_id: ORG, sla_days: {}, auto_assign: false, intake_template: [], created_at: "2026-01-01", renewal_enabled: true, renewal_lead_days: 60, ...team }],
            org_members: [
                { org_id: ORG, user_id: HEAD.userId, role: "owner", created_at: "2026-01-01" },
                { org_id: ORG, user_id: ANALYST.userId, role: "member", created_at: "2026-01-02" },
            ],
            user_profiles: [
                { user_id: HEAD.userId, email: "head@avenia.io", display_name: "Marina" },
                { user_id: ANALYST.userId, email: "duda@avenia.io", display_name: "Duda" },
            ],
            projects: [
                { id: "p-soon", name: "Contrato de nuvem", counterparty: "Nuvem Fictícia S.A.", org_id: ORG, archived_at: null },
                { id: "p-far", name: "Contrato de limpeza", counterparty: "Limpa Tudo Ltda.", org_id: ORG, archived_at: null },
                { id: "p-past", name: "Contrato antigo", counterparty: "Velha Ltda.", org_id: ORG, archived_at: null },
                { id: "p-archived", name: "Contrato arquivado", counterparty: null, org_id: ORG, archived_at: "2026-10-01" },
                { id: "p-personal", name: "Contrato pessoal", counterparty: null, org_id: null, archived_at: null },
                { id: "p-foreign", name: "Contrato de outra org", counterparty: null, org_id: OTHER_ORG, archived_at: null },
            ],
            contract_terms: [
                { project_id: "p-soon", term_end: "2027-01-05" },
                { project_id: "p-far", term_end: "2027-06-30" },
                { project_id: "p-past", term_end: "2026-11-01" },
                { project_id: "p-archived", term_end: "2027-01-06" },
                { project_id: "p-personal", term_end: "2027-01-07" },
                { project_id: "p-foreign", term_end: "2027-01-08" },
            ],
            ...extra,
        },
        {
            defaults: {
                legal_requests: () => {
                    number += 1;
                    const now = new Date().toISOString();
                    return {
                        number, status: "novo", paused_at: null, paused_seconds: 0, assignee_id: null, assigned_at: null,
                        summary: null, triage: null, delivery: null, delivered_at: null, source: { channel: "form" },
                        intake: {}, intake_completed_at: null, critical_alert_at: null, idempotency_key: null,
                        created_at: now, updated_at: now,
                    };
                },
                card_events: () => ({ at: new Date().toISOString() }),
                legal_request_notifications: () => ({ status: "pending", attempts: 0, created_at: new Date().toISOString() }),
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

beforeEach(() => enqueue.enqueueDbJob.mockClear());

describe("renewal settings", () => {
    it("start switched off, 60 days ahead, for anyone on the team to read", async () => {
        const w = world({ renewal_enabled: false, renewal_lead_days: 60 });
        expect(await getRenewalSettings(w.db, ANALYST)).toEqual({ ok: true, data: { enabled: false, lead_days: DEFAULT_RENEWAL_LEAD_DAYS } });
    });

    it("are not for people outside the team", async () => {
        expect(await getRenewalSettings(world().db, STRANGER)).toMatchObject({ ok: false, kind: "forbidden" });
    });

    it("say so when there is no legal team yet", async () => {
        const w = memoryDb({});
        expect(await getRenewalSettings(w.db, HEAD)).toMatchObject({ ok: false, code: "legal_team_missing" });
        expect(await setRenewalSettings(w.db, HEAD, { enabled: true })).toMatchObject({ ok: false, code: "legal_team_missing" });
    });

    it("are changed by the head, who turns it on and sets the lead time", async () => {
        const w = world({ renewal_enabled: false });
        const result = await setRenewalSettings(w.db, HEAD, { enabled: true, lead_days: 45 });
        expect(result).toEqual({ ok: true, data: { enabled: true, lead_days: 45 } });
        expect(w.table("legal_teams")[0]).toMatchObject({ renewal_enabled: true, renewal_lead_days: 45 });
    });

    it("are not changed by a plain member", async () => {
        const w = world();
        expect(await setRenewalSettings(w.db, ANALYST, { enabled: false })).toMatchObject({ ok: false, kind: "forbidden", detail: "Só a liderança do Legal pode fazer isso." });
        expect(w.table("legal_teams")[0]).toMatchObject({ renewal_enabled: true });
    });

    it.each([
        [{ enabled: "yes" }, "Diga se o pedido de renovação abre sozinho ou não."],
        [{ lead_days: 0 }, "A antecedência é um número de dias entre 1 e 365."],
        [{ lead_days: 366 }, "A antecedência é um número de dias entre 1 e 365."],
        [{ lead_days: 1.5 }, "A antecedência é um número de dias entre 1 e 365."],
        [{ lead_days: "60" }, "A antecedência é um número de dias entre 1 e 365."],
        [{}, "Nada para mudar."],
    ])("refuse %j, in Portuguese", async (body, detail) => {
        const w = world();
        expect(await setRenewalSettings(w.db, HEAD, body)).toMatchObject({ ok: false, kind: "validation", detail });
    });
});

describe("the renewal sweep", () => {
    it("opens one renewal request for each contract ending inside the window", async () => {
        const w = world();
        const sweep = await runRenewalSweep(w.db, NOW);
        // p-soon (05/01), and the two other team contracts in the window: archived is skipped, personal and foreign too.
        expect(sweep).toEqual({ opened: 1, skipped: 3, failed: 0 });
        const [request] = w.table("legal_requests");
        expect(request).toMatchObject({
            kind: "aditivo",
            title: "Renovação · Nuvem Fictícia S.A.",
            counterparty: "Nuvem Fictícia S.A.",
            needed_by: "2027-01-05",
            requester_email: "head@avenia.io",
            idempotency_key: "renewal:p-soon:2027-01-05",
        });
        expect(String(request.context)).toContain("Aberto automaticamente");
        expect(String(request.context)).toContain("05/01/2027");
        expect(w.table("contract_renewal_requests")).toEqual([
            expect.objectContaining({ project_id: "p-soon", term_end: "2027-01-05", request_id: request.id }),
        ]);
    });

    it("is recorded in the card's history as the system, not as a chat bot or a person", async () => {
        const w = world({}, { legal_requester_areas: [{ user_id: HEAD.userId, area: "financeiro" }] });
        await runRenewalSweep(w.db, NOW);
        const [request] = w.table("legal_requests");
        expect(request.source).toEqual({ channel: "sistema", bot: "renovacao" });
        // The head's remembered area is theirs, not the platform's.
        expect(request.requester_area ?? null).toBeNull();
        expect(w.table("card_events").find((e) => e.action === "request.created")).toMatchObject({
            actor_type: "system",
            actor_id: "system:renovacao",
            on_behalf_of: null,
            source: "cron",
        });
    });

    it("does nothing when the team has not turned it on", async () => {
        const w = world({ renewal_enabled: false });
        expect(await runRenewalSweep(w.db, NOW)).toEqual({ opened: 0, skipped: 0, failed: 0 });
        expect(w.table("legal_requests")).toHaveLength(0);
    });

    it("does nothing without a legal team", async () => {
        expect(await runRenewalSweep(memoryDb({}).db, NOW)).toEqual({ opened: 0, skipped: 0, failed: 0 });
    });

    it("does nothing when nobody on the team can be the one asking", async () => {
        const w = world({}, {});
        w.tables.org_members = [];
        expect(await runRenewalSweep(w.db, NOW)).toEqual({ opened: 0, skipped: 0, failed: 0 });
    });

    it("never opens the same term twice, however many sweeps run", async () => {
        const w = world();
        await runRenewalSweep(w.db, NOW);
        const again = await runRenewalSweep(w.db, NOW);
        expect(again.opened).toBe(0);
        expect(w.table("legal_requests")).toHaveLength(1);
        expect(w.table("contract_renewal_requests")).toHaveLength(1);
    });

    it("skips a term another sweep claimed first, without failing", async () => {
        const w = world({}, { contract_renewal_requests: [] });
        // Another replica claims it between our read and our insert.
        const real = w.db.from.bind(w.db);
        let raced = false;
        (w.db as unknown as { from: (t: string) => unknown }).from = (name: string) => {
            const builder = real(name) as unknown as Record<string, (...a: unknown[]) => unknown>;
            if (name === "contract_renewal_requests" && !raced) {
                const insert = builder.insert;
                builder.insert = (row: unknown) => {
                    raced = true;
                    w.table("contract_renewal_requests").push({ ...(row as object) });
                    return insert(row);
                };
            }
            return builder;
        };
        // The 3 contracts outside the team's queue, plus the one claimed elsewhere; none failed.
        expect(await runRenewalSweep(w.db, NOW)).toEqual({ opened: 0, skipped: 4, failed: 0 });
        expect(w.table("legal_requests")).toHaveLength(0);
    });

    it("opens a new request when a renewed contract gets a later end", async () => {
        const w = world();
        await runRenewalSweep(w.db, NOW);
        w.table("contract_terms").find((t) => t.project_id === "p-soon")!.term_end = "2028-01-05";
        // Eleven months later the new end is inside the window.
        const later = new Date("2027-11-10T15:00:00Z");
        const sweep = await runRenewalSweep(w.db, later);
        expect(sweep.opened).toBe(1);
        expect(w.table("legal_requests").map((r) => r.idempotency_key)).toEqual([
            "renewal:p-soon:2027-01-05",
            "renewal:p-soon:2028-01-05",
        ]);
    });

    it("respects the team's own lead time", async () => {
        const wide = world({ renewal_lead_days: 365 });
        expect((await runRenewalSweep(wide.db, NOW)).opened).toBe(2);
        const narrow = world({ renewal_lead_days: 30 });
        expect((await runRenewalSweep(narrow.db, NOW)).opened).toBe(0);
    });

    it("leaves out contracts that already ended", async () => {
        const w = world({ renewal_lead_days: 365 });
        await runRenewalSweep(w.db, NOW);
        expect(w.table("legal_requests").map((r) => r.idempotency_key)).not.toContain("renewal:p-past:2026-11-01");
    });

    it("releases the claim when the request cannot be made, so the next sweep tries again", async () => {
        const w = world();
        // No team members to be the requester's profile: the owner has no e-mail on file.
        w.tables.user_profiles = [{ user_id: HEAD.userId, email: null, display_name: "Marina" }];
        expect(await runRenewalSweep(w.db, NOW)).toEqual({ opened: 0, skipped: 0, failed: 0 });
        expect(w.table("contract_renewal_requests")).toHaveLength(0);
    });

    it("counts a request that fails as failed and frees the term", async () => {
        const w = world();
        const db = w.db as unknown as { rpc: (name: string, args: Record<string, unknown>) => Promise<unknown> };
        db.rpc = async () => ({ data: null, error: { message: "down" } });
        const sweep = await runRenewalSweep(w.db, NOW);
        expect(sweep).toEqual({ opened: 0, skipped: 3, failed: 1 });
        expect(w.table("contract_renewal_requests")).toHaveLength(0);
    });

    it("counts a claim that fails for another reason as failed", async () => {
        const w = world();
        const real = w.db.from.bind(w.db);
        (w.db as unknown as { from: (t: string) => unknown }).from = (name: string) => {
            const builder = real(name) as unknown as Record<string, (...a: unknown[]) => unknown>;
            if (name === "contract_renewal_requests") {
                builder.insert = () => Promise.resolve({ data: null, error: { code: "XX000", message: "boom" } });
            }
            return builder;
        };
        expect((await runRenewalSweep(w.db, NOW)).failed).toBe(1);
        expect(w.table("legal_requests")).toHaveLength(0);
    });
});

describe("the renewal job", () => {
    it("is queued once at a time", async () => {
        await enqueueRenewalSweep(world().db);
        expect(enqueue.enqueueDbJob).toHaveBeenCalledWith(expect.anything(), { kind: RENEWAL_JOB_KIND, payload: {}, dedupeKey: "renewal-sweep" });
    });

    it("does not fail the worker when it cannot be queued", async () => {
        enqueue.enqueueDbJob.mockRejectedValueOnce(new Error("down"));
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        await expect(enqueueRenewalSweep(world().db)).resolves.toBeUndefined();
        quiet.mockRestore();
    });

    it("reports what the sweep did", async () => {
        const result = await handleRenewalSweep(world({ renewal_enabled: false }).db);
        expect(result).toEqual({ opened: 0, skipped: 0, failed: 0 });
    });
});
