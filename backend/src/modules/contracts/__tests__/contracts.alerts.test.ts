// A contract's deadlines (U-20): what its terms imply, how they are kept in
// step when the contract is read again without undoing the team's work, the
// tab that lists them, and the calendar file. Synthetic data only.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const access = vi.hoisted(() => ({ checkProjectAccess: vi.fn(), listAccessibleProjectIds: vi.fn() }));
vi.mock("../../../lib/access", () => access);
const shared = vi.hoisted(() => ({ file: { id: "f" } as unknown, text: "CONTRATO" }));
vi.mock("../contracts.shared", async (actual) => ({
    ...(await actual<typeof import("../contracts.shared")>()),
    latestContractFiles: vi.fn(async (_db: unknown, ids: string[]) => new Map(ids.map((id) => [id, shared.file]))),
    contractFileText: vi.fn(async () => shared.text),
}));
const llm = vi.hoisted(() => ({ completeText: vi.fn() }));
vi.mock("../../../lib/llm", () => llm);
vi.mock("../../user/user.service", () => ({ getUserModelSettings: vi.fn() }));

import {
    ALERT_LEAD_DAYS,
    listContractAlerts,
    obligationIcs,
    updateObligation,
    type ContractTerms,
} from "../contracts.service";
import { deadlinesFromTerms, extractTermsForAgent } from "../contracts.terms";

const caller = { userId: "u1", userEmail: "ana@avenia.io" };
const role = { ok: true, isCreator: false, orgRole: null, projectRole: "viewer", project: {} };
const selected = { ok: true, model: "m", settings: { api_keys: {} } } as never;

const terms = (over: Partial<ContractTerms> = {}): ContractTerms => ({
    auto_renewal: false,
    term_end: "2027-01-31",
    notice_days: 30,
    notice_deadline: "2026-12-31",
    penalty_value: null,
    penalty_recurrence: null,
    liability_cap: null,
    unilateral_amendment: null,
    amendment_notes: null,
    price_regulatory_impact: null,
    sources: { notice_days: "Cláusula 9" },
    ...over,
});

beforeEach(() => {
    access.checkProjectAccess.mockReset();
    llm.completeText.mockReset();
    shared.file = { id: "f" };
    shared.text = "CONTRATO";
});

describe("deadlines a contract's terms imply", () => {
    it("are three, typed: the end of the term, the notice, and the decision ahead of it", () => {
        const days = deadlinesFromTerms(terms());
        expect(days.map((d) => [d.kind, d.due_date, d.mark])).toEqual([
            ["vigencia", "2027-01-31", "recorrente"],
            ["aviso_previo", "2026-12-31", "critico"],
            ["renovacao", `2026-12-31`.replace("2026-12-31", shiftBack("2026-12-31", ALERT_LEAD_DAYS)), "tarefa"],
        ]);
    });

    it("say when the contract renews by itself", () => {
        expect(deadlinesFromTerms(terms({ auto_renewal: true }))[0].title).toBe("Fim da vigência (renova automaticamente)");
        expect(deadlinesFromTerms(terms({ auto_renewal: null }))[0].title).toBe("Fim da vigência");
    });

    it("are only the end of the term when there is no notice period", () => {
        const days = deadlinesFromTerms(terms({ notice_days: null, notice_deadline: null }));
        expect(days.map((d) => d.kind)).toEqual(["vigencia"]);
    });

    it("are none when the terms carry no dates", () => {
        expect(deadlinesFromTerms(terms({ term_end: null, notice_days: null, notice_deadline: null }))).toEqual([]);
    });
});

function shiftBack(date: string, days: number): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
}

/** Runs the extraction with the model answering `answer`, and the table holding `existing`. */
async function extract(answer: Record<string, unknown>, existing: Record<string, unknown>[], then: Array<Record<string, unknown>>) {
    llm.completeText.mockResolvedValue(JSON.stringify(answer));
    const fake = scriptedDb([
        { table: "contract_terms", op: "upsert", data: null },
        { table: "projects", op: "update", data: null },
        { table: "obligations", data: existing },
        ...(then as never[]),
    ]);
    const result = await extractTermsForAgent(fake.db, "u1", "p1", selected);
    return { fake, result };
}
const answer = { term_end: "2027-01-31", notice_days: 30, auto_renewal: false, contract_type: "Prestação de serviços", sources: { notice_days: "Cláusula 9" } };
// What that answer implies: the notice falls 30 days before the end of the term.
const NOTICE = shiftBack("2027-01-31", 30);
const DECIDE = shiftBack(NOTICE, ALERT_LEAD_DAYS);

describe("reading a contract again", () => {
    it("creates the three deadlines the first time, one row each, typed", async () => {
        const { fake, result } = await extract(answer, [], [
            { table: "obligations", op: "insert", data: null },
            { table: "obligations", op: "insert", data: null },
            { table: "obligations", op: "insert", data: null },
        ]);
        expect(result).toMatchObject({ term_end: "2027-01-31" });
        const inserts = fake.calls.filter((c) => c.table === "obligations" && c.op === "insert");
        expect(inserts.map((c) => (c.payload as { kind: string }).kind)).toEqual(["vigencia", "aviso_previo", "renovacao"]);
        expect(inserts[0].payload).toMatchObject({ project_id: "p1", origin: "renewal", user_id: "u1", source_quote: "Cláusula 9" });
        fake.done();
    });

    it("leaves a deadline alone when nothing about it changed, so its owner and baixa stay", async () => {
        const { fake } = await extract(
            answer,
            [
                { id: "o1", kind: "vigencia", due_date: "2027-01-31", title: "Fim da vigência", status: "feito" },
                { id: "o2", kind: "aviso_previo", due_date: NOTICE, title: "Prazo limite para avisar não renovação (30 dias de aviso prévio)", status: "aberto" },
                { id: "o3", kind: "renovacao", due_date: DECIDE, title: "Decidir sobre renovação — janela de aviso fecha em breve", status: "aberto" },
            ],
            [],
        );
        expect(fake.calls.filter((c) => c.table === "obligations" && c.op !== "select")).toEqual([]);
        fake.done();
    });

    it("moves a date in place, and reopens a deadline the team had closed for the old date", async () => {
        const { fake } = await extract(
            { ...answer, term_end: "2028-01-31", notice_days: 30 },
            [
                { id: "o1", kind: "vigencia", due_date: "2027-01-31", title: "Fim da vigência", status: "feito" },
                { id: "o2", kind: "aviso_previo", due_date: NOTICE, title: "Prazo limite para avisar não renovação (30 dias de aviso prévio)", status: "dispensado" },
                { id: "o3", kind: "renovacao", due_date: DECIDE, title: "Decidir sobre renovação — janela de aviso fecha em breve", status: "aberto" },
            ],
            [
                { table: "obligations", op: "update", data: null },
                { table: "obligations", op: "update", data: null },
                { table: "obligations", op: "update", data: null },
            ],
        );
        const updates = fake.calls.filter((c) => c.table === "obligations" && c.op === "update");
        expect(updates).toHaveLength(3);
        expect(updates[0].payload).toMatchObject({ due_date: "2028-01-31", status: "aberto", done: false });
        expect(updates[0].filters).toContainEqual(["eq", "id", "o1"]);
        // The one that was still open keeps its own state: only its date moved.
        expect(updates[2].payload).not.toHaveProperty("status");
        fake.done();
    });

    it("never deletes and recreates: the team's owner, lead time and baixa live on those rows", async () => {
        const { fake } = await extract(answer, [{ id: "o1", kind: "vigencia", due_date: "2026-01-01", title: "Fim da vigência", status: "aberto" }], [
            { table: "obligations", op: "update", data: null },
            { table: "obligations", op: "insert", data: null },
            { table: "obligations", op: "insert", data: null },
        ]);
        expect(fake.calls.filter((c) => c.table === "obligations" && c.op === "delete")).toEqual([]);
        fake.done();
    });

    it("drops a deadline the terms no longer imply, but only while it is still open", async () => {
        const { fake } = await extract(
            { ...answer, notice_days: null },
            [
                { id: "o1", kind: "vigencia", due_date: "2027-01-31", title: "Fim da vigência", status: "aberto" },
                { id: "o2", kind: "aviso_previo", due_date: "2026-12-31", title: "x", status: "aberto" },
                { id: "o3", kind: "renovacao", due_date: "2026-10-01", title: "y", status: "feito" },
            ],
            [{ table: "obligations", op: "delete", data: null }],
        );
        const del = fake.calls.find((c) => c.table === "obligations" && c.op === "delete")!;
        expect(del.filters).toContainEqual(["in", "id", ["o2"]]);
        fake.done();
    });

    it("surfaces a database failure instead of leaving the deadlines half-written", async () => {
        llm.completeText.mockResolvedValue(JSON.stringify(answer));
        const fake = scriptedDb([
            { table: "contract_terms", op: "upsert", data: null },
            { table: "projects", op: "update", data: null },
            { table: "obligations", error: { message: "down" } },
        ]);
        await expect(extractTermsForAgent(fake.db, "u1", "p1", selected)).rejects.toMatchObject({ message: "down" });
    });

    it("surfaces a failed insert, update and delete too", async () => {
        const steps = (op: string) => [
            { table: "obligations", data: op === "update" ? [{ id: "o1", kind: "vigencia", due_date: "2026-01-01", title: "Fim da vigência", status: "aberto" }] : op === "delete" ? [{ id: "o9", kind: "aviso_previo", due_date: "2026-12-31", title: "x", status: "aberto" }] : [] },
            ...(op === "delete" ? [{ table: "obligations", op: "insert", data: null }] : []),
            { table: "obligations", op, error: { message: `${op} failed` } },
        ];
        for (const op of ["insert", "update", "delete"]) {
            llm.completeText.mockResolvedValue(JSON.stringify(op === "delete" ? { ...answer, notice_days: null } : answer));
            const fake = scriptedDb([{ table: "contract_terms", op: "upsert", data: null }, { table: "projects", op: "update", data: null }, ...(steps(op) as never[])]);
            await expect(extractTermsForAgent(fake.db, "u1", "p1", selected)).rejects.toMatchObject({ message: `${op} failed` });
        }
    });
});

describe("a deadline's status", () => {
    const row = { id: "o1", status: "aberto", done: false };

    it("drives done: feito and dispensado close it, aberto reopens it", async () => {
        const fake = scriptedDb([
            { table: "obligations", op: "update", data: row },
            { table: "obligations", op: "update", data: row },
            { table: "obligations", op: "update", data: row },
        ]);
        await updateObligation(fake.db, caller, "o1", { status: "feito" });
        await updateObligation(fake.db, caller, "o1", { status: "dispensado" });
        await updateObligation(fake.db, caller, "o1", { status: "aberto" });
        expect(fake.calls.map((c) => [(c.payload as Record<string, unknown>).status, (c.payload as Record<string, unknown>).done])).toEqual([
            ["feito", true],
            ["dispensado", true],
            ["aberto", false],
        ]);
        fake.done();
    });

    it("keeps the radar's tick working: done alone maps onto feito and aberto", async () => {
        const fake = scriptedDb([
            { table: "obligations", op: "update", data: row },
            { table: "obligations", op: "update", data: row },
        ]);
        await updateObligation(fake.db, caller, "o1", { done: true });
        await updateObligation(fake.db, caller, "o1", { done: false });
        expect(fake.calls.map((c) => [(c.payload as Record<string, unknown>).status, (c.payload as Record<string, unknown>).done])).toEqual([
            ["feito", true],
            ["aberto", false],
        ]);
        fake.done();
    });

    it("lets status win when both are sent", async () => {
        const fake = scriptedDb([{ table: "obligations", op: "update", data: row }]);
        await updateObligation(fake.db, caller, "o1", { status: "dispensado", done: false });
        expect(fake.calls[0].payload).toMatchObject({ status: "dispensado", done: true });
        fake.done();
    });

    it("refuses a status that does not exist, in Portuguese", async () => {
        const fake = scriptedDb([]);
        expect(await updateObligation(fake.db, caller, "o1", { status: "arquivado" })).toMatchObject({
            ok: false,
            kind: "validation",
            detail: "O status do prazo é aberto, feito ou dispensado.",
        });
        fake.done();
    });
});

describe("the contract's alerts tab", () => {
    const now = new Date("2026-11-01T15:00:00Z");

    it("shows every deadline of the contract, whoever made it, open ones first", async () => {
        access.checkProjectAccess.mockResolvedValue(role);
        const fake = scriptedDb([
            {
                table: "obligations",
                data: [
                    { id: "a", due_date: "2026-11-05", status: "feito" },
                    { id: "b", due_date: "2026-11-20", status: "aberto" },
                    { id: "c", due_date: "2026-10-28", status: "aberto" },
                    { id: "d", due_date: "2026-12-01", status: "dispensado" },
                ],
            },
        ]);
        const result = await listContractAlerts(fake.db, caller, "p1", now);
        expect(result.ok && result.data.map((r) => [r.id, r.days_left])).toEqual([
            ["b", 19],
            ["c", -4],
            ["a", 4],
            ["d", 30],
        ]);
        // Opening the contract is what allows it: no filter by who made the deadline.
        expect(fake.calls[0].filters).toEqual([["eq", "project_id", "p1"], ["order", "due_date", { ascending: true }]]);
        fake.done();
    });

    it("is not for someone who cannot see the contract", async () => {
        access.checkProjectAccess.mockResolvedValue({ ok: false });
        const fake = scriptedDb([]);
        expect(await listContractAlerts(fake.db, caller, "p1", now)).toMatchObject({ ok: false, kind: "not_found" });
        fake.done();
    });

    it("answers with an internal failure when the read fails", async () => {
        access.checkProjectAccess.mockResolvedValue(role);
        const fake = scriptedDb([{ table: "obligations", error: { message: "down" } }]);
        expect(await listContractAlerts(fake.db, caller, "p1", now)).toMatchObject({ ok: false, kind: "error" });
    });
});

describe("the calendar file", () => {
    const now = new Date("2026-11-01T15:04:05.678Z");
    const deadline = {
        id: "6f1c2a0e-8b4d-4e2a-9c3f-1a2b3c4d5e6f",
        title: "Aviso, não renovar; cláusula 9",
        due_date: "2026-12-31",
        note: "Falar com o\nfinanceiro",
        source_quote: "Cláusula 9",
        alert_days: 7,
        status: "aberto",
        project_id: "p1",
        projects: { name: "Contrato de nuvem", counterparty: "Nuvem Fictícia S.A." },
    };

    it("is an all-day event on the due date, with an alarm that many days before", async () => {
        access.checkProjectAccess.mockResolvedValue(role);
        const fake = scriptedDb([{ table: "obligations", data: deadline }]);
        const result = await obligationIcs(fake.db, caller, deadline.id, now);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.filename).toBe("prazo-2026-12-31.ics");
        const lines = result.data.body.split("\r\n");
        expect(lines).toContain("BEGIN:VCALENDAR");
        expect(lines).toContain(`UID:${deadline.id}@mike`);
        expect(lines).toContain("DTSTAMP:20261101T150405Z");
        expect(lines).toContain("DTSTART;VALUE=DATE:20261231");
        expect(lines).toContain("DTEND;VALUE=DATE:20270101");
        expect(lines).toContain("TRIGGER:-P7D");
        expect(lines).toContain("STATUS:CONFIRMED");
        expect(result.data.body.endsWith("END:VCALENDAR\r\n")).toBe(true);
        fake.done();
    });

    it("escapes the text so a comma, a semicolon or a line break cannot break a field", async () => {
        access.checkProjectAccess.mockResolvedValue(role);
        const fake = scriptedDb([{ table: "obligations", data: deadline }]);
        const result = await obligationIcs(fake.db, caller, deadline.id, now);
        if (!result.ok) throw new Error("no ics");
        expect(result.data.body).toContain(String.raw`SUMMARY:Aviso\, não renovar\; cláusula 9`);
        expect(result.data.body).toContain(String.raw`DESCRIPTION:Contrato: Nuvem Fictícia S.A.\nFalar com o\nfinanceiro\nTrecho: Cláusula 9`);
        expect(result.data.body.split("\r\n").filter((l) => l.startsWith("DESCRIPTION:") && !l.includes("Contrato"))).toHaveLength(1);
    });

    it("marks a dismissed deadline as cancelled", async () => {
        access.checkProjectAccess.mockResolvedValue(role);
        const fake = scriptedDb([{ table: "obligations", data: { ...deadline, status: "dispensado" } }]);
        const result = await obligationIcs(fake.db, caller, deadline.id, now);
        expect(result.ok && result.data.body).toContain("STATUS:CANCELLED");
    });

    it("works for a deadline with no contract, no note and no quote, for whoever owns it", async () => {
        const bare = { ...deadline, project_id: null, projects: null, note: null, source_quote: null, alert_days: 0 };
        const fake = scriptedDb([
            { table: "obligations", data: bare },
            { table: "obligations", data: { id: bare.id } },
        ]);
        const result = await obligationIcs(fake.db, caller, bare.id, now);
        expect(result.ok && result.data.body).not.toContain("DESCRIPTION:Contrato");
        expect(result.ok && result.data.body).toContain("TRIGGER:-P0D");
        expect(fake.calls[1].filters).toContainEqual(["or", "user_id.eq.u1,owner_email.eq.ana@avenia.io"]);
        fake.done();
    });

    it("says it was not found, never that it exists, for a deadline the caller cannot see", async () => {
        access.checkProjectAccess.mockResolvedValue({ ok: false });
        const hidden = scriptedDb([{ table: "obligations", data: deadline }]);
        expect(await obligationIcs(hidden.db, caller, deadline.id, now)).toMatchObject({ ok: false, kind: "not_found", detail: "Não encontrei este prazo." });
        const bare = { ...deadline, project_id: null };
        const foreign = scriptedDb([
            { table: "obligations", data: bare },
            { table: "obligations", data: null },
        ]);
        expect(await obligationIcs(foreign.db, caller, deadline.id, now)).toMatchObject({ ok: false, kind: "not_found" });
    });

    it("says it was not found when the deadline does not exist, and fails on a database error", async () => {
        expect(await obligationIcs(scriptedDb([{ table: "obligations", data: null }]).db, caller, "x", now)).toMatchObject({ ok: false, kind: "not_found" });
        expect(await obligationIcs(scriptedDb([{ table: "obligations", error: { message: "down" } }]).db, caller, "x", now)).toMatchObject({ ok: false, kind: "error" });
        const bare = { ...deadline, project_id: null };
        const down = scriptedDb([{ table: "obligations", data: bare }, { table: "obligations", error: { message: "down" } }]);
        expect(await obligationIcs(down.db, caller, deadline.id, now)).toMatchObject({ ok: false, kind: "error" });
    });
});
