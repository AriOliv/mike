// Assignment rules (L-33): validating what the Head sends, matching the
// first rule, reading the contract value, and applying it without ever
// undoing a person's choice. No model anywhere. Synthetic data only.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, uuid } from "./memoryDb";

const enqueue = vi.hoisted(() => ({
    enqueueDbJob: vi.fn(async (_db: unknown, _job: { kind: string }) => ({ id: "job", deduped: false })),
}));
vi.mock("../../../lib/dbq/enqueue", () => enqueue);

import {
    applyAssignmentRules,
    assignRequest,
    createRequest,
    getAssignmentRules,
    matchRule,
    parseAssignmentRules,
    parseMoney,
    setAssignmentRules,
    valueFromIntake,
    type AssignmentRule,
} from "../requests.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const HEAD = { userId: "aaaaaaaa-0000-4000-8000-000000000001", userEmail: "head@avenia.io" };
const DUDA = { userId: "aaaaaaaa-0000-4000-8000-000000000002", userEmail: "duda@avenia.io" };
const BETO = { userId: "aaaaaaaa-0000-4000-8000-000000000003", userEmail: "beto@avenia.io" };
const REQUESTER = { userId: "bbbbbbbb-0000-4000-8000-000000000001", userEmail: "ana@avenia.io" };
const MEMBERS = new Set([HEAD.userId, DUDA.userId, BETO.userId]);

function world(rules: AssignmentRule[] = []) {
    let number = 0;
    return memoryDb(
        {
            legal_teams: [{ org_id: ORG, sla_days: {}, auto_assign: false, intake_template: [], assignment_rules: rules, created_at: "2026-01-01" }],
            org_members: [
                { org_id: ORG, user_id: HEAD.userId, role: "owner", created_at: "2026-01-01" },
                { org_id: ORG, user_id: DUDA.userId, role: "member", created_at: "2026-01-02" },
                { org_id: ORG, user_id: BETO.userId, role: "member", created_at: "2026-01-03" },
            ],
            user_profiles: [
                { user_id: HEAD.userId, email: "head@avenia.io", display_name: "Marina" },
                { user_id: DUDA.userId, email: "duda@avenia.io", display_name: "Duda" },
                { user_id: BETO.userId, email: "beto@avenia.io", display_name: "Beto" },
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

const rule = (when: AssignmentRule["when"], who = DUDA.userId, note?: string): AssignmentRule => ({ when, assign_to: who, ...(note ? { note } : {}) });

beforeEach(() => enqueue.enqueueDbJob.mockClear());

describe("reading the contract value", () => {
    it("reads one amount in reais, with Brazilian separators and scale words", () => {
        expect(parseMoney("R$ 12.000,00 mensais")).toBe(12000);
        expect(parseMoney("12 mil por mês")).toBe(12000);
        expect(parseMoney("R$ 1,5 mi")).toBe(1_500_000);
        expect(parseMoney("1.250.000")).toBe(1_250_000);
        expect(parseMoney("R$ 800")).toBe(800);
        expect(parseMoney("R$ 800,00 e R$ 800,00")).toBe(800);
    });

    it("never guesses: two amounts, another currency or no number is unknown", () => {
        expect(parseMoney("R$ 5.000 por mês, 12 meses")).toBeNull();
        expect(parseMoney("R$ 5.000 mensais ou R$ 60.000 anuais")).toBeNull();
        expect(parseMoney("US$ 10.000")).toBeNull();
        expect(parseMoney("10.000 USDC")).toBeNull();
        expect(parseMoney("a combinar")).toBeNull();
        expect(parseMoney("")).toBeNull();
    });

    it("takes the value from the checklist answer, and from nothing else", () => {
        expect(valueFromIntake({ valor_recorrencia: { value: "R$ 3.000,00 mensais" } })).toBe(3000);
        expect(valueFromIntake({ valor_recorrencia: { value: "a combinar" } })).toBeNull();
        expect(valueFromIntake({ contraparte: { value: "R$ 10" } })).toBeNull();
        expect(valueFromIntake({})).toBeNull();
        expect(valueFromIntake(null)).toBeNull();
    });
});

describe("checking the rules the Head sends", () => {
    it("accepts a list, an empty list and nothing at all", () => {
        const ok = parseAssignmentRules(
            [{ when: { area: "comercial", kind: "nda", value_min: 0, value_max: 5000 }, assign_to: DUDA.userId, note: "  NDAs do comercial  " }],
            MEMBERS,
        );
        expect(ok).toEqual({
            ok: true,
            rules: [{ when: { area: "Comercial", kind: "nda", value_min: 0, value_max: 5000 }, assign_to: DUDA.userId, note: "NDAs do comercial" }],
        });
        expect(parseAssignmentRules([], MEMBERS)).toEqual({ ok: true, rules: [] });
        expect(parseAssignmentRules(null, MEMBERS)).toEqual({ ok: true, rules: [] });
        expect(parseAssignmentRules(undefined, MEMBERS)).toEqual({ ok: true, rules: [] });
    });

    it.each([
        ["not a list", { a: 1 }, /precisam ser uma lista/],
        ["too many", Array.from({ length: 31 }, () => rule({ kind: "nda" })), /no máximo 30/],
        ["an item that is not an object", ["x"], /Regra 1: formato inválido/],
        ["no condition block", [{ assign_to: DUDA.userId }], /Regra 1: diga quando/],
        ["an empty condition", [{ when: {}, assign_to: DUDA.userId }], /ao menos uma condição/],
        ["an empty area", [{ when: { area: "  " }, assign_to: DUDA.userId }], /área está vazia/],
        ["an unknown kind", [{ when: { kind: "xyz" }, assign_to: DUDA.userId }], /tipo de pedido não existe/],
        ["a negative value", [{ when: { value_min: -1 }, assign_to: DUDA.userId }], /sem negativo/],
        ["a value that is text", [{ when: { value_max: "10" }, assign_to: DUDA.userId }], /número em reais/],
        ["min above max", [{ when: { value_min: 10, value_max: 5 }, assign_to: DUDA.userId }], /mínimo é maior/],
        ["no one to assign", [{ when: { kind: "nda" } }], /escolha quem assume/],
        ["a person who is not an id", [{ when: { kind: "nda" }, assign_to: "duda" }], /escolha quem assume/],
        ["someone outside the team", [{ when: { kind: "nda" }, assign_to: "cccccccc-0000-4000-8000-000000000009" }], /não é do time/],
        ["a note that is not text", [{ when: { kind: "nda" }, assign_to: DUDA.userId, note: 5 }], /observação precisa ser texto/],
    ])("refuses %s, in Portuguese", (_name, input, message) => {
        const r = parseAssignmentRules(input, MEMBERS);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.detail).toMatch(message);
    });

    it("drops a blank note instead of storing it", () => {
        const r = parseAssignmentRules([{ when: { kind: "nda" }, assign_to: DUDA.userId, note: "   " }], MEMBERS);
        expect(r).toEqual({ ok: true, rules: [{ when: { kind: "nda" }, assign_to: DUDA.userId }] });
    });
});

describe("matching the first rule", () => {
    const rules = [
        rule({ kind: "nda" }, DUDA.userId),
        rule({ area: "Comercial", value_min: 50_000 }, HEAD.userId),
        rule({ area: "Comercial" }, BETO.userId),
    ];

    it("takes the first that fits, in order, and says which", () => {
        expect(matchRule(rules, { area: "Comercial", kind: "nda", value: null })?.index).toBe(0);
        expect(matchRule(rules, { area: "comercial", kind: "revisao", value: 80_000 })?.rule.assign_to).toBe(HEAD.userId);
        expect(matchRule(rules, { area: "Comercial", kind: "revisao", value: 1_000 })?.rule.assign_to).toBe(BETO.userId);
    });

    it("does not let a value rule fire when the value is unknown, and falls to the next", () => {
        expect(matchRule(rules, { area: "Comercial", kind: "revisao", value: null })?.index).toBe(2);
    });

    it("honours both ends of a value range, inclusive", () => {
        const band = [rule({ value_min: 1000, value_max: 2000 })];
        expect(matchRule(band, { area: null, kind: "revisao", value: 999 })).toBeNull();
        expect(matchRule(band, { area: null, kind: "revisao", value: 1000 })).not.toBeNull();
        expect(matchRule(band, { area: null, kind: "revisao", value: 2000 })).not.toBeNull();
        expect(matchRule(band, { area: null, kind: "revisao", value: 2001 })).toBeNull();
        expect(matchRule([rule({ value_max: 10 })], { area: null, kind: "x", value: 11 })).toBeNull();
    });

    it("returns nothing when no rule fits, or there are none", () => {
        expect(matchRule(rules, { area: "Produto", kind: "revisao", value: 10 })).toBeNull();
        expect(matchRule(rules, { area: null, kind: "revisao", value: 10 })).toBeNull();
        expect(matchRule([], { area: "Comercial", kind: "nda", value: null })).toBeNull();
    });
});

describe("who may read and change the rules", () => {
    it("lets the team read them and only the Head change them", async () => {
        const w = world([rule({ kind: "nda" })]);
        const read = await getAssignmentRules(w.db, DUDA);
        expect(read.ok && read.data.rules).toHaveLength(1);

        const denied = await setAssignmentRules(w.db, DUDA, { rules: [] });
        expect(denied).toMatchObject({ ok: false, kind: "forbidden", detail: "Só a liderança do Legal pode fazer isso." });
        const outsider = await getAssignmentRules(w.db, REQUESTER);
        expect(outsider).toMatchObject({ ok: false, kind: "forbidden", detail: "Só o time do Legal pode fazer isso." });
    });

    it("saves what the Head sends, turns them off with an empty list, and explains a bad one", async () => {
        const w = world();
        const saved = await setAssignmentRules(w.db, HEAD, { rules: [{ when: { kind: "nda" }, assign_to: DUDA.userId }] });
        expect(saved.ok && saved.data.rules).toEqual([{ when: { kind: "nda" }, assign_to: DUDA.userId }]);
        expect(w.table("legal_teams")[0].assignment_rules).toEqual([{ when: { kind: "nda" }, assign_to: DUDA.userId }]);

        const bad = await setAssignmentRules(w.db, HEAD, { rules: [{ when: {}, assign_to: DUDA.userId }] });
        expect(bad).toMatchObject({ ok: false, kind: "validation" });
        expect(w.table("legal_teams")[0].assignment_rules).toHaveLength(1);

        const off = await setAssignmentRules(w.db, HEAD, { rules: [] });
        expect(off.ok && off.data.rules).toEqual([]);
        expect(w.table("legal_teams")[0].assignment_rules).toEqual([]);
    });

    it("says so when the organization has no legal team", async () => {
        const w = memoryDb({});
        expect(await getAssignmentRules(w.db, HEAD)).toMatchObject({ ok: false });
        expect(await setAssignmentRules(w.db, HEAD, { rules: [] })).toMatchObject({ ok: false });
    });
});

describe("applying the rules to a request", () => {
    async function open(w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) {
        const r = await createRequest(w.db, REQUESTER, { kind: "nda", counterparty: "Nuvem Fictícia S.A.", context: "NDA.", ...extra });
        if (!r.ok) throw new Error(JSON.stringify(r));
        return w.table("legal_requests").find((x) => x.id === r.data.request.id)!;
    }

    it("is born assigned when a rule fits: owner, card, event and the requester's notice", async () => {
        const w = world([rule({ kind: "nda" }, DUDA.userId, "NDAs vão para a Duda")]);
        const row = await open(w);
        expect(row).toMatchObject({ assignee_id: DUDA.userId, assigned_by: "rule", status: "em_andamento" });

        const card = w.table("projects").find((p) => p.id === row.project_id)!;
        expect(card).toMatchObject({ assignee_email: "duda@avenia.io", lane: "triagem", status: "em_andamento" });

        const event = w.table("card_events").find((e) => e.action === "assignee.changed")!;
        expect(event).toMatchObject({ actor_type: "agent", actor_name: "Regra de atribuição" });
        expect(event.after).toMatchObject({ name: "Duda", reason: "regra 1: NDAs vão para a Duda" });

        expect(w.table("legal_request_notifications").some((n) => n.template === "request.assigned")).toBe(true);
        // the triage still runs: the rule only names the owner
        expect(enqueue.enqueueDbJob.mock.calls.some(([, job]) => job.kind.includes("triage"))).toBe(true);
    });

    it("leaves the request for the triage when no rule fits, or there are no rules", async () => {
        const none = await open(world());
        expect(none).toMatchObject({ assignee_id: null, assigned_by: null });
        const other = await open(world([rule({ kind: "parecer" })]), {});
        expect(other.assignee_id).toBeNull();
    });

    it("never undoes a person's choice, even when a rule fits", async () => {
        const w = world([rule({ kind: "nda" }, DUDA.userId)]);
        const row = await open(w, { kind: "revisao" });
        expect(row.assignee_id).toBeNull();
        const assigned = await assignRequest(w.db, HEAD, row.id as string, { assignee_id: BETO.userId });
        expect(assigned.ok).toBe(true);
        expect(w.table("legal_requests").find((x) => x.id === row.id)).toMatchObject({ assignee_id: BETO.userId, assigned_by: "person" });

        w.table("legal_teams")[0].assignment_rules = [rule({ kind: "revisao" }, DUDA.userId)];
        const result = await applyAssignmentRules(w.db, w.table("legal_requests").find((x) => x.id === row.id) as never);
        expect(result.assigned).toBe(false);
        expect(w.table("legal_requests").find((x) => x.id === row.id)?.assignee_id).toBe(BETO.userId);
    });

    it("lets the checklist's value move a request a rule owned to the rule that now fits", async () => {
        const rules = [rule({ value_min: 50_000 }, HEAD.userId), rule({ kind: "nda" }, DUDA.userId)];
        const w = world(rules);
        const row = await open(w);
        expect(row).toMatchObject({ assignee_id: DUDA.userId, assigned_by: "rule" });

        row.intake = { valor_recorrencia: { value: "R$ 80.000,00 mensais", source: "requester", confirmed: true } };
        const again = await applyAssignmentRules(w.db, { ...row } as never);
        expect(again.assigned).toBe(true);
        expect(w.table("legal_requests").find((x) => x.id === row.id)).toMatchObject({ assignee_id: HEAD.userId, assigned_by: "rule" });
        const events = w.table("card_events").filter((e) => e.action === "assignee.changed");
        expect(events).toHaveLength(2);
        expect(events[1].before).toEqual({ id: DUDA.userId });
    });

    it("does nothing when the rule names who already has it, or the request is closed", async () => {
        const w = world([rule({ kind: "nda" }, DUDA.userId)]);
        const row = await open(w);
        expect((await applyAssignmentRules(w.db, { ...row } as never)).assigned).toBe(false);

        const fresh = await open(world([rule({ kind: "nda" }, DUDA.userId)]));
        expect((await applyAssignmentRules(world().db, { ...fresh, assignee_id: null, assigned_by: null, status: "entregue" } as never)).assigned).toBe(false);
    });

    it("skips a rule whose person left the team, and never fails the request", async () => {
        const w = world([rule({ kind: "nda" }, "cccccccc-0000-4000-8000-000000000009")]);
        const row = await open(w);
        expect(row).toMatchObject({ assignee_id: null, assigned_by: null });

        const broken = memoryDb({}, { fail: () => ({ message: "boom" }) });
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        expect((await applyAssignmentRules(broken.db, row as never)).assigned).toBe(false);
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });
});

describe("when the database fails", () => {
    /** The seeded world, where the n-th select of `table` (0 = the first) or any `op` on it fails. */
    function failingWorld(table: string, when: { op?: string; nthSelect?: number }) {
        const w = world([rule({ kind: "nda" })]);
        let selects = 0;
        return memoryDb(Object.fromEntries(["legal_teams", "org_members", "user_profiles"].map((t) => [t, w.table(t)])), {
            fail: (t, op) => {
                if (t !== table) return null;
                if (when.op) return op === when.op ? { message: "boom" } : null;
                if (op !== "select") return null;
                selects += 1;
                return selects === (when.nthSelect ?? 1) ? { message: "boom" } : null;
            },
        });
    }
    const internal = { ok: false, kind: "error" };

    it("answers with an internal failure instead of throwing", async () => {
        expect(await getAssignmentRules(failingWorld("legal_teams", { nthSelect: 1 }).db, HEAD)).toMatchObject(internal);
        expect(await getAssignmentRules(failingWorld("legal_teams", { nthSelect: 2 }).db, HEAD)).toMatchObject(internal);
        expect(await setAssignmentRules(failingWorld("legal_teams", { nthSelect: 1 }).db, HEAD, { rules: [] })).toMatchObject(internal);
        expect(await setAssignmentRules(failingWorld("user_profiles", { nthSelect: 1 }).db, HEAD, { rules: [] })).toMatchObject(internal);
        expect(await setAssignmentRules(failingWorld("legal_teams", { op: "update" }).db, HEAD, { rules: [] })).toMatchObject(internal);
    });
});
