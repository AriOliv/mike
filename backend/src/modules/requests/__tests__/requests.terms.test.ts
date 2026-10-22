// The contract's terms on the form (U-05 part 2, U-07, U-08): the other
// party's e-mail, the start and the term in months, with the end computed.
// Synthetic data only.
import { describe, expect, it, vi } from "vitest";
import { memoryDb, uuid } from "./memoryDb";

const enqueue = vi.hoisted(() => ({ enqueueDbJob: vi.fn(async () => ({ id: "job", deduped: false })) }));
vi.mock("../../../lib/dbq/enqueue", () => enqueue);

import { createRequest, deliverRequest, getRequest, getTerms, parseTerms, setTerms, termEnd, type RequestTeamView } from "../requests.service";

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
                        counterparty_email: null, term_start: null, term_months: null, terms_inferred: {},
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

describe("when the term ends", () => {
    it("is the start plus the months, on the same day", () => {
        expect(termEnd("2026-11-12", 12)).toBe("2027-11-12");
        expect(termEnd("2026-01-15", 1)).toBe("2026-02-15");
        expect(termEnd("2026-11-12", 36)).toBe("2029-11-12");
    });

    it("falls on the last day of a shorter month: 31/01 + 1 month = 28/02", () => {
        expect(termEnd("2027-01-31", 1)).toBe("2027-02-28");
        expect(termEnd("2028-01-31", 1)).toBe("2028-02-29");
        expect(termEnd("2026-08-31", 6)).toBe("2027-02-28");
        expect(termEnd("2024-02-29", 12)).toBe("2025-02-28");
    });

    it("crosses years and centuries without drifting", () => {
        expect(termEnd("2026-12-31", 2)).toBe("2027-02-28");
        expect(termEnd("2026-12-15", 1)).toBe("2027-01-15");
        expect(termEnd("2026-01-01", 600)).toBe("2076-01-01");
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

describe("answering the terms", () => {
    const SUGGEST = {
        counterparty: { value: "Nuvem Fictícia S.A.", quote: "Contratada: Nuvem Fictícia S.A." },
        term_start: { value: "2026-11-01", quote: "Vigência a partir de 1º de novembro de 2026." },
        term_months: { value: "24", quote: "prazo de vigência é de 24 meses" },
    };
    async function open(extra: Record<string, unknown> = {}) {
        const w = world();
        const r = await createRequest(w.db, REQUESTER, { kind: "revisao", counterparty: undefined, context: "Contrato.", ...extra });
        if (!r.ok) throw new Error(JSON.stringify(r));
        const id = r.data.request.id;
        const row = w.table("legal_requests").find((x) => x.id === id)!;
        return { w, id, row };
    }

    it("shows what the agent read, with its words, and the computed end", async () => {
        const { w, id, row } = await open({ term_start: "2026-01-31", term_months: 1 });
        row.terms_inferred = { counterparty: SUGGEST.counterparty };
        const view = await getTerms(w.db, HEAD, id);
        expect(view.ok && view.data).toMatchObject({
            term_end: "2026-02-28",
            inferred: { counterparty: { quote: "Contratada: Nuvem Fictícia S.A." } },
            can_answer: true,
        });
    });

    it("confirming copies the suggestion into the real field and drops it from the suggestions", async () => {
        const { w, id, row } = await open();
        row.terms_inferred = { ...SUGGEST };
        const done = await setTerms(w.db, REQUESTER, id, { confirm: ["term_start", "term_months", "nada"] });
        expect(done.ok && done.data).toMatchObject({ term_start: "2026-11-01", term_months: 24, term_end: "2028-11-01" });
        expect(row).toMatchObject({ term_start: "2026-11-01", term_months: 24 });
        expect(Object.keys(row.terms_inferred as object)).toEqual(["counterparty"]);

        const counterparty = await setTerms(w.db, REQUESTER, id, { confirm: ["counterparty"] });
        expect(counterparty.ok && counterparty.data.counterparty).toBe("Nuvem Fictícia S.A.");
        expect(row.terms_inferred).toEqual({});
    });

    it("a value the person typed wins over a confirmation of the same field, and clears the suggestion", async () => {
        const { w, id, row } = await open();
        row.terms_inferred = { ...SUGGEST };
        const done = await setTerms(w.db, REQUESTER, id, { confirm: ["term_months"], term_months: 36, counterparty: "  Nuvem Ltda  ", term_start: "" });
        expect(done.ok && done.data).toMatchObject({ term_months: 36, counterparty: "Nuvem Ltda", term_start: null });
        expect(row.terms_inferred).toEqual({});
    });

    it("an empty value clears the field, and a bad one names it with a 422-style code", async () => {
        const { w, id, row } = await open({ term_months: 12, term_start: "2026-11-01" });
        const cleared = await setTerms(w.db, REQUESTER, id, { term_months: "" });
        expect(cleared.ok && cleared.data.term_months).toBeNull();
        expect(row.term_months).toBeNull();
        const bad = await setTerms(w.db, REQUESTER, id, { term_months: 0 });
        expect(bad).toMatchObject({ ok: false, kind: "validation", code: "field:term_months", detail: "Use um prazo de 1 mês ou mais." });
        expect(row.term_months).toBeNull();
    });

    it("changes nothing when nothing was sent", async () => {
        const { w, id, row } = await open({ term_months: 12 });
        const before = JSON.stringify(row);
        const done = await setTerms(w.db, REQUESTER, id, {});
        expect(done.ok && done.data.term_months).toBe(12);
        expect(JSON.stringify(row)).toBe(before);
    });

    it("lets the requester write the other party's e-mail but never reads it back to them", async () => {
        const { w, id, row } = await open();
        const saved = await setTerms(w.db, REQUESTER, id, { counterparty_email: "Contato@Empresa.com" });
        expect(saved.ok && saved.data.counterparty_email).toBeNull();
        expect(row.counterparty_email).toBe("contato@empresa.com");
        expect(JSON.stringify(await getTerms(w.db, REQUESTER, id))).not.toContain("contato@empresa.com");
        const team = await getTerms(w.db, HEAD, id);
        expect(team.ok && team.data.counterparty_email).toBe("contato@empresa.com");
    });

    it("keeps strangers out, and a closed request closed", async () => {
        const { w, id } = await open();
        const stranger = { userId: "cccccccc-0000-4000-8000-000000000009", userEmail: "x@avenia.io" };
        expect((await getTerms(w.db, stranger, id)).ok).toBe(false);
        expect((await setTerms(w.db, stranger, id, { term_months: 5 })).ok).toBe(false);
        const delivered = await deliverRequest(w.db, HEAD, id, { message: "Pronto." });
        expect(delivered.ok).toBe(true);
        expect(await setTerms(w.db, REQUESTER, id, { term_months: 5 })).toMatchObject({ ok: false, kind: "conflict", detail: "Este pedido já foi encerrado." });
        const view = await getTerms(w.db, REQUESTER, id);
        expect(view.ok && view.data.can_answer).toBe(false);
    });

    it("lets an invited guest read the terms without the other party's e-mail, and never change them", async () => {
        const { w, id, row } = await open({ counterparty_email: "contato@empresa.com", term_months: 12 });
        const guest = { userId: "dddddddd-0000-4000-8000-000000000001", userEmail: "externo@escritorio.com" };
        w.table("legal_request_participants").push({
            request_id: id, email: "externo@escritorio.com", role: "external", label: null,
            expires_at: "2099-01-01T00:00:00Z", revoked_at: null, created_at: "2026-10-22T00:00:00Z",
        });
        const read = await getTerms(w.db, guest, id);
        expect(read.ok && read.data).toMatchObject({ term_months: 12, counterparty_email: null, can_answer: false });
        expect(JSON.stringify(read)).not.toContain("contato@empresa.com");
        expect(await setTerms(w.db, guest, id, { term_months: 5 })).toMatchObject({
            ok: false,
            kind: "forbidden",
            detail: "Os dados do contrato são de quem pediu e do time do Legal.",
        });
        expect(row.term_months).toBe(12);
    });

    it("answers with an internal failure when saving fails", async () => {
        const { w, id } = await open();
        const seeded = memoryDb(
            Object.fromEntries(["legal_teams", "org_members", "user_profiles", "legal_requests", "projects"].map((t) => [t, w.table(t)])),
            { fail: (t, op) => (t === "legal_requests" && op === "update" ? { message: "boom" } : null) },
        );
        expect(await setTerms(seeded.db, REQUESTER, id, { term_months: 5 })).toMatchObject({ ok: false, kind: "error" });
    });
});
