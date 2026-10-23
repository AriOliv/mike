// The contract's terms on the form (U-05 part 2, U-07, U-08): the other
// party's e-mail, the start and the term in months, with the end computed.
// Synthetic data only.
import { describe, expect, it, vi } from "vitest";
import { memoryDb, uuid } from "./memoryDb";

const enqueue = vi.hoisted(() => ({ enqueueDbJob: vi.fn(async () => ({ id: "job", deduped: false })) }));
vi.mock("../../../lib/dbq/enqueue", () => enqueue);

import { createRequest, getRequest, parseTerms, termEnd, type RequestTeamView } from "../requests.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const HEAD = { userId: "aaaaaaaa-0000-4000-8000-000000000001", userEmail: "head@avenia.io" };
const REQUESTER = { userId: "bbbbbbbb-0000-4000-8000-000000000001", userEmail: "ana@avenia.io" };

function world() {
    let number = 0;
    return memoryDb(
        {
            legal_teams: [{ org_id: ORG, sla_days: {}, auto_assign: false, intake_template: [], assignment_rules: [], created_at: "2026-01-01" }],
            org_members: [{ org_id: ORG, user_id: HEAD.userId, role: "owner", created_at: "2026-01-01" }],
            user_profiles: [
                { user_id: HEAD.userId, email: "head@avenia.io", display_name: "Marina" },
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
                        counterparty_email: null, term_start: null, term_months: null,
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

describe("when the term ends", () => {
    it("is the start plus the months, minus one day", () => {
        expect(termEnd("2026-11-12", 12)).toBe("2027-11-11");
        expect(termEnd("2026-01-15", 1)).toBe("2026-02-14");
        expect(termEnd("2026-11-12", 36)).toBe("2029-11-11");
        expect(termEnd("2026-06-10", 6)).toBe("2026-12-09");
    });

    it("ends a term that starts on the 1st on the last day of the month before", () => {
        expect(termEnd("2026-01-01", 12)).toBe("2026-12-31");
        expect(termEnd("2026-03-01", 1)).toBe("2026-03-31");
        expect(termEnd("2026-02-01", 1)).toBe("2026-02-28");
        expect(termEnd("2028-02-01", 1)).toBe("2028-02-29");
        expect(termEnd("2026-01-01", 600)).toBe("2075-12-31");
    });

    it("never spills into the next month: a day the month does not have ends on its last day", () => {
        expect(termEnd("2027-01-31", 1)).toBe("2027-02-28");
        expect(termEnd("2028-01-31", 1)).toBe("2028-02-29");
        expect(termEnd("2026-08-31", 6)).toBe("2027-02-28");
        expect(termEnd("2026-12-31", 2)).toBe("2027-02-28");
        expect(termEnd("2026-03-31", 1)).toBe("2026-04-30");
        expect(termEnd("2026-01-30", 1)).toBe("2026-02-28");
        expect(termEnd("2026-01-29", 1)).toBe("2026-02-28");
        expect(termEnd("2026-01-28", 1)).toBe("2026-02-27");
    });

    it("handles the leap day on both sides", () => {
        expect(termEnd("2024-02-29", 12)).toBe("2025-02-28");
        expect(termEnd("2024-02-29", 48)).toBe("2028-02-28");
        expect(termEnd("2023-02-28", 12)).toBe("2024-02-27");
        expect(termEnd("2023-03-01", 12)).toBe("2024-02-29");
        expect(termEnd("2027-03-01", 12)).toBe("2028-02-29");
    });

    it("crosses years without drifting", () => {
        expect(termEnd("2026-12-15", 1)).toBe("2027-01-14");
        expect(termEnd("2026-12-01", 1)).toBe("2026-12-31");
        expect(termEnd("2026-12-31", 12)).toBe("2027-12-30");
    });

    it("is empty until both values are known, and for a date that does not exist", () => {
        expect(termEnd(null, 12)).toBeNull();
        expect(termEnd("2026-11-12", null)).toBeNull();
        expect(termEnd(null, null)).toBeNull();
        expect(termEnd("2026-02-30", 12)).toBeNull();
    });
});

describe("checking the terms the form sends", () => {
    it("accepts all three, trims and lower-cases the e-mail, and reads months sent as text", () => {
        expect(parseTerms({ counterparty_email: "  Contato@Empresa.com ", term_start: "2026-11-12", term_months: "12" })).toEqual({
            ok: true,
            counterpartyEmail: "contato@empresa.com",
            termStart: "2026-11-12",
            termMonths: 12,
        });
    });

    it("never errors on empty optional fields", () => {
        const empty = { ok: true, counterpartyEmail: null, termStart: null, termMonths: null };
        expect(parseTerms({})).toEqual(empty);
        expect(parseTerms({ counterparty_email: "", term_start: "  ", term_months: null })).toEqual(empty);
        expect(parseTerms({ counterparty_email: undefined })).toEqual(empty);
    });

    it("explains a bad e-mail in the words the screen shows, naming the field", () => {
        for (const bad of ["nome", "nome@", "@empresa.com", "a b@c.com", 5, `${"a".repeat(250)}@x.com`]) {
            expect(parseTerms({ counterparty_email: bad })).toEqual({
                ok: false,
                field: "counterparty_email",
                detail: "Esse e-mail não parece certo. Confira e tente de novo.",
            });
        }
    });

    it("explains a bad start date, and accepts a very old one (an old contract is legitimate)", () => {
        for (const bad of ["12/11/2026", "2026-13-01", "2026-02-30", 20261112]) {
            expect(parseTerms({ term_start: bad })).toMatchObject({ ok: false, field: "term_start", detail: "Escolha uma data de início válida." });
        }
        expect(parseTerms({ term_start: "1998-03-01" })).toMatchObject({ ok: true, termStart: "1998-03-01" });
    });

    it("explains a term that is zero, negative, over fifty years, or not a whole number", () => {
        expect(parseTerms({ term_months: 0 })).toMatchObject({ ok: false, field: "term_months", detail: "Use um prazo de 1 mês ou mais." });
        expect(parseTerms({ term_months: -3 })).toMatchObject({ ok: false, detail: "Use um prazo de 1 mês ou mais." });
        expect(parseTerms({ term_months: 601 })).toMatchObject({ ok: false, detail: "Confira o prazo: isso passa de 50 anos." });
        expect(parseTerms({ term_months: 600 })).toMatchObject({ ok: true, termMonths: 600 });
        expect(parseTerms({ term_months: 1 })).toMatchObject({ ok: true, termMonths: 1 });
        for (const bad of [1.5, "doze", "1.5", true, {}]) {
            expect(parseTerms({ term_months: bad })).toMatchObject({ ok: false, field: "term_months", detail: "Use um prazo em meses, com número inteiro." });
        }
    });

    it("reports the first problem, e-mail before dates", () => {
        expect(parseTerms({ counterparty_email: "x", term_start: "bad", term_months: 0 })).toMatchObject({ field: "counterparty_email" });
        expect(parseTerms({ term_start: "bad", term_months: 0 })).toMatchObject({ field: "term_start" });
    });
});

describe("on a request", () => {
    const base = { kind: "revisao", counterparty: "Nuvem Fictícia S.A.", context: "Contrato de nuvem." };

    it("keeps the terms, and shows the team the computed end", async () => {
        const w = world();
        const created = await createRequest(w.db, REQUESTER, {
            ...base,
            counterparty_email: "Contato@Empresa.com",
            term_start: "2027-01-31",
            term_months: 1,
        });
        expect(created.ok).toBe(true);
        const id = created.ok ? created.data.request.id : "";
        expect(w.table("legal_requests")[0]).toMatchObject({ counterparty_email: "contato@empresa.com", term_start: "2027-01-31", term_months: 1 });

        const view = await getRequest(w.db, HEAD, id);
        expect(view.ok && (view.data as RequestTeamView).terms).toEqual({
            counterparty_email: "contato@empresa.com",
            term_start: "2027-01-31",
            term_months: 1,
            term_end: "2027-02-28",
        });
    });

    it("shows the team the terms together with the stage and its history", async () => {
        const w = world();
        const created = await createRequest(w.db, REQUESTER, { ...base, term_start: "2026-11-12", term_months: 12 });
        const id = created.ok ? created.data.request.id : "";
        const view = await getRequest(w.db, HEAD, id);
        const team = view.ok ? (view.data as RequestTeamView) : null;
        expect(team?.terms).toMatchObject({ term_start: "2026-11-12", term_months: 12, term_end: "2027-11-11" });
        expect(team?.stage.stage).toBeTruthy();
        expect(team?.stages.length).toBeGreaterThan(0);
    });

    it("is born without terms when the form leaves them empty, and then shows no end", async () => {
        const w = world();
        const created = await createRequest(w.db, REQUESTER, base);
        const id = created.ok ? created.data.request.id : "";
        const view = await getRequest(w.db, HEAD, id);
        expect(view.ok && (view.data as RequestTeamView).terms).toEqual({
            counterparty_email: null,
            term_start: null,
            term_months: null,
            term_end: null,
        });
    });

    it("refuses a bad term with the field named, and creates nothing", async () => {
        const w = world();
        const refused = await createRequest(w.db, REQUESTER, { ...base, term_months: 0 });
        expect(refused).toMatchObject({ ok: false, kind: "validation", code: "field:term_months", detail: "Use um prazo de 1 mês ou mais." });
        expect(w.table("legal_requests")).toHaveLength(0);
        expect(w.table("projects")).toHaveLength(0);
    });

    it("never gives the requester the e-mail they typed, and never mails it", async () => {
        const w = world();
        const created = await createRequest(w.db, REQUESTER, { ...base, counterparty_email: "contato@empresa.com", term_start: "2027-01-31", term_months: 12 });
        const id = created.ok ? created.data.request.id : "";

        const asked = await getRequest(w.db, REQUESTER, id);
        expect(asked.ok && JSON.stringify(asked.data)).not.toContain("contato@empresa.com");
        expect(asked.ok && "terms" in asked.data).toBe(false);

        // Nothing leaves for that address: not a notification, not the card's activity.
        expect(JSON.stringify(w.table("legal_request_notifications"))).not.toContain("contato@empresa.com");
        expect(w.table("legal_request_notifications").every((n) => n.recipient === "ana@avenia.io")).toBe(true);
        expect(JSON.stringify(w.table("card_events"))).not.toContain("contato@empresa.com");
    });
});
