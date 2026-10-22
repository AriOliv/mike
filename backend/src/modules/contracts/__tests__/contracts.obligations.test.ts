import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const access = vi.hoisted(() => ({
    checkProjectAccess: vi.fn(),
    listAccessibleProjectIds: vi.fn(),
}));
vi.mock("../../../lib/access", () => access);
vi.mock("../../../lib/gcal", async (actual) => ({
    ...(await actual<typeof import("../../../lib/gcal")>()),
    removeCalendarEvent: vi.fn(),
}));
vi.mock("../../user/user.service", () => ({ getUserModelSettings: vi.fn() }));

import {
    createObligation,
    DEFAULT_ALERT_DAYS,
    listObligationAlerts,
    listObligations,
    updateObligation,
} from "../contracts.service";

const caller = { userId: "u1", userEmail: "Ana@Example.com" };
const row = (over: Record<string, unknown> = {}) => ({
    id: "o1",
    title: "Aviso",
    due_date: "2026-11-20",
    done: false,
    owner_email: null,
    alert_days: 30,
    ...over,
});

beforeEach(() => {
    access.checkProjectAccess.mockReset();
});

describe("deadline owner and warning lead time", () => {
    it("starts with no owner and a 30-day warning", async () => {
        const fake = scriptedDb([{ table: "obligations", op: "insert", data: row() }]);
        const result = await createObligation(fake.db, caller, { title: "Aviso", due_date: "2026-11-20" });
        expect(result.ok).toBe(true);
        expect(fake.calls[0].payload).toMatchObject({ owner_email: null, alert_days: DEFAULT_ALERT_DAYS });
        fake.done();
    });

    it("saves the owner lower-cased and the chosen lead time", async () => {
        const fake = scriptedDb([{ table: "obligations", op: "insert", data: row() }]);
        await createObligation(fake.db, caller, {
            title: "Aviso",
            due_date: "2026-11-20",
            owner_email: " Bia@Example.com ",
            alert_days: 7,
        });
        expect(fake.calls[0].payload).toMatchObject({ owner_email: "bia@example.com", alert_days: 7 });
        fake.done();
    });

    it.each(["not-an-email", "a@b", "two@@example.com", "a b@example.com", 42])(
        "refuses %s as an owner, in Portuguese",
        async (owner_email) => {
            const fake = scriptedDb([]);
            const result = await createObligation(fake.db, caller, { title: "A", due_date: "2026-11-20", owner_email });
            expect(result).toMatchObject({ ok: false, kind: "validation", detail: "Informe o e-mail de quem cuida do prazo." });
            fake.done();
        },
    );

    it.each([-1, 366, 1.5, "30", null])("refuses %s as a lead time", async (alert_days) => {
        const fake = scriptedDb([]);
        const result = await createObligation(fake.db, caller, { title: "A", due_date: "2026-11-20", alert_days });
        expect(result).toMatchObject({ ok: false, kind: "validation" });
        fake.done();
    });

    it("hands a deadline to someone, or takes the owner away", async () => {
        const fake = scriptedDb([
            { table: "obligations", op: "update", data: row({ owner_email: "bia@example.com" }) },
            { table: "obligations", op: "update", data: row() },
        ]);
        await updateObligation(fake.db, caller, "o1", { owner_email: "bia@example.com", alert_days: 14 });
        await updateObligation(fake.db, caller, "o1", { owner_email: null });
        expect(fake.calls[0].payload).toMatchObject({ owner_email: "bia@example.com", alert_days: 14 });
        expect(fake.calls[1].payload).toMatchObject({ owner_email: null });
        fake.done();
    });

    it("refuses a bad owner or lead time on update", async () => {
        const fake = scriptedDb([]);
        expect(await updateObligation(fake.db, caller, "o1", { owner_email: "x" })).toMatchObject({ ok: false, kind: "validation" });
        expect(await updateObligation(fake.db, caller, "o1", { alert_days: 999 })).toMatchObject({ ok: false, kind: "validation" });
        fake.done();
    });

    it("lets the owner see and tick the deadline, not only its creator", async () => {
        const fake = scriptedDb([
            { table: "obligations", data: [row()] },
            { table: "obligations", op: "update", data: row({ done: true }) },
        ]);
        await listObligations(fake.db, caller, {});
        await updateObligation(fake.db, caller, "o1", { done: true });
        const scope = ["or", "user_id.eq.u1,owner_email.eq.ana@example.com"];
        expect(fake.calls[0].filters).toContainEqual(scope);
        expect(fake.calls[1].filters).toContainEqual(scope);
        fake.done();
    });

    it("scopes to the creator alone when the account has no usable e-mail", async () => {
        const fake = scriptedDb([{ table: "obligations", data: [] }]);
        await listObligations(fake.db, { userId: "u1", userEmail: null }, {});
        expect(fake.calls[0].filters).toContainEqual(["or", "user_id.eq.u1"]);
        fake.done();
    });
});

describe("alerts waiting for a person", () => {
    // 2026-11-01 in São Paulo.
    const now = new Date("2026-11-01T15:00:00Z");

    it("shows a deadline once its warning window has opened, overdue ones too", async () => {
        const fake = scriptedDb([
            {
                table: "obligations",
                data: [
                    row({ id: "overdue", due_date: "2026-10-28" }),
                    row({ id: "in-window", due_date: "2026-11-25" }),
                    row({ id: "too-early", due_date: "2026-12-15" }),
                    row({ id: "short-lead", due_date: "2026-11-20", alert_days: 7 }),
                    row({ id: "today", due_date: "2026-11-01", alert_days: 0 }),
                ],
            },
        ]);
        const result = await listObligationAlerts(fake.db, caller, now);
        expect(result.ok && result.data.map((a) => [a.id, a.days_left])).toEqual([
            ["overdue", -4],
            ["in-window", 24],
            ["today", 0],
        ]);
        expect(fake.calls[0].filters).toContainEqual(["eq", "done", false]);
        fake.done();
    });

    it("leaves out what the creator handed to someone else", async () => {
        const fake = scriptedDb([
            {
                table: "obligations",
                data: [
                    row({ id: "mine-by-owner", owner_email: "ana@example.com", due_date: "2026-11-05" }),
                    row({ id: "handed-on", owner_email: "bia@example.com", due_date: "2026-11-05" }),
                    row({ id: "no-owner", due_date: "2026-11-05" }),
                ],
            },
        ]);
        const result = await listObligationAlerts(fake.db, caller, now);
        expect(result.ok && result.data.map((a) => a.id)).toEqual(["mine-by-owner", "no-owner"]);
        fake.done();
    });

    it("answers with an internal failure when the read fails", async () => {
        const fake = scriptedDb([{ table: "obligations", error: { message: "down" } }]);
        expect(await listObligationAlerts(fake.db, caller, now)).toMatchObject({ ok: false, kind: "error" });
        fake.done();
    });
});
