import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import type { DbJob } from "../../../lib/dbq/types";

const shared = vi.hoisted(() => ({ requireContractEdit: vi.fn(), contractDocument: vi.fn() }));
vi.mock("../contractReview.shared", async (actual) => ({
    ...(await actual<typeof import("../contractReview.shared")>()),
    ...shared,
}));
const fichaService = vi.hoisted(() => ({ contractText: vi.fn() }));
vi.mock("../contractReview.fichaService", () => fichaService);
const llm = vi.hoisted(() => ({ completeText: vi.fn() }));
vi.mock("../../../lib/llm", () => llm);
const enqueue = vi.hoisted(() => ({ enqueueDbJob: vi.fn(async () => ({ id: "job", deduped: false })) }));
vi.mock("../../../lib/dbq/enqueue", () => enqueue);
const playbooks = vi.hoisted(() => ({ findPlaybookForContractType: vi.fn(), startPlaybookReview: vi.fn() }));
vi.mock("../../playbooks/playbooks.service", () => playbooks);
const contracts = vi.hoisted(() => ({
    recordCardEvent: vi.fn(async () => 1),
    startAgentRun: vi.fn(async () => "run1"),
    finishAgentRun: vi.fn(async () => undefined),
}));
vi.mock("../../contracts/contracts.service", () => contracts);
const user = vi.hoisted(() => ({
    getUserModelSettings: vi.fn(async () => ({ tabular_model: null as string | null, last_selected_chat_model: null, api_keys: {} })),
}));
vi.mock("../../user/user.service", () => user);

import {
    ANALYSIS_READY_JOB,
    ANALYST_ANALYSIS_JOB,
    getAnalysisById,
    getLatestAnalysis,
    handleAnalystAnalysis,
    markAnalystAnalysisFailed,
    startAnalystAnalysis,
} from "../contractReview.service";

import { DEFAULT_ANALYSIS_MODEL } from "../contractReview.analysisService";

const caller = { userId: "u1", userEmail: "time@example.com" };
const ID = "11111111-2222-4333-8444-555555555555";
const REQ = "99999999-2222-4333-8444-555555555555";
const doc = { documentId: "d1", versionId: "v1", versionNumber: 1, filename: "Contrato.docx", fileType: "docx", storagePath: "s", isDocx: true };
const CONTRACT = "5.1 A Contratante pagará multa de 50% do valor total em caso de rescisão antecipada.";
const intake = [{ key: "proposito", label: "Motivo", value: "Suporte", source: "requester" }];
const job = (attempts = 1): DbJob => ({
    id: "j1", kind: ANALYST_ANALYSIS_JOB, payload: { analysisId: ID }, status: "running", attempts, max_attempts: 2,
    run_at: "", claimed_at: null, finished_at: null, last_error: null, dedupe_key: null, result: null, created_at: "",
});
const row = (extra: Record<string, unknown> = {}) => ({
    id: ID, org_id: "org-1", project_id: "p1", request_id: REQ, document_id: "d1", version_id: "v1",
    playbook_id: null, playbook_run_id: null, intake, model: null, status: "queued", result: null,
    dropped_citations: [], usage: null, error: null, requested_by: "u1", created_at: "2026-10-22", finished_at: null, ...extra,
});
const modelAnswer = JSON.stringify({
    executive_summary: { text: "Serviços.", object: "Serviços", parties: ["A", "B"], value: null },
    critical: [{ title: "Multa alta", quote: "pagará multa de 50% do valor total", clause: "cl. 5.1", rationale: "Alta.", rule_id: "multa" }],
    attention: [{ title: "Inventado", quote: "cláusula que não existe", rationale: "x" }],
    favorable: [],
    redlines: [{ clause: "cl. 5.1", from: "multa de 50% do valor total", to: "multa de 10% do saldo", why: "Proporção." }],
    compliance: { data_protection: "", confidentiality: "", governing_law_forum: "", term_termination_penalties: "" },
    open_points: [],
});

beforeEach(() => {
    vi.clearAllMocks();
    shared.requireContractEdit.mockResolvedValue({ ok: true, access: { project: { org_id: "org-1" } } });
    shared.contractDocument.mockResolvedValue(doc);
    fichaService.contractText.mockResolvedValue(CONTRACT);
    llm.completeText.mockResolvedValue(modelAnswer);
    playbooks.findPlaybookForContractType.mockResolvedValue(null);
});

describe("startAnalystAnalysis", () => {
    it("queues one analysis of the current version with the intake", async () => {
        const fake = scriptedDb([
            { table: "contract_analyses", data: null },
            { table: "contract_analyses", op: "insert", data: { id: ID } },
        ]);
        expect(await startAnalystAnalysis(fake.db, caller, "p1", { request_id: REQ, intake })).toEqual({
            ok: true,
            data: { analysis_id: ID, queued: true },
        });
        expect(fake.calls[1].payload).toMatchObject({ project_id: "p1", request_id: REQ, version_id: "v1", status: "queued", intake: [{ label: "Motivo", value: "Suporte" }] });
        expect(enqueue.enqueueDbJob).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: ANALYST_ANALYSIS_JOB, payload: { analysisId: ID } }));
        fake.done();
    });

    it("returns the analysis already under way for the same version, and retries a failed one", async () => {
        const same = scriptedDb([{ table: "contract_analyses", data: { id: ID, status: "done" } }]);
        expect(await startAnalystAnalysis(same.db, caller, "p1", { intake })).toEqual({ ok: true, data: { analysis_id: ID, queued: false } });
        expect(enqueue.enqueueDbJob).not.toHaveBeenCalled();

        const failed = scriptedDb([
            { table: "contract_analyses", data: { id: ID, status: "failed" } },
            { table: "contract_analyses", op: "update", data: { id: ID } },
        ]);
        expect(await startAnalystAnalysis(failed.db, caller, "p1", { intake })).toMatchObject({ ok: true, data: { queued: true } });
        expect(enqueue.enqueueDbJob).toHaveBeenCalledTimes(1);
    });

    it("refuses a malformed intake, a contract without a document, and people who cannot edit it", async () => {
        expect(await startAnalystAnalysis(scriptedDb([]).db, caller, "p1", { intake: [{ value: "x" }] })).toMatchObject({ ok: false, code: "invalid_intake" });
        shared.contractDocument.mockResolvedValueOnce(null);
        expect(await startAnalystAnalysis(scriptedDb([]).db, caller, "p1", { intake })).toMatchObject({ ok: false, code: "no_document" });
        shared.requireContractEdit.mockResolvedValueOnce({ ok: false, kind: "forbidden" });
        expect(await startAnalystAnalysis(scriptedDb([]).db, caller, "p1", { intake })).toMatchObject({ ok: false, kind: "forbidden" });
    });
});

describe("handleAnalystAnalysis", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });
    const runScript = () =>
        scriptedDb([
            { table: "contract_analyses", data: row() },
            { table: "contract_analyses", op: "update" }, // running
            { table: "projects", data: { contract_type: null } },
            { table: "contract_analyses", op: "update" }, // done or failed
        ]);

    it("runs on its own model: a profile set to Haiku for tabular reviews does not change it", async () => {
        user.getUserModelSettings.mockResolvedValue({ tabular_model: "claude-haiku-5-5", last_selected_chat_model: null, api_keys: {} });
        const fake = runScript();
        await handleAnalystAnalysis(fake.db, job());
        expect(llm.completeText).toHaveBeenCalledWith(expect.objectContaining({ model: DEFAULT_ANALYSIS_MODEL }));
        expect(fake.calls[3].payload).toMatchObject({ status: "done", model: DEFAULT_ANALYSIS_MODEL });

        vi.stubEnv("LEGAL_ANALYSIS_MODEL", " claude-opus-5-5 ");
        llm.completeText.mockClear();
        await handleAnalystAnalysis(runScript().db, job());
        expect(llm.completeText).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-opus-5-5" }));
        user.getUserModelSettings.mockResolvedValue({ tabular_model: null, last_selected_chat_model: null, api_keys: {} });
    });

    it("mends a small JSON slip without asking again", async () => {
        llm.completeText.mockResolvedValueOnce(`${modelAnswer.slice(0, -1)},}`);
        const fake = runScript();
        await handleAnalystAnalysis(fake.db, job());
        expect(llm.completeText).toHaveBeenCalledTimes(1);
        expect(fake.calls[3].payload).toMatchObject({ status: "done" });
    });

    it("asks once more after a cut-off answer, and counts both calls", async () => {
        llm.completeText.mockResolvedValueOnce(modelAnswer.slice(0, 300));
        const fake = runScript();
        await handleAnalystAnalysis(fake.db, job());
        expect(llm.completeText).toHaveBeenCalledTimes(2);
        expect(llm.completeText.mock.calls[1][0].user).toContain("a resposta anterior veio cortada");
        expect(fake.calls[3].payload).toMatchObject({ status: "done", usage: { calls: 2 } });
    });

    it("fails for good after two bad answers, keeping the reason and what the calls spent", async () => {
        llm.completeText.mockImplementation(async (params: { onUsage?: (u: { inputTokens: number; outputTokens: number }) => void }) => {
            params.onUsage?.({ inputTokens: 10_000, outputTokens: 2_000 });
            return "Desculpe, não consigo.";
        });
        const fake = runScript();
        await expect(handleAnalystAnalysis(fake.db, job(1))).rejects.toThrow("invalid_json");
        expect(llm.completeText).toHaveBeenCalledTimes(2);
        const failed = fake.calls[3].payload as Record<string, any>;
        expect(failed).toMatchObject({
            status: "failed",
            model: DEFAULT_ANALYSIS_MODEL,
            usage: { calls: 2, input_tokens: 20_000, output_tokens: 4_000, estimated_cost_usd: 0.12, estimated: false, failure: "invalid_json" },
        });
        expect(failed.error).toContain("incompleta duas vezes");
        expect(contracts.finishAgentRun).toHaveBeenCalledWith(
            expect.anything(),
            "run1",
            expect.objectContaining({ status: "failed", error: "invalid_json", tokensIn: 20_000, tokensOut: 4_000, costUsd: 0.12 }),
        );
        llm.completeText.mockReset();
        llm.completeText.mockResolvedValue(modelAnswer);
    });

    it("records the provider's token counts, not the character estimate, when it reports them", async () => {
        llm.completeText.mockImplementationOnce(async (params: { onUsage?: (u: { inputTokens: number; outputTokens: number }) => void }) => {
            params.onUsage?.({ inputTokens: 10_000, outputTokens: 2_000 });
            return modelAnswer;
        });
        const fake = scriptedDb([
            { table: "contract_analyses", data: row() },
            { table: "contract_analyses", op: "update" },
            { table: "projects", data: { contract_type: null } },
            { table: "contract_analyses", op: "update" },
        ]);
        await handleAnalystAnalysis(fake.db, job());
        const done = fake.calls[3].payload as Record<string, any>;
        // Sonnet: 10k × US$ 3/M + 2k × US$ 15/M.
        expect(done.usage).toMatchObject({ input_tokens: 10_000, output_tokens: 2_000, estimated_cost_usd: 0.06, estimated: false });
        expect(contracts.finishAgentRun).toHaveBeenCalledWith(
            expect.anything(),
            "run1",
            expect.objectContaining({ status: "succeeded", tokensIn: 10_000, tokensOut: 2_000, costUsd: 0.06 }),
        );
    });

    it("writes the verified analysis, announces it on the card and hands the counts to the request", async () => {
        const fake = scriptedDb([
            { table: "contract_analyses", data: row() },
            { table: "contract_analyses", op: "update" }, // running
            { table: "projects", data: { contract_type: "Prestação de serviços" } },
            { table: "contract_analyses", op: "update" }, // done
        ]);
        expect(await handleAnalystAnalysis(fake.db, job())).toEqual({ analysisId: ID, critical: 1, attention: 0, dropped: 1 });
        // No playbook for the type, and no organization model: Sonnet by default.
        expect(llm.completeText).toHaveBeenCalledWith(expect.objectContaining({ model: DEFAULT_ANALYSIS_MODEL }));
        expect(llm.completeText.mock.calls[0][0].user).toContain("- Motivo: Suporte");
        const done = fake.calls[3].payload as Record<string, any>;
        expect(done).toMatchObject({ status: "done", model: DEFAULT_ANALYSIS_MODEL, playbook_id: null });
        expect(done.result.critical[0]).toMatchObject({ title: "Multa alta", light: "red" });
        expect(done.result.redlines).toHaveLength(1);
        expect(done.dropped_citations).toEqual([expect.objectContaining({ title: "Inventado", reason: "trecho não encontrado no documento" })]);
        expect(done.usage).toMatchObject({ calls: 1, estimated: true });
        expect(done.usage.estimated_cost_usd).toBeGreaterThan(0);
        expect(contracts.recordCardEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ action: "analysis.completed", after: { analysis_id: ID, request_id: REQ, critical: 1, attention: 0 } }),
        );
        expect(enqueue.enqueueDbJob).toHaveBeenCalledWith(expect.anything(), {
            kind: ANALYSIS_READY_JOB,
            payload: { analysis_id: ID, project_id: "p1", request_id: REQ, critical: 1, attention: 0 },
            dedupeKey: `analysis-ready:${ID}`,
        });
        fake.done();
    });

    it("uses the organization's playbook for the type as the yardstick, without writing to the document", async () => {
        playbooks.findPlaybookForContractType.mockResolvedValue({ id: "pb-nda", name: "NDA" });
        playbooks.startPlaybookReview.mockResolvedValue({
            run: { id: "prun" },
            done: Promise.resolve({ findings: [{ ruleId: "multa", ruleName: "Multa", status: "needs_review" }] }),
        });
        const fake = scriptedDb([
            { table: "contract_analyses", data: row({ request_id: null }) },
            { table: "contract_analyses", op: "update" },
            { table: "projects", data: { contract_type: "NDA" } },
            { table: "contract_analyses", op: "update" },
        ]);
        expect(await handleAnalystAnalysis(fake.db, job())).toMatchObject({ critical: 0, attention: 1 });
        expect(playbooks.startPlaybookReview).toHaveBeenCalledWith(expect.objectContaining({ playbookId: "pb-nda", documentText: CONTRACT }));
        expect(playbooks.startPlaybookReview.mock.calls[0][0]).not.toHaveProperty("documentId");
        expect(fake.calls[3].payload).toMatchObject({ playbook_id: "pb-nda", playbook_run_id: "prun" });
        // Without a request, no request job.
        expect(enqueue.enqueueDbJob).not.toHaveBeenCalled();
        fake.done();
    });

    it("skips a finished analysis, and fails for good without a document", async () => {
        expect(await handleAnalystAnalysis(scriptedDb([{ table: "contract_analyses", data: row({ status: "done" }) }]).db, job())).toEqual({ skipped: true });
        shared.contractDocument.mockResolvedValueOnce(null);
        const fake = scriptedDb([
            { table: "contract_analyses", data: row() },
            { table: "contract_analyses", op: "update" },
            { table: "contract_analyses", op: "update" },
        ]);
        await expect(handleAnalystAnalysis(fake.db, job())).rejects.toThrow("no_document");
        expect(fake.calls[2].payload).toMatchObject({ status: "failed", error: "O contrato não tem documento para analisar." });
        expect(contracts.recordCardEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "analysis.failed" }));
    });

    it("puts a transient failure back in the queue while retries remain", async () => {
        llm.completeText.mockRejectedValueOnce(new Error("timeout"));
        const fake = scriptedDb([
            { table: "contract_analyses", data: row() },
            { table: "contract_analyses", op: "update" },
            { table: "projects", data: { contract_type: null } },
            { table: "contract_analyses", op: "update" },
        ]);
        await expect(handleAnalystAnalysis(fake.db, job(1))).rejects.toThrow("timeout");
        expect(fake.calls[3].payload).toMatchObject({ status: "queued", error: null });
        expect(contracts.recordCardEvent).not.toHaveBeenCalled();
    });

    it("marks a stuck analysis failed when the runner gives up", async () => {
        const fake = scriptedDb([{ table: "contract_analyses", op: "update" }]);
        await markAnalystAnalysisFailed(fake.db, job());
        expect(fake.calls[0].payload).toMatchObject({ status: "failed" });
        expect(fake.calls[0].filters).toContainEqual(["in", "status", ["queued", "running"]]);
    });
});

describe("reading an analysis", () => {
    it("gives the legal team the latest analysis or null", async () => {
        const fake = scriptedDb([{ table: "contract_analyses", data: [row({ status: "done" })] }]);
        const latest = await getLatestAnalysis(fake.db, caller, "p1");
        expect(latest).toMatchObject({ ok: true, data: { id: ID, status: "done" } });
        expect((latest as { data: Record<string, unknown> }).data).not.toHaveProperty("requested_by");
        expect(await getLatestAnalysis(scriptedDb([{ table: "contract_analyses", data: [] }]).db, caller, "p1")).toEqual({ ok: true, data: null });
    });

    it("hides an analysis from someone who cannot edit its contract", async () => {
        shared.requireContractEdit.mockResolvedValueOnce({ ok: false, kind: "forbidden" });
        const fake = scriptedDb([{ table: "contract_analyses", data: row() }]);
        expect(await getAnalysisById(fake.db, caller, ID)).toMatchObject({ ok: false, kind: "not_found" });
        expect(await getAnalysisById(scriptedDb([]).db, caller, "bad")).toMatchObject({ ok: false, kind: "not_found" });
    });
});
