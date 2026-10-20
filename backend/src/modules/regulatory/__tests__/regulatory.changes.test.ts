import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const access = vi.hoisted(() => ({ getOrgRole: vi.fn(), listAccessibleProjectIds: vi.fn() }));
vi.mock("../../../lib/access", () => access);
const projects = vi.hoisted(() => ({ createProject: vi.fn() }));
vi.mock("../../projects/projects.service", () => projects);
const contracts = vi.hoisted(() => ({ createObligation: vi.fn(), updatePipelineCard: vi.fn(), contractCorpus: vi.fn(), recordCardEvent: vi.fn() }));
vi.mock("../../contracts/contracts.service", () => contracts);
const dbq = vi.hoisted(() => ({ enqueueDbJob: vi.fn() }));
vi.mock("../../../lib/dbq/enqueue", () => dbq);

import {
    createObligationFromChange,
    createRequestFromChange,
    createScan,
    deleteScan,
    listChanges,
    listPresets,
    listScans,
    requestDeadline,
    runScanNow,
    updateChange,
    updateScan,
    visibleScanIds,
} from "../regulatory.changes";

const caller = { userId: "u1", userEmail: "ana@avenia.io" };
const orgScan = { id: "s1", user_id: "u2", org_id: "o1", name: "BCB" };
const otherScan = { id: "s9", user_id: "u9", org_id: null, name: "privada" };
const change = (over: Record<string, unknown> = {}) => ({
    id: "c1",
    scan_id: "s1",
    title: "Resolução BCB nº 999",
    status: "nova",
    starred: false,
    impact: "alto",
    published_at: "2026-10-19",
    effective_date: "2027-02-02",
    excerpt: "ativos virtuais",
    summary_quote: null,
    url: "https://bcb/999",
    affected: [
        { project_id: "p1", term: "ativos virtuais", quote: "…ativos virtuais…" },
        { project_id: "p-secret", term: "ativos virtuais", quote: "…" },
    ],
    request_project_id: null,
    obligation_id: null,
    ...over,
});

beforeEach(() => {
    for (const fn of [access.getOrgRole, access.listAccessibleProjectIds, projects.createProject, contracts.createObligation, contracts.updatePipelineCard, dbq.enqueueDbJob]) fn.mockReset();
    access.listAccessibleProjectIds.mockResolvedValue(["p1"]);
});

describe("presets", () => {
    it("ships the four Brazilian scans, ready to use", () => {
        const { presets, sources, topics } = listPresets();
        expect(presets.map((p) => p.key)).toEqual(["bcb_pagamentos_cripto", "lgpd_anpd", "cvm", "coaf_receita"]);
        expect(sources.map((s) => s.id)).toEqual(["bcb_normativos", "dou", "cvm_noticias", "rfb_noticias"]);
        expect(topics).toContain("cripto");
    });
});

describe("scans", () => {
    it("lists the caller's personal scans and their organizations' with open counts", async () => {
        const fake = scriptedDb([
            { table: "org_members", data: [{ org_id: "o1" }] },
            { table: "regulatory_scans", data: [orgScan] },
            {
                table: "regulatory_changes",
                data: [
                    { scan_id: "s1", status: "nova", impact: "alto" },
                    { scan_id: "s1", status: "lida", impact: "baixo" },
                ],
            },
        ]);
        const result = await listScans(fake.db, caller);
        expect(result).toMatchObject({ ok: true, data: [{ id: "s1", counts: { novas: 1, abertas: 2, alto: 1 } }] });
        expect(fake.calls[1].filters).toContainEqual(["or", "and(org_id.is.null,user_id.eq.u1),org_id.in.(o1)"]);
        expect(fake.calls[2].filters).toContainEqual(["neq", "status", "arquivada"]);
        fake.done();
    });

    it("lists nothing for someone without scans, and only personal ones outside an org", async () => {
        const fake = scriptedDb([
            { table: "org_members", data: [] },
            { table: "regulatory_scans", data: [] },
        ]);
        expect(await listScans(fake.db, caller)).toEqual({ ok: true, data: [] });
        expect(fake.calls[1].filters).toContainEqual(["or", "and(org_id.is.null,user_id.eq.u1)"]);
        fake.done();
        const ids = scriptedDb([
            { table: "org_members", data: null },
            { table: "regulatory_scans", data: [orgScan] },
        ]);
        expect(await visibleScanIds(ids.db, caller)).toEqual(["s1"]);
    });

    it("reports a failed read", async () => {
        const fake = scriptedDb([{ table: "org_members", error: { message: "x" } }]);
        expect(await listScans(fake.db, caller)).toMatchObject({ ok: false, kind: "error" });
        const counts = scriptedDb([
            { table: "org_members", data: [] },
            { table: "regulatory_scans", data: [orgScan] },
            { table: "regulatory_changes", error: { message: "x" } },
        ]);
        expect(await listScans(counts.db, caller)).toMatchObject({ ok: false, kind: "error" });
    });

    it("creates a team scan from a preset and queues its first run", async () => {
        access.getOrgRole.mockResolvedValue("member");
        const fake = scriptedDb([{ table: "regulatory_scans", op: "insert", data: { id: "new", name: "LGPD / ANPD" } }]);
        const result = await createScan(fake.db, caller, { preset: "lgpd_anpd", org_id: "o1" });
        expect(result).toMatchObject({ ok: true, data: { id: "new", counts: { novas: 0 } } });
        expect(fake.calls[0].payload).toMatchObject({
            user_id: "u1",
            org_id: "o1",
            preset: "lgpd_anpd",
            sources: ["dou"],
            issuers: ["Autoridade Nacional de Proteção de Dados"],
            topics: ["lgpd"],
        });
        expect(dbq.enqueueDbJob).toHaveBeenCalledWith(fake.db, expect.objectContaining({ payload: { scanId: "new" } }));
        fake.done();
    });

    it("still creates the scan when queueing the first run fails", async () => {
        dbq.enqueueDbJob.mockRejectedValue(new Error("queue down"));
        const fake = scriptedDb([{ table: "regulatory_scans", op: "insert", data: { id: "new" } }]);
        const result = await createScan(fake.db, caller, {
            name: "Pix",
            sources: ["bcb_normativos", "bcb_normativos"],
            keywords: ["pix", " ", 3],
            topics: ["psp"],
        });
        expect(result.ok).toBe(true);
        expect(fake.calls[0].payload).toMatchObject({ org_id: null, preset: null, sources: ["bcb_normativos"], keywords: ["pix"], issuers: [] });
    });

    it("validates what it is asked to watch", async () => {
        const fake = scriptedDb([]);
        expect(await createScan(fake.db, caller, { preset: "nope" })).toMatchObject({ kind: "validation" });
        expect(await createScan(fake.db, caller, { sources: ["dou"] })).toMatchObject({ kind: "validation" });
        expect(await createScan(fake.db, caller, { name: "x", sources: ["twitter"] })).toMatchObject({ kind: "validation" });
        expect(await createScan(fake.db, caller, { name: "x", sources: "dou" })).toMatchObject({ kind: "validation" });
        expect(await createScan(fake.db, caller, { name: "x", sources: ["dou"], topics: ["futebol"] })).toMatchObject({
            kind: "validation",
        });
        access.getOrgRole.mockResolvedValue(null);
        expect(await createScan(fake.db, caller, { preset: "cvm", org_id: "o2" })).toMatchObject({ kind: "forbidden" });
        fake.done();
    });

    it("reports a failed insert", async () => {
        const fake = scriptedDb([{ table: "regulatory_scans", op: "insert", error: { message: "x" } }]);
        expect(await createScan(fake.db, caller, { preset: "cvm" })).toMatchObject({ ok: false, kind: "error" });
    });

    it("lets a member pause, rename or re-run a team scan", async () => {
        access.getOrgRole.mockResolvedValue("member");
        const fake = scriptedDb([
            { table: "regulatory_scans", data: orgScan },
            { table: "regulatory_scans", op: "update", data: { ...orgScan, enabled: false } },
            { table: "regulatory_scans", data: orgScan },
        ]);
        expect(await updateScan(fake.db, caller, "s1", { enabled: false, name: " BCB ", keywords: ["pix"] })).toMatchObject({ ok: true });
        expect(fake.calls[1].payload).toMatchObject({ enabled: false, name: "BCB", keywords: ["pix"] });
        expect(await runScanNow(fake.db, caller, "s1")).toEqual({ ok: true, data: { queued: true } });
        fake.done();
    });

    it("hides a scan from someone outside it", async () => {
        const fake = scriptedDb([
            { table: "regulatory_scans", data: otherScan },
            { table: "regulatory_scans", data: null },
            { table: "regulatory_scans", data: otherScan },
        ]);
        expect(await updateScan(fake.db, caller, "s9", { enabled: false })).toMatchObject({ kind: "not_found" });
        expect(await runScanNow(fake.db, caller, "s0")).toMatchObject({ kind: "not_found" });
        expect(await deleteScan(fake.db, caller, "s9")).toMatchObject({ kind: "not_found" });
        fake.done();
    });

    it("validates an update and reports failures", async () => {
        const fake = scriptedDb([
            { table: "regulatory_scans", data: { ...otherScan, user_id: "u1" } },
            { table: "regulatory_scans", data: { ...otherScan, user_id: "u1" } },
            { table: "regulatory_scans", error: { message: "x" } },
            { table: "regulatory_scans", error: { message: "x" } },
            { table: "regulatory_scans", error: { message: "x" } },
        ]);
        expect(await updateScan(fake.db, caller, "s9", { name: "" })).toMatchObject({ kind: "validation" });
        expect(await updateScan(fake.db, caller, "s9", {})).toMatchObject({ kind: "validation" });
        expect(await updateScan(fake.db, caller, "s9", { enabled: true })).toMatchObject({ kind: "error" });
        expect(await runScanNow(fake.db, caller, "s9")).toMatchObject({ kind: "error" });
        expect(await deleteScan(fake.db, caller, "s9")).toMatchObject({ kind: "error" });
        fake.done();
    });

    it("deletes a scan the caller owns, and reports a failed run or write", async () => {
        const mine = { ...otherScan, user_id: "u1" };
        const fake = scriptedDb([
            { table: "regulatory_scans", data: mine },
            { table: "regulatory_scans", op: "delete" },
            { table: "regulatory_scans", data: mine },
            { table: "regulatory_scans", data: mine },
            { table: "regulatory_scans", op: "update", error: { message: "x" } },
            { table: "regulatory_scans", data: mine },
            { table: "regulatory_scans", op: "delete", error: { message: "x" } },
        ]);
        expect(await deleteScan(fake.db, caller, "s9")).toEqual({ ok: true, data: null });
        dbq.enqueueDbJob.mockRejectedValueOnce(new Error("down"));
        expect(await runScanNow(fake.db, caller, "s9")).toMatchObject({ kind: "error" });
        expect(await updateScan(fake.db, caller, "s9", { enabled: true })).toMatchObject({ kind: "error" });
        expect(await deleteScan(fake.db, caller, "s9")).toMatchObject({ kind: "error" });
        fake.done();
    });
});

describe("changes", () => {
    const listSteps = (rows: unknown[]) => [
        { table: "org_members", data: [{ org_id: "o1" }] },
        { table: "regulatory_scans", data: [orgScan] },
        { table: "regulatory_changes", data: rows },
        { table: "projects", data: [{ id: "p1", name: "MSA Exchange", counterparty: "X" }] },
    ];

    it("orders by consequence and never names a contract the reader cannot open", async () => {
        const rows = [
            change({ id: "low", impact: "baixo", published_at: "2026-10-20" }),
            change({ id: "high" }),
            change({ id: "med", impact: "medio", starred: true, status: "lida" }),
            change({ id: "old", status: "arquivada" }),
        ];
        const fake = scriptedDb(listSteps(rows));
        const result = await listChanges(fake.db, caller, {});
        if (!result.ok) throw new Error("expected ok");
        expect(result.data.changes.map((c) => c.id)).toEqual(["high", "med", "low"]);
        expect(result.data.tabs).toEqual({ todas: 3, nao_lidas: 2, favoritas: 1, arquivadas: 1 });
        expect(result.data.changes[0].affected).toEqual([
            { project_id: "p1", name: "MSA Exchange", counterparty: "X", term: "ativos virtuais", quote: "…ativos virtuais…" },
        ]);
        expect(result.data.changes[0].affected_hidden).toBe(1);
        expect(fake.calls[3].filters).toContainEqual(["in", "id", ["p1"]]);
        fake.done();
    });

    it("filters by tab, search and scan", async () => {
        const rows = [change({ id: "a", starred: true }), change({ id: "b", title: "Circular Pix" }), change({ id: "z", status: "arquivada" })];
        for (const [query, expected] of [
            [{ tab: "favoritas" }, ["a"]],
            [{ tab: "nao_lidas", q: "pix" }, ["b"]],
            [{ tab: "arquivadas" }, ["z"]],
            [{ tab: "qualquer", scan_id: "s1" }, ["a", "b"]],
        ] as const) {
            const fake = scriptedDb(listSteps(rows));
            const result = await listChanges(fake.db, caller, query);
            if (!result.ok) throw new Error("expected ok");
            expect(result.data.changes.map((c) => c.id)).toEqual(expected);
        }
    });

    it("refuses a scan the caller does not see, and is empty without scans", async () => {
        const fake = scriptedDb([
            { table: "org_members", data: [] },
            { table: "regulatory_scans", data: [] },
            { table: "org_members", data: [] },
            { table: "regulatory_scans", data: [] },
        ]);
        expect(await listChanges(fake.db, caller, { scan_id: "s9" })).toMatchObject({ kind: "not_found" });
        expect(await listChanges(fake.db, caller, {})).toEqual({
            ok: true,
            data: { changes: [], tabs: { todas: 0, nao_lidas: 0, favoritas: 0, arquivadas: 0 } },
        });
        fake.done();
    });

    it("skips the project lookup when no affected contract is visible, and reports read errors", async () => {
        access.listAccessibleProjectIds.mockResolvedValue([]);
        const fake = scriptedDb(listSteps([change()]).slice(0, 3));
        const result = await listChanges(fake.db, caller, {});
        expect(result).toMatchObject({ ok: true, data: { changes: [{ affected: [], affected_hidden: 2 }] } });
        fake.done();

        const noAffected = scriptedDb(listSteps([change({ affected: null })]).slice(0, 3));
        expect(await listChanges(noAffected.db, caller, {})).toMatchObject({ ok: true });
        noAffected.done();

        access.listAccessibleProjectIds.mockResolvedValue(["p1"]);
        const errors = [
            scriptedDb([{ table: "org_members", error: { message: "x" } }]),
            scriptedDb([...listSteps([]).slice(0, 2), { table: "regulatory_changes", error: { message: "x" } }]),
            scriptedDb([...listSteps([change()]).slice(0, 3), { table: "projects", error: { message: "x" } }]),
        ];
        for (const e of errors) expect(await listChanges(e.db, caller, {})).toMatchObject({ ok: false, kind: "error" });
    });

    const loadSteps = (row: unknown) => [
        { table: "regulatory_changes", data: row },
        { table: "regulatory_scans", data: orgScan },
    ];

    it("triages: archive records who decided, star toggles", async () => {
        access.getOrgRole.mockResolvedValue("member");
        const fake = scriptedDb([
            ...loadSteps(change()),
            { table: "regulatory_changes", op: "update", data: change({ status: "arquivada", starred: true }) },
            { table: "projects", data: [{ id: "p1", name: "MSA", counterparty: null }] },
        ]);
        const result = await updateChange(fake.db, caller, "c1", { status: "arquivada", starred: true });
        expect(result).toMatchObject({ ok: true, data: { status: "arquivada" } });
        expect(fake.calls[2].payload).toMatchObject({ status: "arquivada", starred: true, decided_by: "ana@avenia.io" });
        fake.done();
    });

    it("validates triage and hides changes of scans the caller cannot see", async () => {
        access.getOrgRole.mockResolvedValue(null);
        const fake = scriptedDb([
            ...loadSteps(change()),
            { table: "regulatory_changes", data: null },
        ]);
        expect(await updateChange(fake.db, caller, "c1", { status: "lida" })).toMatchObject({ kind: "not_found" });
        expect(await updateChange(fake.db, caller, "c0", {})).toMatchObject({ kind: "not_found" });
        fake.done();
        access.getOrgRole.mockResolvedValue("member");
        const bad = scriptedDb([...loadSteps(change()), ...loadSteps(change())]);
        expect(await updateChange(bad.db, caller, "c1", { status: "talvez" })).toMatchObject({ kind: "validation" });
        expect(await updateChange(bad.db, caller, "c1", {})).toMatchObject({ kind: "validation" });
        bad.done();
    });

    it("reports triage failures", async () => {
        access.getOrgRole.mockResolvedValue("member");
        const read = scriptedDb([{ table: "regulatory_changes", error: { message: "x" } }]);
        expect(await updateChange(read.db, caller, "c1", { status: "lida" })).toMatchObject({ kind: "error" });
        const write = scriptedDb([...loadSteps(change()), { table: "regulatory_changes", op: "update", error: { message: "x" } }]);
        expect(await updateChange(write.db, caller, "c1", { status: "lida" })).toMatchObject({ kind: "error" });
        const resolve = scriptedDb([
            ...loadSteps(change()),
            { table: "regulatory_changes", op: "update", data: change() },
            { table: "projects", error: { message: "x" } },
        ]);
        expect(await updateChange(resolve.db, caller, "c1", { starred: true })).toMatchObject({ kind: "error" });
    });
});

describe("one-click actions", () => {
    const loadSteps = (row: unknown) => [
        { table: "regulatory_changes", data: row },
        { table: "regulatory_scans", data: orgScan },
    ];

    beforeEach(() => access.getOrgRole.mockResolvedValue("member"));

    it("turns a change into a request on the pipeline, owned by the team", async () => {
        projects.createProject.mockResolvedValue({ ok: true, project: { id: "pnew" } });
        contracts.updatePipelineCard.mockResolvedValue({ ok: true, data: { id: "pnew" } });
        const fake = scriptedDb([
            ...loadSteps(change()),
            { table: "regulatory_changes", op: "update", data: change({ request_project_id: "pnew", status: "lida" }) },
            { table: "projects", data: [] },
        ]);
        const result = await createRequestFromChange(fake.db, caller, "c1", { assignee_email: "duda@avenia.io" });
        expect(result).toMatchObject({ ok: true, data: { project_id: "pnew" } });
        expect(projects.createProject).toHaveBeenCalledWith(fake.db, {
            userId: "u1",
            name: "Regulatório: Resolução BCB nº 999",
            practice: "Regulatório",
            org_id: "o1",
            visibility: "organization",
        });
        expect(contracts.updatePipelineCard).toHaveBeenCalledWith(fake.db, caller, "pnew", {
            lane: "entrada",
            status: "a_fazer",
            priority: "alta",
            deadline: "2027-01-26",
            requester_name: "Agente regulatório",
            assignee_email: "duda@avenia.io",
        });
        expect(contracts.recordCardEvent).toHaveBeenCalledWith(fake.db, expect.objectContaining({
            projectId: "pnew",
            actorType: "agent",
            actorName: "Agente regulatório",
            onBehalfOf: "ana@avenia.io",
            action: "request.created",
            after: expect.objectContaining({ origin: "regulatory", url: "https://bcb/999", affected: 2 }),
        }));
        expect(fake.calls[2].payload).toMatchObject({ request_project_id: "pnew", status: "lida" });
        fake.done();
    });

    it("refuses a second request and reports failures on the way", async () => {
        const dup = scriptedDb(loadSteps(change({ request_project_id: "p0" })));
        expect(await createRequestFromChange(dup.db, caller, "c1", {})).toMatchObject({ kind: "conflict" });

        projects.createProject.mockResolvedValueOnce({ ok: false, kind: "validation", detail: "no" });
        const invalid = scriptedDb(loadSteps(change({ status: "lida" })));
        expect(await createRequestFromChange(invalid.db, caller, "c1", {})).toMatchObject({ kind: "validation" });

        projects.createProject.mockResolvedValueOnce({ ok: false, kind: "db_error", error: new Error("x") });
        const dbErr = scriptedDb(loadSteps(change()));
        expect(await createRequestFromChange(dbErr.db, caller, "c1", {})).toMatchObject({ kind: "error" });

        projects.createProject.mockResolvedValue({ ok: true, project: { id: "pnew" } });
        contracts.updatePipelineCard.mockResolvedValueOnce({ ok: false, kind: "forbidden", detail: "no" });
        const card = scriptedDb(loadSteps(change()));
        expect(await createRequestFromChange(card.db, caller, "c1", {})).toMatchObject({ kind: "forbidden" });

        contracts.updatePipelineCard.mockResolvedValue({ ok: true, data: {} });
        const write = scriptedDb([...loadSteps(change()), { table: "regulatory_changes", op: "update", error: { message: "x" } }]);
        expect(await createRequestFromChange(write.db, caller, "c1", {})).toMatchObject({ kind: "error" });

        const resolve = scriptedDb([
            ...loadSteps(change()),
            { table: "regulatory_changes", op: "update", data: change() },
            { table: "projects", error: { message: "x" } },
        ]);
        expect(await createRequestFromChange(resolve.db, caller, "c1", {})).toMatchObject({ kind: "error" });

        const missing = scriptedDb([{ table: "regulatory_changes", data: null }]);
        expect(await createRequestFromChange(missing.db, caller, "c0", {})).toMatchObject({ kind: "not_found" });
        const readErr = scriptedDb([{ table: "regulatory_changes", error: { message: "x" } }]);
        expect(await createRequestFromChange(readErr.db, caller, "c0", {})).toMatchObject({ kind: "error" });
    });

    it("creates a personal request at medium priority when the scan is personal", async () => {
        projects.createProject.mockResolvedValue({ ok: true, project: { id: "pnew" } });
        contracts.updatePipelineCard.mockResolvedValue({ ok: true, data: {} });
        const fake = scriptedDb([
            { table: "regulatory_changes", data: change({ impact: "medio", effective_date: null, url: null, affected: null }) },
            { table: "regulatory_scans", data: { ...otherScan, user_id: "u1" } },
            { table: "regulatory_changes", op: "update", data: change() },
            { table: "projects", data: [] },
        ]);
        await createRequestFromChange(fake.db, caller, "c1", {});
        expect(projects.createProject).toHaveBeenCalledWith(fake.db, expect.objectContaining({ org_id: null, visibility: undefined }));
        expect(contracts.updatePipelineCard.mock.calls[0][3]).toMatchObject({ priority: "media", assignee_email: null });
    });

    it("puts the date the rule takes effect on the deadline radar", async () => {
        contracts.createObligation.mockResolvedValue({ ok: true, data: { id: "ob1" } });
        const fake = scriptedDb([
            ...loadSteps(change()),
            { table: "regulatory_changes", op: "update", data: change({ obligation_id: "ob1" }) },
            { table: "projects", data: [] },
        ]);
        expect(await createObligationFromChange(fake.db, caller, "c1", {})).toMatchObject({ ok: true, data: { obligation_id: "ob1" } });
        expect(contracts.createObligation).toHaveBeenCalledWith(fake.db, caller, {
            title: "Vigência: Resolução BCB nº 999",
            due_date: "2027-02-02",
            mark: "critico",
            note: "Fonte oficial: https://bcb/999",
            source_quote: "ativos virtuais",
        });
        fake.done();
    });

    it("asks for a date when the act does not state one, and accepts the one given", async () => {
        const noDate = scriptedDb(loadSteps(change({ effective_date: null })));
        expect(await createObligationFromChange(noDate.db, caller, "c1", {})).toMatchObject({ kind: "validation" });

        contracts.createObligation.mockResolvedValue({ ok: true, data: { id: "ob2" } });
        const given = scriptedDb([
            ...loadSteps(change({ effective_date: null, impact: "medio", url: null, status: "lida" })),
            { table: "regulatory_changes", op: "update", data: change() },
            { table: "projects", data: [] },
        ]);
        await createObligationFromChange(given.db, caller, "c1", { due_date: "2026-12-01" });
        expect(contracts.createObligation.mock.calls[0][2]).toMatchObject({ due_date: "2026-12-01", mark: "tarefa", note: null });
    });

    it("refuses a second deadline and reports failures on the way", async () => {
        const dup = scriptedDb(loadSteps(change({ obligation_id: "ob0" })));
        expect(await createObligationFromChange(dup.db, caller, "c1", {})).toMatchObject({ kind: "conflict" });
        contracts.createObligation.mockResolvedValueOnce({ ok: false, kind: "validation", detail: "x" });
        const invalid = scriptedDb(loadSteps(change()));
        expect(await createObligationFromChange(invalid.db, caller, "c1", {})).toMatchObject({ kind: "validation" });
        contracts.createObligation.mockResolvedValue({ ok: true, data: { id: "ob1" } });
        const write = scriptedDb([...loadSteps(change()), { table: "regulatory_changes", op: "update", error: { message: "x" } }]);
        expect(await createObligationFromChange(write.db, caller, "c1", {})).toMatchObject({ kind: "error" });
        const resolve = scriptedDb([
            ...loadSteps(change()),
            { table: "regulatory_changes", op: "update", data: change() },
            { table: "projects", error: { message: "x" } },
        ]);
        expect(await createObligationFromChange(resolve.db, caller, "c1", {})).toMatchObject({ kind: "error" });
        const missing = scriptedDb([{ table: "regulatory_changes", data: null }]);
        expect(await createObligationFromChange(missing.db, caller, "c0", {})).toMatchObject({ kind: "not_found" });
        const readErr = scriptedDb([{ table: "regulatory_changes", error: { message: "x" } }]);
        expect(await createObligationFromChange(readErr.db, caller, "c0", {})).toMatchObject({ kind: "error" });
    });

    it("sets the request deadline a week before the rule takes effect", () => {
        expect(requestDeadline("2027-02-02", "2026-10-20")).toBe("2027-01-26");
        expect(requestDeadline("2026-10-23", "2026-10-20")).toBe("2026-10-23");
        expect(requestDeadline(null, "2026-10-20")).toBe("2026-11-03");
        expect(requestDeadline("2026-01-01", "2026-10-20")).toBe("2026-11-03");
    });
});
