import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const access = vi.hoisted(() => ({
    getOrgRole: vi.fn(),
    listAccessibleProjectIds: vi.fn(),
    isOrgAdmin: (role: string | null) => role === "owner" || role === "admin",
}));
vi.mock("../../../lib/access", () => access);
vi.mock("../../projects/projects.service", () => ({ createProject: vi.fn() }));
vi.mock("../../contracts/contracts.service", () => ({
    createObligation: vi.fn(),
    updatePipelineCard: vi.fn(),
    recordCardEvent: vi.fn(),
    contractCorpus: vi.fn(),
}));
vi.mock("../../../lib/dbq/enqueue", () => ({ enqueueDbJob: vi.fn() }));

import { decideRuleSuggestion, draftGuidance, listRuleSuggestions, suggestPlaybookRule } from "../regulatory.rules";

const caller = { userId: "u1", userEmail: "analista@avenia.io" };
const orgScan = { id: "s1", user_id: "u2", org_id: "o1", name: "BCB" };
const change = {
    id: "c1",
    scan_id: "s1",
    title: "Resolução BCB nº 999",
    status: "nova",
    summary: "O BCB exige segregação patrimonial.",
    summary_quote: "segregação patrimonial",
    excerpt: "Dispõe sobre segregação patrimonial.",
    url: "https://bcb/999",
    effective_date: "2027-02-02",
};
const load = [
    { table: "regulatory_changes", data: change },
    { table: "regulatory_scans", data: orgScan },
];

beforeEach(() => {
    access.getOrgRole.mockReset().mockResolvedValue("member");
    access.listAccessibleProjectIds.mockReset().mockResolvedValue([]);
});

describe("draftGuidance", () => {
    it("starts the rule from the change, with the date it takes effect", () => {
        expect(draftGuidance(change)).toBe(
            "Conferir a adequação ao Resolução BCB nº 999: O BCB exige segregação patrimonial. A partir de 02/02/2027.",
        );
        expect(draftGuidance({ ...change, summary: null, excerpt: null, effective_date: null })).toBe(
            "Conferir a adequação ao Resolução BCB nº 999: Resolução BCB nº 999",
        );
    });
});

describe("suggestPlaybookRule", () => {
    it("creates a pending suggestion and never touches a playbook", async () => {
        const fake = scriptedDb([
            ...load,
            { table: "regulatory_rule_suggestions", data: null },
            { table: "regulatory_rule_suggestions", op: "insert", data: { id: "r1", change_id: "c1", status: "pendente" } },
            { table: "regulatory_changes", op: "update" },
        ]);
        const result = await suggestPlaybookRule(fake.db, caller, "c1", { playbook_id: "pb1" });
        expect(result).toMatchObject({ ok: true, data: { id: "r1", status: "pendente" } });
        expect(fake.calls[3].payload).toMatchObject({
            change_id: "c1",
            org_id: "o1",
            playbook_id: "pb1",
            source_quote: "segregação patrimonial",
            source_url: "https://bcb/999",
            suggested_by: "analista@avenia.io",
        });
        expect(fake.calls.map((c) => c.table)).not.toContain("playbooks");
        expect(fake.calls[4].payload).toMatchObject({ status: "lida", decided_by: "analista@avenia.io" });
        fake.done();
    });

    it("edits the open suggestion instead of adding a second one", async () => {
        const fake = scriptedDb([
            { table: "regulatory_changes", data: { ...change, status: "lida", summary_quote: null } },
            { table: "regulatory_scans", data: orgScan },
            { table: "regulatory_rule_suggestions", data: { id: "r1" } },
            { table: "regulatory_rule_suggestions", op: "update", data: { id: "r1", change_id: "c1", status: "pendente" } },
            { table: "regulatory_changes", op: "update" },
        ]);
        await suggestPlaybookRule(fake.db, caller, "c1", { guidance: "  Exigir segregação  " });
        expect(fake.calls[3].payload).toMatchObject({ guidance: "Exigir segregação", playbook_id: null, source_quote: change.excerpt });
        expect(fake.calls[3].filters).toContainEqual(["eq", "id", "r1"]);
        fake.done();
    });

    it("validates, hides and reports failures", async () => {
        const long = scriptedDb(load);
        expect(await suggestPlaybookRule(long.db, caller, "c1", { guidance: "x".repeat(4001) })).toMatchObject({ kind: "validation" });
        const missing = scriptedDb([{ table: "regulatory_changes", data: null }]);
        expect(await suggestPlaybookRule(missing.db, caller, "c0", {})).toMatchObject({ kind: "not_found" });
        const readErr = scriptedDb([{ table: "regulatory_changes", error: { message: "x" } }]);
        expect(await suggestPlaybookRule(readErr.db, caller, "c1", {})).toMatchObject({ kind: "error" });
        const openErr = scriptedDb([...load, { table: "regulatory_rule_suggestions", error: { message: "x" } }]);
        expect(await suggestPlaybookRule(openErr.db, caller, "c1", {})).toMatchObject({ kind: "error" });
        const writeErr = scriptedDb([
            ...load,
            { table: "regulatory_rule_suggestions", data: null },
            { table: "regulatory_rule_suggestions", op: "insert", error: { message: "x" } },
        ]);
        expect(await suggestPlaybookRule(writeErr.db, caller, "c1", {})).toMatchObject({ kind: "error" });
    });
});

describe("listRuleSuggestions", () => {
    it("lists the suggestions of the caller's scans, filtered by status", async () => {
        const fake = scriptedDb([
            { table: "org_members", data: [{ org_id: "o1" }] },
            { table: "regulatory_scans", data: [orgScan] },
            { table: "regulatory_changes", data: [{ id: "c1" }] },
            { table: "regulatory_rule_suggestions", data: [{ id: "r1" }] },
        ]);
        expect(await listRuleSuggestions(fake.db, caller, "pendente")).toEqual({ ok: true, data: [{ id: "r1" }] });
        expect(fake.calls[3].filters).toContainEqual(["eq", "status", "pendente"]);
        fake.done();
    });

    it("is empty without scans or changes and reports read errors", async () => {
        const none = scriptedDb([
            { table: "org_members", data: [] },
            { table: "regulatory_scans", data: [] },
        ]);
        expect(await listRuleSuggestions(none.db, caller)).toEqual({ ok: true, data: [] });
        const noChanges = scriptedDb([
            { table: "org_members", data: [] },
            { table: "regulatory_scans", data: [orgScan] },
            { table: "regulatory_changes", data: [] },
        ]);
        expect(await listRuleSuggestions(noChanges.db, caller, "todas")).toEqual({ ok: true, data: [] });
        for (const steps of [
            [{ table: "org_members", error: { message: "x" } }],
            [{ table: "org_members", data: [] }, { table: "regulatory_scans", data: [orgScan] }, { table: "regulatory_changes", error: { message: "x" } }],
            [
                { table: "org_members", data: [] },
                { table: "regulatory_scans", data: [orgScan] },
                { table: "regulatory_changes", data: [{ id: "c1" }] },
                { table: "regulatory_rule_suggestions", error: { message: "x" } },
            ],
        ]) {
            expect(await listRuleSuggestions(scriptedDb(steps).db, caller)).toMatchObject({ kind: "error" });
        }
    });
});

describe("decideRuleSuggestion", () => {
    const pending = { id: "r1", change_id: "c1", status: "pendente" };

    it("lets the Head approve, recording who and why", async () => {
        access.getOrgRole.mockResolvedValue("owner");
        const fake = scriptedDb([
            { table: "regulatory_rule_suggestions", data: pending },
            ...load,
            { table: "regulatory_rule_suggestions", op: "update", data: { ...pending, status: "aprovada" } },
        ]);
        const head = { userId: "h1", userEmail: "head@avenia.io" };
        expect(await decideRuleSuggestion(fake.db, head, "r1", { status: "aprovada", note: " ok " })).toMatchObject({
            ok: true,
            data: { status: "aprovada" },
        });
        expect(fake.calls[3].payload).toMatchObject({ status: "aprovada", decided_by: "head@avenia.io", decision_note: "ok" });
        expect(fake.calls[3].filters).toContainEqual(["eq", "status", "pendente"]);
        fake.done();
    });

    it("refuses an analyst, a decided suggestion and an unknown status", async () => {
        const member = scriptedDb([{ table: "regulatory_rule_suggestions", data: pending }, ...load]);
        expect(await decideRuleSuggestion(member.db, caller, "r1", { status: "rejeitada" })).toMatchObject({ kind: "forbidden" });

        access.getOrgRole.mockResolvedValue("admin");
        const decided = scriptedDb([{ table: "regulatory_rule_suggestions", data: { ...pending, status: "aprovada" } }, ...load]);
        expect(await decideRuleSuggestion(decided.db, caller, "r1", { status: "rejeitada" })).toMatchObject({ kind: "conflict" });

        expect(await decideRuleSuggestion(scriptedDb([]).db, caller, "r1", { status: "talvez" })).toMatchObject({ kind: "validation" });
    });

    it("lets the owner of a personal scan decide", async () => {
        const fake = scriptedDb([
            { table: "regulatory_rule_suggestions", data: pending },
            { table: "regulatory_changes", data: change },
            { table: "regulatory_scans", data: { ...orgScan, org_id: null, user_id: "u1" } },
            { table: "regulatory_rule_suggestions", op: "update", data: { ...pending, status: "rejeitada" } },
        ]);
        expect(await decideRuleSuggestion(fake.db, caller, "r1", { status: "rejeitada" })).toMatchObject({ ok: true });
        expect(fake.calls[3].payload).toMatchObject({ decision_note: null });
    });

    it("hides suggestions the caller cannot see and reports failures", async () => {
        const missing = scriptedDb([{ table: "regulatory_rule_suggestions", data: null }]);
        expect(await decideRuleSuggestion(missing.db, caller, "r0", { status: "aprovada" })).toMatchObject({ kind: "not_found" });
        access.getOrgRole.mockResolvedValue(null);
        const hidden = scriptedDb([{ table: "regulatory_rule_suggestions", data: pending }, ...load]);
        expect(await decideRuleSuggestion(hidden.db, caller, "r1", { status: "aprovada" })).toMatchObject({ kind: "not_found" });
        const readErr = scriptedDb([{ table: "regulatory_rule_suggestions", error: { message: "x" } }]);
        expect(await decideRuleSuggestion(readErr.db, caller, "r1", { status: "aprovada" })).toMatchObject({ kind: "error" });
        const loadErr = scriptedDb([
            { table: "regulatory_rule_suggestions", data: pending },
            { table: "regulatory_changes", error: { message: "x" } },
        ]);
        expect(await decideRuleSuggestion(loadErr.db, caller, "r1", { status: "aprovada" })).toMatchObject({ kind: "error" });
        access.getOrgRole.mockResolvedValue("owner");
        const writeErr = scriptedDb([
            { table: "regulatory_rule_suggestions", data: pending },
            ...load,
            { table: "regulatory_rule_suggestions", op: "update", error: { message: "x" } },
        ]);
        expect(await decideRuleSuggestion(writeErr.db, caller, "r1", { status: "aprovada" })).toMatchObject({ kind: "error" });
    });
});
