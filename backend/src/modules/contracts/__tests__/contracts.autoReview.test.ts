import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const access = vi.hoisted(() => ({
    checkProjectAccess: vi.fn(),
    listAccessibleProjectIds: vi.fn(),
}));
vi.mock("../../../lib/access", () => access);
const enqueue = vi.hoisted(() => ({ enqueueDbJob: vi.fn() }));
vi.mock("../../../lib/dbq/enqueue", () => enqueue);
const playbooks = vi.hoisted(() => ({ startPlaybookReview: vi.fn() }));
vi.mock("../../playbooks/playbooks.service", () => playbooks);
const settings = vi.hoisted(() => ({
    getUserModelSettings: vi.fn(async () => ({
        tabular_model: "mock-model",
        last_selected_chat_model: null,
        api_keys: {},
    })),
}));
vi.mock("../../user/user.service", () => settings);
const terms = vi.hoisted(() => ({ extractTermsForAgent: vi.fn() }));
vi.mock("../contracts.terms", async (actual) => ({
    ...(await actual<typeof import("../contracts.terms")>()),
    ...terms,
}));

import {
    createWatchedFolder,
    getLatestReview,
    handleAutoReview,
    listWatchedFolders,
    markAutoReviewFailed,
    requestReview,
    scanWatchedFolders,
    updateContractReview,
    watchProject,
} from "../contracts.service";
import { tallyFindings, termsSummary } from "../contracts.autoReview";
import type { DbJob } from "../../../lib/dbq/types";

const caller = { userId: "u", userEmail: "u@example.com" };
const role = (projectRole: string, project: Record<string, unknown> = {}) => ({
    ok: true,
    isCreator: false,
    orgRole: null,
    projectRole,
    project,
});
const job = (overrides: Partial<DbJob> = {}): DbJob => ({
    id: "j1",
    kind: "contracts.auto_review",
    payload: { reviewId: "r1" },
    status: "running",
    attempts: 1,
    max_attempts: 3,
    run_at: "",
    claimed_at: null,
    finished_at: null,
    last_error: null,
    dedupe_key: null,
    result: null,
    created_at: "",
    ...overrides,
});
const reviewRow = {
    id: "r1",
    org_id: "o1",
    project_id: "p1",
    document_id: "d1",
    version_id: "v1",
    playbook_id: "pb1",
    requested_by: "u",
    status: "queued",
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    enqueue.enqueueDbJob.mockResolvedValue({ id: "job", deduped: false });
});

describe("tallyFindings and termsSummary", () => {
    it("counts findings into the three lights", () => {
        expect(
            tallyFindings([
                { status: "acceptable" },
                { status: "needs_review" },
                { status: "unacceptable" },
                { status: "missing_required" },
                { status: "not_applicable" },
            ]),
        ).toEqual({ aligned: 1, needs_review: 1, deviates: 2 });
    });

    it("summarises the terms in Portuguese, or says what is missing", () => {
        expect(termsSummary(null)).toMatch(/Não consegui/);
        expect(
            termsSummary({
                term_end: "2027-01-10",
                notice_deadline: "2026-10-12",
                auto_renewal: true,
                penalty_value: "20%",
            }),
        ).toBe("Vence em 10/01/2027; renova automaticamente; aviso de não renovação até 12/10/2026; multa: 20%.");
        expect(
            termsSummary({ term_end: null, notice_deadline: null, auto_renewal: false, penalty_value: null }),
        ).toMatch(/nenhum prazo/);
    });
});

describe("watched folders", () => {
    it("validates a new folder", async () => {
        const fake = scriptedDb([]);
        expect(await createWatchedFolder(fake.db, caller, {})).toMatchObject({ kind: "validation" });
        expect(await createWatchedFolder(fake.db, caller, { name: "x".repeat(201) })).toMatchObject({
            kind: "validation",
        });
        expect(await createWatchedFolder(fake.db, caller, { name: "A", source: "box" })).toMatchObject({
            kind: "validation",
        });
        expect(
            await createWatchedFolder(fake.db, caller, { name: "A", default_assignee_email: "nope" }),
        ).toMatchObject({ kind: "validation" });
        fake.done();
    });

    it("creates a folder with a normalized assignee, and maps errors", async () => {
        const fake = scriptedDb([
            { table: "watched_folders", op: "insert", data: { id: "f1", name: "Fornecedores" } },
            { table: "watched_folders", op: "insert", error: { message: "x" } },
        ]);
        const result = await createWatchedFolder(fake.db, caller, {
            name: " Fornecedores ",
            source: "drive",
            drive_folder_id: "abc",
            default_assignee_email: "Duda@Example.com",
        });
        expect(result).toMatchObject({ ok: true, data: { id: "f1" } });
        expect(fake.calls[0].payload).toMatchObject({
            name: "Fornecedores",
            source: "drive",
            created_by: "u",
            default_assignee_email: "duda@example.com",
        });
        expect(await createWatchedFolder(fake.db, caller, { name: "B" })).toMatchObject({ kind: "error" });
        fake.done();
    });

    it("lists the caller's folders and those holding cards they can see, with counts", async () => {
        access.listAccessibleProjectIds.mockResolvedValue(["p1", "p2"]);
        const fake = scriptedDb([
            { table: "projects", data: [{ watched_folder_id: "f1" }, { watched_folder_id: "f1" }] },
            { table: "watched_folders", data: [{ id: "f1" }, { id: "f2" }] },
        ]);
        const result = await listWatchedFolders(fake.db, caller);
        expect(result).toMatchObject({ ok: true, data: [{ id: "f1", contracts: 2 }, { id: "f2", contracts: 0 }] });
        expect(fake.calls[1].filters).toContainEqual(["or", "created_by.eq.u,id.in.(f1)"]);
        fake.done();
    });

    it("lists only the caller's own folders when no visible card is watched", async () => {
        access.listAccessibleProjectIds.mockResolvedValue([]);
        const fake = scriptedDb([{ table: "watched_folders", data: null }]);
        expect(await listWatchedFolders(fake.db, caller)).toEqual({ ok: true, data: [] });
        expect(fake.calls[0].filters).toContainEqual(["or", "created_by.eq.u"]);
        fake.done();
    });

    it("maps list failures", async () => {
        access.listAccessibleProjectIds.mockRejectedValueOnce(new Error("x"));
        expect(await listWatchedFolders(scriptedDb([]).db, caller)).toMatchObject({ kind: "error" });
        access.listAccessibleProjectIds.mockResolvedValue(["p1"]);
        const fake = scriptedDb([
            { table: "projects", error: { message: "x" } },
            { table: "projects", data: [] },
            { table: "watched_folders", error: { message: "y" } },
        ]);
        expect(await listWatchedFolders(fake.db, caller)).toMatchObject({ kind: "error" });
        expect(await listWatchedFolders(fake.db, caller)).toMatchObject({ kind: "error" });
        fake.done();
    });

    it("puts an editable card in a folder, on the board, and logs it", async () => {
        access.checkProjectAccess.mockResolvedValue(role("editor", { lane: null }));
        const fake = scriptedDb([
            { table: "watched_folders", data: { id: "f1", name: "Fornecedores", org_id: "o1" } },
            { table: "projects", op: "update" },
            { table: "card_events", op: "insert", data: { id: 1 } },
        ]);
        expect(await watchProject(fake.db, caller, "f1", "p1")).toEqual({
            ok: true,
            data: { project_id: "p1", watched_folder_id: "f1" },
        });
        expect(fake.calls[1].payload).toMatchObject({ watched_folder_id: "f1", lane: "triagem" });
        expect(fake.calls[2].payload).toMatchObject({ action: "folder.watched", after: { folder: "Fornecedores" } });
        fake.done();
    });

    it("refuses viewers, unknown folders, and maps failures", async () => {
        access.checkProjectAccess.mockResolvedValue(role("viewer"));
        expect(await watchProject(scriptedDb([]).db, caller, "f1", "p1")).toMatchObject({ kind: "forbidden" });
        access.checkProjectAccess.mockResolvedValue(role("editor", { lane: "revisao" }));
        const fake = scriptedDb([
            { table: "watched_folders", data: null },
            { table: "watched_folders", error: { message: "x" } },
            { table: "watched_folders", data: { id: "f1", name: "F", org_id: null } },
            { table: "projects", op: "update", error: { message: "y" } },
        ]);
        expect(await watchProject(fake.db, caller, "f1", "p1")).toMatchObject({ kind: "not_found" });
        expect(await watchProject(fake.db, caller, "f1", "p1")).toMatchObject({ kind: "error" });
        expect(await watchProject(fake.db, caller, "f1", "p1")).toMatchObject({ kind: "error" });
        expect(fake.calls[3].payload).toMatchObject({ lane: "revisao" });
        fake.done();
    });
});

describe("scanWatchedFolders", () => {
    const folder = { id: "f1", org_id: "o1", playbook_id: "pb1", default_assignee_email: "ana@x.com", created_by: "u" };

    it("queues one review per new uploaded version and logs it", async () => {
        const fake = scriptedDb([
            { table: "watched_folders", data: [folder] },
            { table: "projects", data: [{ id: "p1", user_id: "u", assignee_email: null }] },
            { table: "documents", data: [{ id: "d1", project_id: "p1" }] },
            {
                table: "document_versions",
                data: [
                    { id: "v1", document_id: "d1", filename: "NDA.docx", source: "upload", created_at: "" },
                    { id: "v0", document_id: "d1", filename: "old.docx", source: "upload", created_at: "" },
                    { id: "v2", document_id: "d1", filename: "dup.docx", source: "upload", created_at: "" },
                ],
            },
            { table: "contract_reviews", data: [{ version_id: "v0" }] },
            { table: "contract_reviews", op: "insert", data: { id: "r1" } },
            { table: "card_events", op: "insert", data: { id: 1 } },
            { table: "contract_reviews", op: "insert", error: { code: "23505" } },
            { table: "watched_folders", op: "update" },
        ]);
        expect(await scanWatchedFolders(fake.db)).toEqual({ queued: 1 });
        expect(fake.calls[3].filters).toContainEqual(["in", "source", ["upload", "user_upload"]]);
        expect(fake.calls[5].payload).toMatchObject({
            version_id: "v1",
            playbook_id: "pb1",
            requested_by: "u",
            assignee_email: "ana@x.com",
            status: "queued",
        });
        expect(enqueue.enqueueDbJob).toHaveBeenCalledWith(fake.db, {
            kind: "contracts.auto_review",
            payload: { reviewId: "r1" },
            dedupeKey: "contracts.auto_review:v1",
            maxAttempts: 3,
        });
        expect(fake.calls[6].payload).toMatchObject({ action: "review.started", actor_type: "agent" });
        fake.done();
    });

    it("stops early when a folder has no cards, documents or new versions", async () => {
        const fake = scriptedDb([
            { table: "watched_folders", data: [folder, folder, folder, { ...folder, created_by: null }] },
            { table: "projects", data: [] },
            { table: "watched_folders", op: "update" },
            { table: "projects", data: [{ id: "p1", user_id: null, assignee_email: null }] },
            { table: "documents", data: [] },
            { table: "watched_folders", op: "update" },
            { table: "projects", data: [{ id: "p1", user_id: null, assignee_email: null }] },
            { table: "documents", data: [{ id: "d1", project_id: "p1" }] },
            { table: "document_versions", data: [] },
            { table: "watched_folders", op: "update" },
            { table: "projects", data: [{ id: "p1", user_id: null, assignee_email: "x@y.z" }] },
            { table: "documents", data: [{ id: "d1", project_id: "p1" }] },
            { table: "document_versions", data: [{ id: "v1", document_id: "d1", filename: null, source: "upload", created_at: "" }] },
            { table: "contract_reviews", data: [] },
            { table: "watched_folders", op: "update" },
        ]);
        // The last folder has no creator and its card no owner: nobody to run as.
        expect(await scanWatchedFolders(fake.db)).toEqual({ queued: 0 });
        fake.done();
    });

    it("throws on read failures so the sweep logs them", async () => {
        for (const step of [
            [{ table: "watched_folders", error: { message: "a" } }],
            [{ table: "watched_folders", data: [folder] }, { table: "projects", error: { message: "b" } }],
            [
                { table: "watched_folders", data: [folder] },
                { table: "projects", data: [{ id: "p1", user_id: "u", assignee_email: null }] },
                { table: "documents", error: { message: "c" } },
            ],
            [
                { table: "watched_folders", data: [folder] },
                { table: "projects", data: [{ id: "p1", user_id: "u", assignee_email: null }] },
                { table: "documents", data: [{ id: "d1", project_id: "p1" }] },
                { table: "document_versions", error: { message: "d" } },
            ],
            [
                { table: "watched_folders", data: [folder] },
                { table: "projects", data: [{ id: "p1", user_id: "u", assignee_email: null }] },
                { table: "documents", data: [{ id: "d1", project_id: "p1" }] },
                { table: "document_versions", data: [{ id: "v1", document_id: "d1", filename: null, source: "upload", created_at: "" }] },
                { table: "contract_reviews", error: { message: "e" } },
            ],
            [
                { table: "watched_folders", data: [folder] },
                { table: "projects", data: [{ id: "p1", user_id: "u", assignee_email: null }] },
                { table: "documents", data: [{ id: "d1", project_id: "p1" }] },
                { table: "document_versions", data: [{ id: "v1", document_id: "d1", filename: null, source: "upload", created_at: "" }] },
                { table: "contract_reviews", data: null },
                { table: "contract_reviews", op: "insert", error: { message: "f" } },
            ],
        ]) {
            await expect(scanWatchedFolders(scriptedDb(step).db)).rejects.toBeTruthy();
        }
    });
});

describe("requestReview", () => {
    it("re-opens the latest version's review and queues it", async () => {
        access.checkProjectAccess.mockResolvedValue(role("editor"));
        const fake = scriptedDb([
            { table: "documents", data: [{ id: "d1", current_version_id: "v9", org_id: "o1" }] },
            {
                table: "projects",
                data: {
                    watched_folder_id: "f1",
                    assignee_email: null,
                    watched_folders: { playbook_id: "pb1", default_assignee_email: "ana@x.com" },
                },
            },
            { table: "contract_reviews", op: "upsert", data: { id: "r9" } },
        ]);
        expect(await requestReview(fake.db, caller, "p1")).toEqual({
            ok: true,
            data: { review_id: "r9", queued: true },
        });
        expect(fake.calls[2].payload).toMatchObject({
            version_id: "v9",
            playbook_id: "pb1",
            assignee_email: "ana@x.com",
            status: "queued",
            decided_at: null,
        });
        fake.done();
    });

    it("works for a card outside any folder and reports a deduped job", async () => {
        access.checkProjectAccess.mockResolvedValue(role("editor"));
        enqueue.enqueueDbJob.mockResolvedValueOnce({ id: null, deduped: true });
        const fake = scriptedDb([
            { table: "documents", data: [{ id: "d1", current_version_id: "v9", org_id: null }] },
            { table: "projects", data: { watched_folder_id: null, assignee_email: "me@x.com", watched_folders: null } },
            { table: "contract_reviews", op: "upsert", data: { id: "r9" } },
        ]);
        expect(await requestReview(fake.db, caller, "p1")).toMatchObject({ data: { queued: false } });
        expect(fake.calls[2].payload).toMatchObject({ playbook_id: null, assignee_email: "me@x.com" });
        fake.done();
    });

    it("refuses a card without documents and maps every failure", async () => {
        access.checkProjectAccess.mockResolvedValue(role("viewer"));
        expect(await requestReview(scriptedDb([]).db, caller, "p1")).toMatchObject({ kind: "forbidden" });
        access.checkProjectAccess.mockResolvedValue(role("editor"));
        const docs = { table: "documents", data: [{ id: "d1", current_version_id: "v9", org_id: null }] };
        const card = { table: "projects", data: { watched_folder_id: null, assignee_email: null, watched_folders: null } };
        const fake = scriptedDb([
            { table: "documents", data: [] },
            { table: "documents", error: { message: "a" } },
            docs,
            { table: "projects", error: { message: "b" } },
            docs,
            card,
            { table: "contract_reviews", op: "upsert", error: { message: "c" } },
            docs,
            card,
            { table: "contract_reviews", op: "upsert", data: { id: "r" } },
        ]);
        expect(await requestReview(fake.db, caller, "p1")).toMatchObject({ kind: "validation", code: "no_document" });
        expect(await requestReview(fake.db, caller, "p1")).toMatchObject({ kind: "error" });
        expect(await requestReview(fake.db, caller, "p1")).toMatchObject({ kind: "error" });
        expect(await requestReview(fake.db, caller, "p1")).toMatchObject({ kind: "error" });
        enqueue.enqueueDbJob.mockRejectedValueOnce(new Error("queue down"));
        expect(await requestReview(fake.db, caller, "p1")).toMatchObject({ kind: "error" });
        fake.done();
    });
});

describe("handleAutoReview", () => {
    it("reads the Ficha, runs the playbook and leaves the review ready", async () => {
        terms.extractTermsForAgent.mockResolvedValue({ sources: { term_end: "x", notice_days: "y" } });
        playbooks.startPlaybookReview.mockResolvedValue({
            run: { id: "pr1" },
            done: Promise.resolve({
                summary: "3 desvios",
                findings: [
                    { status: "acceptable", quote: "a" },
                    { status: "unacceptable", quote: "" },
                    { status: "needs_review", quote: "c" },
                ],
            }),
        });
        const fake = scriptedDb([
            { table: "contract_reviews", data: reviewRow },
            { table: "agent_runs", op: "insert", data: { id: "run1" } },
            { table: "contract_reviews", op: "update" },
            { table: "contract_reviews", op: "update" }, // ficha
            { table: "contract_reviews", op: "update" }, // playbook
            { table: "contract_reviews", op: "update" }, // run id
            { table: "contract_reviews", op: "update" }, // ready
            { table: "agent_runs", op: "update" },
            { table: "document_versions", data: { filename: "NDA.docx" } },
            { table: "card_events", op: "insert", data: { id: 1 } },
        ]);
        expect(await handleAutoReview(fake.db, job())).toEqual({
            reviewId: "r1",
            aligned: 1,
            needs_review: 1,
            deviates: 1,
        });
        expect(playbooks.startPlaybookReview).toHaveBeenCalledWith(
            expect.objectContaining({ userId: "u", playbookId: "pb1", documentId: "d1", model: "mock-model" }),
        );
        expect(fake.calls[6].payload).toMatchObject({ status: "ready", summary: "3 desvios", deviates: 1 });
        expect(fake.calls[9].payload).toMatchObject({
            action: "review.completed",
            run_id: "run1",
            after: { document: "NDA.docx", sources: 4, playbook_run_id: "pr1" },
        });
        fake.done();
    });

    it("without a playbook, summarises the Ficha", async () => {
        terms.extractTermsForAgent.mockResolvedValue(null);
        const fake = scriptedDb([
            { table: "contract_reviews", data: { ...reviewRow, playbook_id: null } },
            { table: "agent_runs", op: "insert", data: { id: "run1" } },
            { table: "contract_reviews", op: "update" },
            { table: "contract_reviews", op: "update" },
            { table: "contract_reviews", op: "update" },
            { table: "agent_runs", op: "update" },
            { table: "document_versions", data: null },
            { table: "card_events", op: "insert", data: { id: 1 } },
        ]);
        await handleAutoReview(fake.db, job());
        expect(playbooks.startPlaybookReview).not.toHaveBeenCalled();
        expect(fake.calls[4].payload).toMatchObject({ summary: "Não consegui extrair a Ficha deste contrato." });
        expect(fake.calls[7].payload).toMatchObject({ after: { document: null, sources: 0 } });
        fake.done();
    });

    it("skips a finished review and refuses a missing or ownerless one", async () => {
        const fake = scriptedDb([
            { table: "contract_reviews", data: { ...reviewRow, status: "ready" } },
            { table: "contract_reviews", data: null },
            { table: "contract_reviews", data: { ...reviewRow, requested_by: null } },
            { table: "contract_reviews", error: { message: "x" } },
        ]);
        expect(await handleAutoReview(fake.db, job())).toEqual({ skipped: true });
        await expect(handleAutoReview(fake.db, job({ payload: {} }))).rejects.toMatchObject({
            name: "NonRetryableJobError",
        });
        await expect(handleAutoReview(fake.db, job())).rejects.toMatchObject({ name: "NonRetryableJobError" });
        await expect(handleAutoReview(fake.db, job())).rejects.toMatchObject({ message: "x" });
        fake.done();
    });

    it("puts a failed attempt back in the queue while retries remain", async () => {
        terms.extractTermsForAgent.mockRejectedValue(new Error("llm down"));
        const fake = scriptedDb([
            { table: "contract_reviews", data: reviewRow },
            { table: "agent_runs", op: "insert", data: { id: "run1" } },
            { table: "contract_reviews", op: "update" },
            { table: "contract_reviews", op: "update" },
            { table: "agent_runs", op: "update" },
            { table: "contract_reviews", op: "update" },
        ]);
        await expect(handleAutoReview(fake.db, job())).rejects.toThrow("llm down");
        expect(fake.calls[5].payload).toMatchObject({ status: "queued", error: null });
        fake.done();
    });

    it("fails for good on the last attempt, or at once without a model, and says why", async () => {
        terms.extractTermsForAgent.mockRejectedValue(new Error("llm down"));
        const last = scriptedDb([
            { table: "contract_reviews", data: reviewRow },
            { table: "agent_runs", op: "insert", data: { id: "run1" } },
            { table: "contract_reviews", op: "update" },
            { table: "contract_reviews", op: "update" },
            { table: "agent_runs", op: "update" },
            { table: "contract_reviews", op: "update" },
            { table: "card_events", op: "insert", data: { id: 2 } },
        ]);
        await expect(handleAutoReview(last.db, job({ attempts: 3 }))).rejects.toThrow();
        expect(last.calls[5].payload).toMatchObject({ status: "failed", error: "Não consegui ler este contrato. Tente de novo." });
        expect(last.calls[6].payload).toMatchObject({ action: "review.failed" });
        last.done();

        settings.getUserModelSettings.mockResolvedValueOnce({
            tabular_model: null,
            last_selected_chat_model: null,
            api_keys: {},
        });
        const noModel = scriptedDb([
            { table: "contract_reviews", data: reviewRow },
            { table: "agent_runs", op: "insert", data: { id: "run1" } },
            { table: "contract_reviews", op: "update" },
            { table: "agent_runs", op: "update" },
            { table: "contract_reviews", op: "update" },
            { table: "card_events", op: "insert", data: { id: 3 } },
        ]);
        await expect(handleAutoReview(noModel.db, job())).rejects.toMatchObject({ name: "NonRetryableJobError" });
        expect(noModel.calls[4].payload).toMatchObject({ status: "failed", error: expect.stringMatching(/modelo/) });
        noModel.done();
    });

    it("fails when a status write fails", async () => {
        const fake = scriptedDb([
            { table: "contract_reviews", data: reviewRow },
            { table: "agent_runs", op: "insert", data: { id: "run1" } },
            { table: "contract_reviews", op: "update", error: { message: "w" } },
        ]);
        await expect(handleAutoReview(fake.db, job())).rejects.toMatchObject({ message: "w" });
        fake.done();
    });

});

describe("markAutoReviewFailed", () => {
    it("marks a stuck review failed, and ignores a job without one", async () => {
        const fake = scriptedDb([{ table: "contract_reviews", op: "update" }]);
        await markAutoReviewFailed(fake.db, job());
        expect(fake.calls[0].filters).toContainEqual(["in", "status", ["queued", "running"]]);
        await markAutoReviewFailed(fake.db, job({ payload: {} }));
        fake.done();
    });
});

describe("updateContractReview", () => {
    const row = { id: "r1", project_id: "p1", org_id: null, status: "ready", assignee_email: null };

    it("accepts a ready review and logs it", async () => {
        access.checkProjectAccess.mockResolvedValue(role("editor"));
        const fake = scriptedDb([
            { table: "contract_reviews", data: row },
            { table: "contract_reviews", op: "update", data: { id: "r1", status: "done", assignee_email: null } },
            { table: "card_events", op: "insert", data: { id: 1 } },
        ]);
        expect(await updateContractReview(fake.db, caller, "r1", { status: "done" })).toMatchObject({
            ok: true,
            data: { status: "done" },
        });
        expect(fake.calls[1].payload).toMatchObject({ status: "done", decided_by: "u" });
        expect(fake.calls[2].payload).toMatchObject({ action: "review.accepted" });
        fake.done();
    });

    it("undoes an accept without logging it again", async () => {
        access.checkProjectAccess.mockResolvedValue(role("editor"));
        const fake = scriptedDb([
            { table: "contract_reviews", data: { ...row, status: "done" } },
            { table: "contract_reviews", op: "update", data: { id: "r1", status: "ready", assignee_email: null } },
        ]);
        expect((await updateContractReview(fake.db, caller, "r1", { status: "ready" })).ok).toBe(true);
        expect(fake.calls[1].payload).toMatchObject({ status: "ready", decided_by: null });
        fake.done();
    });

    it("assigns, mirrors the assignee onto the card and logs only a real change", async () => {
        access.checkProjectAccess.mockResolvedValue(role("editor"));
        const fake = scriptedDb([
            { table: "contract_reviews", data: row },
            { table: "contract_reviews", op: "update", data: { id: "r1", status: "ready", assignee_email: "duda@x.com" } },
            { table: "projects", op: "update" },
            { table: "card_events", op: "insert", data: { id: 1 } },
            { table: "contract_reviews", data: { ...row, assignee_email: "duda@x.com" } },
            { table: "contract_reviews", op: "update", data: { id: "r1", status: "ready", assignee_email: "duda@x.com" } },
            { table: "projects", op: "update" },
        ]);
        await updateContractReview(fake.db, caller, "r1", { assignee_email: "Duda@X.com" });
        expect(fake.calls[3].payload).toMatchObject({ action: "assignee.changed", after: "duda@x.com" });
        await updateContractReview(fake.db, caller, "r1", { assignee_email: "duda@x.com" });
        fake.done();
    });

    it("validates and refuses", async () => {
        access.checkProjectAccess.mockResolvedValue(role("editor"));
        const fake = scriptedDb([
            { table: "contract_reviews", data: null },
            { table: "contract_reviews", error: { message: "x" } },
            { table: "contract_reviews", data: { ...row, status: "running" } },
            { table: "contract_reviews", data: row },
            { table: "contract_reviews", data: row },
            { table: "contract_reviews", data: row },
            { table: "contract_reviews", data: row },
            { table: "contract_reviews", op: "update", error: { message: "y" } },
        ]);
        expect(await updateContractReview(fake.db, caller, "r1", {})).toMatchObject({ kind: "not_found" });
        expect(await updateContractReview(fake.db, caller, "r1", {})).toMatchObject({ kind: "error" });
        expect(await updateContractReview(fake.db, caller, "r1", { status: "done" })).toMatchObject({ kind: "conflict" });
        expect(await updateContractReview(fake.db, caller, "r1", { status: "x" })).toMatchObject({ kind: "validation" });
        expect(await updateContractReview(fake.db, caller, "r1", { assignee_email: "no" })).toMatchObject({
            kind: "validation",
        });
        expect(await updateContractReview(fake.db, caller, "r1", {})).toMatchObject({ kind: "validation" });
        expect(await updateContractReview(fake.db, caller, "r1", { assignee_email: null })).toMatchObject({
            kind: "error",
        });
        fake.done();
        access.checkProjectAccess.mockResolvedValue(role("viewer"));
        const viewer = scriptedDb([{ table: "contract_reviews", data: row }]);
        expect(await updateContractReview(viewer.db, caller, "r1", { status: "done" })).toMatchObject({
            kind: "forbidden",
        });
        viewer.done();
    });
});

describe("getLatestReview", () => {
    it("reads the newest review of a visible card", async () => {
        access.checkProjectAccess.mockResolvedValue(role("viewer"));
        const fake = scriptedDb([
            { table: "contract_reviews", data: { id: "r1" } },
            { table: "contract_reviews", data: null },
            { table: "contract_reviews", error: { message: "x" } },
        ]);
        expect(await getLatestReview(fake.db, caller, "p1")).toEqual({ ok: true, data: { id: "r1" } });
        expect(await getLatestReview(fake.db, caller, "p1")).toEqual({ ok: true, data: null });
        expect(await getLatestReview(fake.db, caller, "p1")).toMatchObject({ kind: "error" });
        fake.done();
        access.checkProjectAccess.mockResolvedValue({ ok: false });
        expect(await getLatestReview(scriptedDb([]).db, caller, "p1")).toMatchObject({ kind: "not_found" });
    });
});
