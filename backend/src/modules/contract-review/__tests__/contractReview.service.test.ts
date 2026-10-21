import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";

// A permissive in-memory query double: each table has queued answers, and
// every call is recorded with its filters and payload so tests can assert
// scope and writes without scripting the exact order of reads.
type Call = { table: string; op: string; payload?: unknown; filters: unknown[][] };
function fakeDb(answers: Record<string, { data?: unknown; error?: unknown }[]>) {
    const calls: Call[] = [];
    const from = (table: string) => {
        const call: Call = { table, op: "select", filters: [] };
        const settle = () => {
            calls.push(call);
            const queue = answers[`${table}:${call.op}`] ?? answers[table] ?? [];
            const next = queue.length > 1 ? queue.shift()! : queue[0] ?? {};
            return Promise.resolve({ data: next.data ?? null, error: next.error ?? null });
        };
        const builder: Record<string, unknown> = {
            select: () => builder,
            maybeSingle: settle,
            single: settle,
            then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => settle().then(resolve, reject),
        };
        for (const op of ["insert", "update", "upsert", "delete"])
            builder[op] = (payload?: unknown) => {
                call.op = op;
                call.payload = payload;
                return builder;
            };
        for (const filter of ["eq", "is", "in", "order", "limit", "not"])
            builder[filter] = (...args: unknown[]) => {
                call.filters.push([filter, ...args]);
                return builder;
            };
        return builder;
    };
    return { db: { from } as unknown as Db, calls };
}

const access = vi.hoisted(() => ({ checkProjectAccess: vi.fn(), listAccessibleProjectIds: vi.fn() }));
vi.mock("../../../lib/access", () => access);
const llm = vi.hoisted(() => ({ completeText: vi.fn() }));
vi.mock("../../../lib/llm", () => llm);
vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn(async () => undefined) }));
const storage = vi.hoisted(() => ({ downloadFile: vi.fn() }));
vi.mock("../../../lib/storage", () => storage);
vi.mock("../../../lib/docxTrackedChanges", () => ({ extractDocxBodyText: vi.fn(async () => CONTRACT) }));
vi.mock("../../../lib/pdfText", () => ({ extractPdfText: vi.fn(async () => " texto pdf ") }));
const versions = vi.hoisted(() => ({ loadActiveVersion: vi.fn() }));
vi.mock("../../../lib/documentVersions", () => versions);
vi.mock("../../user/user.service", () => ({
    getUserModelSettings: vi.fn(async () => ({ tabular_model: "test-model", last_selected_chat_model: null, api_keys: {} })),
}));
const playbooks = vi.hoisted(() => ({
    createPlaybook: vi.fn(),
    getPlaybookRunById: vi.fn(),
    listPlaybooks: vi.fn(),
    playbookConfiguration: vi.fn(),
    startPlaybookReview: vi.fn(),
    updatePlaybookContent: vi.fn(),
    PlaybookRequestError: class PlaybookRequestError extends Error {
        constructor(message: string, readonly status = 400) {
            super(message);
        }
    },
}));
vi.mock("../../playbooks/playbooks.service", () => playbooks);
const documents = vi.hoisted(() => ({ applyTrackedEditsToDocument: vi.fn(), resolveEdit: vi.fn() }));
vi.mock("../../documents/documents.service", () => documents);

import {
    decideFichaField,
    decideReviewClause,
    ensureAveniaPlaybook,
    extractFicha,
    getContractReview,
    getFicha,
    listContractReviews,
    startContractReview,
    AVENIA_PLAYBOOK_NAME,
} from "../contractReview.service";

const CONTRACT = "7.1 A CONTRATANTE não poderá ceder este Contrato sem o prévio consentimento por escrito da CONTRATADA.";
const caller = { userId: "u1", userEmail: "duda@avenia.io" };
const role = (projectRole: string, org_id: string | null = "org-1") => ({
    ok: true,
    isCreator: false,
    orgRole: null,
    projectRole,
    project: { id: "p1", org_id },
});
const docxVersion = { id: "v1", storage_path: "s/contrato.docx", version_number: 2, filename: "Contrato.docx", file_type: "docx" };

beforeEach(() => {
    vi.clearAllMocks();
    access.checkProjectAccess.mockResolvedValue(role("editor"));
    access.listAccessibleProjectIds.mockResolvedValue(["p1", "p2", "p3"]);
    versions.loadActiveVersion.mockResolvedValue(docxVersion);
    storage.downloadFile.mockResolvedValue(new ArrayBuffer(4));
    playbooks.playbookConfiguration.mockResolvedValue({ defaultModel: "test-model", availableModelIds: ["test-model"] });
});

describe("Playbook Avenia seed", () => {
    it("reuses the workspace's copy and seeds one when there is none", async () => {
        playbooks.listPlaybooks.mockResolvedValueOnce([{ id: "pb-1", name: AVENIA_PLAYBOOK_NAME }]);
        expect(await ensureAveniaPlaybook({} as Db, caller, "org-1")).toMatchObject({ id: "pb-1" });
        expect(playbooks.createPlaybook).not.toHaveBeenCalled();

        playbooks.listPlaybooks.mockResolvedValueOnce([{ id: "other", name: "NDA" }]);
        playbooks.createPlaybook.mockResolvedValueOnce({ id: "pb-2" });
        playbooks.updatePlaybookContent.mockResolvedValueOnce({ id: "pb-2", name: AVENIA_PLAYBOOK_NAME });
        await ensureAveniaPlaybook({} as Db, caller, "org-1");
        expect(playbooks.createPlaybook).toHaveBeenCalledWith(
            "u1",
            expect.objectContaining({ name: AVENIA_PLAYBOOK_NAME, jurisdictions: ["Brasil"] }),
            expect.anything(),
            "org-1",
            "organization",
        );
        const content = playbooks.updatePlaybookContent.mock.calls[0][2];
        expect(content.topics.map((t: { name: string }) => t.name)).toEqual([
            "Cessão e mudança de controle",
            "Dados pessoais (LGPD) e confidencialidade",
            "Responsabilidade e multas",
            "Vigência, renovação e rescisão",
            "Lei aplicável e foro",
        ]);

        playbooks.listPlaybooks.mockResolvedValueOnce([]);
        playbooks.createPlaybook.mockResolvedValueOnce({ id: "pb-3" });
        await ensureAveniaPlaybook({} as Db, caller, null);
        expect(playbooks.listPlaybooks).toHaveBeenLastCalledWith("u1", expect.anything(), { workspace: "personal", email: "duda@avenia.io" });
        expect(playbooks.createPlaybook).toHaveBeenLastCalledWith("u1", expect.anything(), expect.anything(), undefined, undefined);
    });
});

describe("startContractReview", () => {
    it("reviews the contract's Word document with the Avenia playbook and links the run", async () => {
        const fake = fakeDb({ documents: [{ data: [{ id: "d1" }] }] });
        playbooks.listPlaybooks.mockResolvedValue([{ id: "pb-1", name: AVENIA_PLAYBOOK_NAME }]);
        playbooks.startPlaybookReview.mockResolvedValue({ run: { id: "run-1", status: "running" }, done: Promise.reject(new Error("later")) });
        const result = await startContractReview(fake.db, caller, "p1", {});
        expect(result).toEqual({ ok: true, data: { id: "run-1", status: "running" } });
        expect(playbooks.startPlaybookReview).toHaveBeenCalledWith(
            expect.objectContaining({ playbookId: "pb-1", documentId: "d1", model: "test-model", reviewMode: "strict" }),
        );
        expect(playbooks.startPlaybookReview.mock.calls[0][0].instructions).toContain("português do Brasil");
        expect(fake.calls.find((c) => c.table === "contract_reviews")?.payload).toEqual({
            run_id: "run-1",
            project_id: "p1",
            document_id: "d1",
            playbook_id: "pb-1",
            user_id: "u1",
        });
    });

    it("uses the playbook and model asked for", async () => {
        const fake = fakeDb({ documents: [{ data: [{ id: "d1" }] }] });
        playbooks.startPlaybookReview.mockResolvedValue({ run: { id: "run-2", status: "running" }, done: Promise.resolve() });
        await startContractReview(fake.db, caller, "p1", { playbook_id: "pb-x", model: "m2", mode: "permissive" });
        expect(playbooks.listPlaybooks).not.toHaveBeenCalled();
        expect(playbooks.startPlaybookReview).toHaveBeenCalledWith(
            expect.objectContaining({ playbookId: "pb-x", model: "m2", reviewMode: "permissive" }),
        );
    });

    it("explains what is missing before a review can start", async () => {
        expect(await startContractReview(fakeDb({ documents: [{ data: [] }] }).db, caller, "p1", {})).toMatchObject({
            ok: false,
            kind: "validation",
            detail: "Envie o contrato (.docx) antes de revisar.",
        });
        versions.loadActiveVersion.mockResolvedValue({ ...docxVersion, filename: "c.pdf", file_type: "pdf" });
        expect(await startContractReview(fakeDb({ documents: [{ data: [{ id: "d1" }] }] }).db, caller, "p1", {})).toMatchObject({
            detail: "A revisão com redline precisa do contrato em Word (.docx).",
        });
        versions.loadActiveVersion.mockResolvedValue(docxVersion);
        playbooks.playbookConfiguration.mockResolvedValue({ defaultModel: null });
        expect(
            await startContractReview(fakeDb({ documents: [{ data: [{ id: "d1" }] }] }).db, caller, "p1", { playbook_id: "pb" }),
        ).toMatchObject({ kind: "validation", code: "model_required" });
    });

    it("refuses a viewer and hides a contract the caller cannot open", async () => {
        access.checkProjectAccess.mockResolvedValueOnce(role("viewer"));
        expect(await startContractReview(fakeDb({}).db, caller, "p1", {})).toMatchObject({ ok: false, kind: "forbidden" });
        access.checkProjectAccess.mockResolvedValueOnce({ ok: false });
        expect(await startContractReview(fakeDb({}).db, caller, "p1", {})).toMatchObject({ ok: false, kind: "not_found" });
    });

    it("maps a playbook refusal onto its status and hides other errors", async () => {
        const db = () => fakeDb({ documents: [{ data: [{ id: "d1" }] }] }).db;
        playbooks.startPlaybookReview.mockRejectedValueOnce(new playbooks.PlaybookRequestError("Playbook not found.", 404));
        expect(await startContractReview(db(), caller, "p1", { playbook_id: "x" })).toMatchObject({ kind: "not_found" });
        playbooks.startPlaybookReview.mockRejectedValueOnce(new playbooks.PlaybookRequestError("no", 403));
        expect(await startContractReview(db(), caller, "p1", { playbook_id: "x" })).toMatchObject({ kind: "forbidden" });
        playbooks.startPlaybookReview.mockRejectedValueOnce(new playbooks.PlaybookRequestError("Document text is required."));
        expect(await startContractReview(db(), caller, "p1", { playbook_id: "x" })).toMatchObject({ kind: "validation" });
        playbooks.startPlaybookReview.mockRejectedValueOnce(new Error("db password leaked"));
        expect(await startContractReview(db(), caller, "p1", { playbook_id: "x" })).toMatchObject({ kind: "error" });
    });
});

const RUN = {
    id: "run-1",
    playbookId: "pb-1",
    model: "test-model",
    documentName: "Contrato.docx",
    documentId: "d1",
    editedVersionId: "v3",
    status: "completed",
    error: null,
    summary: "2 desvios.",
    startedAt: "2026-10-20T10:00:00Z",
    completedAt: "2026-10-20T10:01:00Z",
    findings: [
        {
            id: "f-cessao",
            ruleId: "avenia-cessao",
            topicId: "avenia-alteracao-parte",
            ruleName: "Cessão do contrato",
            status: "acceptable",
            quote: "não poderá ceder",
            location: "Cláusula 7",
            analysis: "Cessão com consentimento.",
            suggestedText: "",
            edit: null,
        },
        {
            id: "f-foro",
            ruleId: "avenia-foro",
            topicId: "avenia-disputas",
            ruleName: "Lei aplicável e foro",
            status: "needs_review",
            quote: "foro de Nova York",
            location: "Cláusula 20",
            analysis: "Foro estrangeiro.",
            suggestedText: "foro da Comarca de São Paulo/SP",
            edit: { edit_id: "e1", status: "pending", deleted_text: "foro de Nova York", inserted_text: "foro da Comarca de São Paulo/SP" },
        },
        {
            id: "f-extra",
            ruleId: null,
            topicId: null,
            ruleName: "Exclusividade",
            status: "outside_scope",
            quote: "",
            location: "",
            analysis: "Sem regra no playbook.",
            suggestedText: "",
        },
    ],
};

const SNAPSHOT = {
    topics: [
        {
            rules: [
                { id: "avenia-cessao", name: "Cessão do contrato", standard: { name: "Cessão recíproca", criteria: "Consentimento." } },
                { id: "avenia-foro", name: "Lei aplicável e foro", standard: null },
            ],
        },
    ],
};

function fichaField(value: unknown, state = "pendente") {
    return {
        status: "encontrado",
        value,
        citations: [{ quote: "q", clause: null, span: null, verified: true, match: "exato" }],
        confidence: "alta",
        origin: "ia",
        notes: null,
        review: { state, by: null, at: null, comment: null },
    };
}

describe("getContractReview", () => {
    it("combines the playbook verdict, the Ficha's rules and precedent per clause", async () => {
        playbooks.getPlaybookRunById.mockResolvedValue(RUN);
        const fake = fakeDb({
            contract_reviews: [{ data: { run_id: "run-1", project_id: "p1", playbook_id: "pb-1" } }],
            playbook_runs: [{ data: { content_json: SNAPSHOT } }],
            playbooks: [{ data: { id: "pb-1", name: AVENIA_PLAYBOOK_NAME } }],
            contract_review_decisions: [
                { data: [{ finding_id: "f-cessao", decision: "aceito", edited_text: null, reason: null, decided_by: "duda@avenia.io", decided_at: "t", edit: null }] },
            ],
            contract_fichas: [
                {
                    data: {
                        ficha: {
                            "alteracao_parte.cessao": fichaField({ regime: "consentimento_previo", aplica_a: "ambas", excecoes: ["afiliadas"] }),
                            "foro.lei_aplicavel": fichaField({ jurisdicao: "US" }),
                        },
                        findings: [
                            { rule_id: "FOR-01", severidade: "media", titulo: "Lei estrangeira", depende_de_campo_nao_validado: true },
                            { rule_id: "REG-08", severidade: "alta", titulo: "Exclusividade", depende_de_campo_nao_validado: true },
                        ],
                    },
                },
                {
                    data: [
                        { project_id: "p2", ficha: { "alteracao_parte.cessao": fichaField({ regime: "consentimento_previo", aplica_a: "ambas", excecoes: ["afiliadas"] }, "confirmado") } },
                        { project_id: "p3", ficha: { "alteracao_parte.cessao": fichaField({ regime: "livre" }, "corrigido") } },
                    ],
                },
            ],
            projects: [{ data: [{ id: "p2", name: "MSA Trópico" }, { id: "p3", name: "SaaS Polaris" }] }],
        });
        const result = await getContractReview(fake.db, caller, "p1", "run-1");
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const [cessao, foro, extra] = result.data.clauses;
        expect(cessao).toMatchObject({
            verdict: "alinhado",
            covered: true,
            decision: { decision: "aceito" },
            precedent: { same: 1, of: 2, projects: [{ id: "p2", name: "MSA Trópico" }] },
        });
        expect(cessao.sources[0]).toEqual({ kind: "playbook", label: "Cessão do contrato", position: "Cessão recíproca", criteria: "Consentimento." });
        expect(cessao.sources).toContainEqual(expect.objectContaining({ kind: "ficha", path: "alteracao_parte.cessao", label: "Cessão", state: "pendente" }));
        expect(foro).toMatchObject({ verdict: "precisa_revisao", playbook_status: "needs_review", rule_findings: [{ rule_id: "FOR-01" }] });
        expect(foro.sources).toContainEqual(expect.objectContaining({ kind: "regra", rule_id: "FOR-01", pending_validation: true }));
        expect(extra).toMatchObject({ verdict: "nao_aplica", covered: false, precedent: null });
        expect(result.data.uncovered.map((f) => f.rule_id)).toEqual(["REG-08"]);
        expect(result.data.document).toEqual({ id: "d1", name: "Contrato.docx", edited_version_id: "v3" });
        expect(fake.calls.find((c) => c.table === "projects")?.filters).toContainEqual(["eq", "lane", "arquivado"]);
    });

    it("turns a high-severity rule into a divergence and works without a Ficha", async () => {
        playbooks.getPlaybookRunById.mockResolvedValue(RUN);
        const withRule = fakeDb({
            contract_reviews: [{ data: { run_id: "run-1", project_id: "p1", playbook_id: "pb-1" } }],
            contract_fichas: [{ data: { ficha: {}, findings: [{ rule_id: "ALT-04", severidade: "alta", titulo: "x", depende_de_campo_nao_validado: false }] } }],
            projects: [{ data: [] }],
        });
        const result = await getContractReview(withRule.db, caller, "p1", "run-1");
        expect(result.ok && result.data.clauses[0].verdict).toBe("diverge");
        expect(result.ok && result.data.playbook.name).toBe(AVENIA_PLAYBOOK_NAME);

        access.listAccessibleProjectIds.mockResolvedValueOnce(["p1"]);
        const none = fakeDb({ contract_reviews: [{ data: { run_id: "run-1", project_id: "p1", playbook_id: "pb-1" } }], contract_fichas: [{ data: null }] });
        const bare = await getContractReview(none.db, caller, "p1", "run-1");
        expect(bare.ok && bare.data.clauses.map((c) => c.precedent)).toEqual([null, null, null]);
    });

    it("hides a review of another contract and a run that is gone", async () => {
        expect(await getContractReview(fakeDb({ contract_reviews: [{ data: null }] }).db, caller, "p1", "run-x")).toMatchObject({ kind: "not_found" });
        playbooks.getPlaybookRunById.mockResolvedValueOnce(null);
        expect(
            await getContractReview(fakeDb({ contract_reviews: [{ data: { run_id: "r", playbook_id: "pb" } }] }).db, caller, "p1", "r"),
        ).toMatchObject({ kind: "not_found" });
        access.checkProjectAccess.mockResolvedValueOnce({ ok: false });
        expect(await getContractReview(fakeDb({}).db, caller, "p1", "r")).toMatchObject({ kind: "not_found" });
        expect(await getContractReview(fakeDb({ contract_reviews: [{ error: { message: "boom" } }] }).db, caller, "p1", "r")).toMatchObject({ kind: "error" });
    });
});

describe("listContractReviews", () => {
    it("lists the contract's reviews with their verdict counts", async () => {
        const fake = fakeDb({
            contract_reviews: [
                { data: [{ run_id: "run-1", playbook_id: "pb-1", created_at: "c1" }, { run_id: "gone", playbook_id: "pb-1", created_at: "c0" }] },
            ],
            playbook_runs: [{ data: [{ id: "run-1", status: "completed", started_at: "s1", findings_json: RUN.findings }] }],
            playbooks: [{ data: [{ id: "pb-1", name: "Playbook Avenia v1" }] }],
        });
        expect(await listContractReviews(fake.db, caller, "p1")).toEqual({
            ok: true,
            data: [{ id: "run-1", status: "completed", started_at: "s1", playbook_name: "Playbook Avenia v1", counts: { alinhado: 1, precisa_revisao: 1, diverge: 0 } }],
        });
        expect(await listContractReviews(fakeDb({ contract_reviews: [{ data: [] }] }).db, caller, "p1")).toEqual({ ok: true, data: [] });
        expect(
            await listContractReviews(fakeDb({ contract_reviews: [{ data: [{ run_id: "r", playbook_id: "pb" }] }], playbook_runs: [{ error: { m: 1 } }] }).db, caller, "p1"),
        ).toMatchObject({ kind: "error" });
        access.checkProjectAccess.mockResolvedValueOnce({ ok: false });
        expect(await listContractReviews(fakeDb({}).db, caller, "p1")).toMatchObject({ kind: "not_found" });
    });
});

describe("decideReviewClause", () => {
    const linked = (decisions: unknown[] = []) => ({
        contract_reviews: [{ data: { run_id: "run-1", project_id: "p1", playbook_id: "pb-1" } }],
        "contract_review_decisions:select": [{ data: decisions }],
    });
    const decided = (decision: string) => ({
        finding_id: "f-foro",
        decision,
        edited_text: null,
        reason: null,
        decided_by: "ana@avenia.io",
        decided_at: "t",
        edit: null,
    });

    it("keeps an accepted tracked change in the document and records who accepted it", async () => {
        playbooks.getPlaybookRunById.mockResolvedValue(RUN);
        const fake = fakeDb(linked());
        const result = await decideReviewClause(fake.db, caller, "p1", "run-1", "f-foro", { decision: "aceito" });
        expect(result).toMatchObject({ ok: true, data: { decision: { decision: "aceito", decided_by: "duda@avenia.io" } } });
        expect(documents.resolveEdit).not.toHaveBeenCalled();
        expect(fake.calls.find((c) => c.op === "insert")?.payload).toMatchObject({ run_id: "run-1", finding_id: "f-foro", decision: "aceito" });
    });

    it("rejects the tracked change with a reason", async () => {
        playbooks.getPlaybookRunById.mockResolvedValue(RUN);
        documents.resolveEdit.mockResolvedValue({ ok: true, body: {} });
        const result = await decideReviewClause(fakeDb(linked()).db, caller, "p1", "run-1", "f-foro", { decision: "rejeitado", reason: " contraparte não aceita " });
        expect(documents.resolveEdit).toHaveBeenCalledWith("reject", "d1", "e1", "u1", "duda@avenia.io", expect.anything());
        expect(result).toMatchObject({ ok: true, data: { decision: { decision: "rejeitado", reason: "contraparte não aceita" } } });
    });

    it("writes the person's wording over the suggestion in one change", async () => {
        playbooks.getPlaybookRunById.mockResolvedValue(RUN);
        documents.applyTrackedEditsToDocument.mockResolvedValue({ ok: true, annotations: [{ edit_id: "e2", status: "pending" }] });
        const result = await decideReviewClause(fakeDb(linked()).db, caller, "p1", "run-1", "f-foro", {
            decision: "editado",
            edited_text: "foro da Comarca de São Paulo/SP, com arbitragem",
        });
        expect(documents.applyTrackedEditsToDocument).toHaveBeenCalledWith(
            expect.objectContaining({
                documentId: "d1",
                edits: [expect.objectContaining({ find: "foro da Comarca de São Paulo/SP", replace: "foro da Comarca de São Paulo/SP, com arbitragem" })],
            }),
        );
        expect(documents.resolveEdit).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: true, data: { edit: { edit_id: "e2" }, decision: { edited_text: "foro da Comarca de São Paulo/SP, com arbitragem" } } });
    });

    it("edits the quoted contract language when the suggestion made no tracked change", async () => {
        playbooks.getPlaybookRunById.mockResolvedValue({ ...RUN, findings: RUN.findings.map((f) => ({ ...f, edit: null })) });
        documents.applyTrackedEditsToDocument.mockResolvedValue({ ok: true, annotations: [{ edit_id: "e3" }] });
        await decideReviewClause(fakeDb(linked()).db, caller, "p1", "run-1", "f-foro", { decision: "editado", edited_text: "x" });
        expect(documents.applyTrackedEditsToDocument.mock.calls[0][0].edits[0].find).toBe("foro de Nova York");
    });

    it("leaves the document alone when the edited wording cannot be placed", async () => {
        playbooks.getPlaybookRunById.mockResolvedValue(RUN);
        documents.applyTrackedEditsToDocument.mockResolvedValue({ ok: false, error: "not found" });
        expect(
            await decideReviewClause(fakeDb(linked()).db, caller, "p1", "run-1", "f-foro", { decision: "editado", edited_text: "x" }),
        ).toMatchObject({ kind: "conflict" });
        expect(documents.resolveEdit).not.toHaveBeenCalled();
        expect(
            await decideReviewClause(fakeDb(linked()).db, caller, "p1", "run-1", "f-extra", { decision: "editado", edited_text: "x" }),
        ).toMatchObject({ kind: "validation" });
    });

    it("takes one decision per suggestion, even when two people decide at once", async () => {
        playbooks.getPlaybookRunById.mockResolvedValue(RUN);
        expect(
            await decideReviewClause(fakeDb(linked([decided("aceito")])).db, caller, "p1", "run-1", "f-foro", { decision: "rejeitado" }),
        ).toMatchObject({ kind: "conflict" });
        const race = fakeDb({ ...linked(), "contract_review_decisions:insert": [{ error: { code: "23505" } }] });
        expect(await decideReviewClause(race.db, caller, "p1", "run-1", "f-cessao", { decision: "aceito" })).toMatchObject({ kind: "conflict" });
    });

    it("reopens an accept, but not a change already applied to the document", async () => {
        const fake = fakeDb(linked([decided("aceito")]));
        expect(await decideReviewClause(fake.db, caller, "p1", "run-1", "f-foro", { decision: "desfeito" })).toEqual({ ok: true, data: { decision: null, edit: null } });
        expect(fake.calls.find((c) => c.op === "delete")?.filters).toContainEqual(["eq", "finding_id", "f-foro"]);
        expect(await decideReviewClause(fakeDb(linked([decided("rejeitado")])).db, caller, "p1", "run-1", "f-foro", { decision: "desfeito" })).toMatchObject({
            kind: "conflict",
        });
        expect(await decideReviewClause(fakeDb(linked()).db, caller, "p1", "run-1", "f-foro", { decision: "desfeito" })).toEqual({
            ok: true,
            data: { decision: null, edit: null },
        });
    });

    it("validates the request", async () => {
        const db = fakeDb(linked()).db;
        expect(await decideReviewClause(db, caller, "p1", "run-1", "f", { decision: "talvez" })).toMatchObject({ kind: "validation" });
        expect(await decideReviewClause(db, caller, "p1", "run-1", "f", { decision: "editado", edited_text: " " })).toMatchObject({ kind: "validation" });
    });

    it("reports a document that changed, a missing suggestion and a viewer", async () => {
        playbooks.getPlaybookRunById.mockResolvedValue(RUN);
        documents.resolveEdit.mockResolvedValue({ ok: false, detail: "Edit not found" });
        expect(await decideReviewClause(fakeDb(linked()).db, caller, "p1", "run-1", "f-foro", { decision: "rejeitado" })).toMatchObject({ kind: "conflict" });
        expect(await decideReviewClause(fakeDb(linked()).db, caller, "p1", "run-1", "nope", { decision: "aceito" })).toMatchObject({ kind: "not_found" });
        expect(await decideReviewClause(fakeDb({ contract_reviews: [{ data: null }] }).db, caller, "p1", "run-1", "f", { decision: "aceito" })).toMatchObject({ kind: "not_found" });
        access.checkProjectAccess.mockResolvedValueOnce(role("viewer"));
        expect(await decideReviewClause(fakeDb({}).db, caller, "p1", "run-1", "f", { decision: "aceito" })).toMatchObject({ kind: "forbidden" });
        const failing = fakeDb({ ...linked(), "contract_review_decisions:insert": [{ error: { message: "x" } }] });
        expect(await decideReviewClause(failing.db, caller, "p1", "run-1", "f-cessao", { decision: "aceito" })).toMatchObject({ kind: "error" });
    });
});

describe("Ficha service", () => {
    it("extracts, verifies, evaluates rules and keeps the model's reading out of human fields", async () => {
        llm.completeText.mockResolvedValue(
            "```json\n" +
                JSON.stringify({
                    fields: {
                        "alteracao_parte.cessao": {
                            status: "encontrado",
                            value: { regime: "consentimento_previo", aplica_a: "ambas", excecoes: [] },
                            citations: [{ quote: "não poderá ceder este Contrato", clause: "cl. 7.1" }],
                            confidence: "alta",
                        },
                    },
                }) +
                "\n```",
        );
        const fake = fakeDb({ documents: [{ data: [{ id: "d1" }] }], "contract_fichas:select": [{ data: null }] });
        const result = await extractFicha(fake.db, caller, "p1");
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.ficha?.["alteracao_parte.cessao"]?.citations[0]).toMatchObject({ verified: true, match: "exato" });
        expect(result.data.findings.map((f) => f.rule_id)).toEqual(["ALT-03"]);
        expect(result.data.risk_overall).toBe("atencao");
        expect(result.data.progress.verified).toBe(0);
        const saved = fake.calls.find((c) => c.op === "upsert")?.payload as Record<string, unknown>;
        expect(saved).toMatchObject({ project_id: "p1", document_id: "d1", model: "test-model", prompt_version: "ficha-revisao-v1", rules_version: "1.0" });
    });

    it("says what is missing before extracting", async () => {
        expect(await extractFicha(fakeDb({ documents: [{ data: [] }] }).db, caller, "p1")).toMatchObject({ kind: "validation" });
        storage.downloadFile.mockResolvedValueOnce(null);
        expect(await extractFicha(fakeDb({ documents: [{ data: [{ id: "d1" }] }] }).db, caller, "p1")).toMatchObject({
            detail: "Não consegui ler o texto do contrato.",
        });
        llm.completeText.mockResolvedValueOnce("não é json");
        expect(await extractFicha(fakeDb({ documents: [{ data: [{ id: "d1" }] }], contract_fichas: [{ data: null }] }).db, caller, "p1")).toMatchObject({ kind: "error" });
    });

    it("reads a PDF contract's text when there is no Word document", async () => {
        versions.loadActiveVersion.mockResolvedValue({ ...docxVersion, filename: "c.pdf", file_type: "pdf" });
        llm.completeText.mockResolvedValue('{"fields":{}}');
        const result = await extractFicha(fakeDb({ documents: [{ data: [{ id: "d1" }] }], contract_fichas: [{ data: null }] }).db, caller, "p1");
        // An answer with no fields would blank the Ficha: it is an error, not a reset.
        expect(result).toMatchObject({ ok: false, kind: "error" });
        expect(llm.completeText.mock.calls[0][0].user).toContain("texto pdf");
    });

    it("reads an empty Ficha as none yet", async () => {
        expect(await getFicha(fakeDb({ contract_fichas: [{ data: null }] }).db, caller, "p1")).toMatchObject({
            ok: true,
            data: { ficha: null, findings: [], progress: { verified: 0, total: 0 } },
        });
        expect(await getFicha(fakeDb({ contract_fichas: [{ error: { m: 1 } }] }).db, caller, "p1")).toMatchObject({ kind: "error" });
        access.checkProjectAccess.mockResolvedValueOnce({ ok: false });
        expect(await getFicha(fakeDb({}).db, caller, "p1")).toMatchObject({ kind: "not_found" });
    });

    it("confirms and corrects a field, re-running the rules and keeping the trail", async () => {
        const stored = {
            project_id: "p1",
            ficha: { "foro.lei_aplicavel": fichaField({ jurisdicao: "US" }) },
            findings: [],
            risk_overall: "atencao",
            document_id: "d1",
            extracted_at: "t",
            model: "m",
            updated_at: "2026-10-20T10:00:00Z",
        };
        const fake = fakeDb({ "contract_fichas:select": [{ data: stored }], "contract_fichas:update": [{ data: [{ project_id: "p1" }] }] });
        const result = await decideFichaField(fake.db, caller, "p1", { path: "foro.lei_aplicavel", action: "corrigir", value: { jurisdicao: "BR" }, comment: "cl. 20" });
        expect(fake.calls.find((c) => c.op === "update")?.filters).toContainEqual(["eq", "updated_at", "2026-10-20T10:00:00Z"]);
        expect(result).toMatchObject({ ok: true, data: { findings: [], risk_overall: "ok", progress: { verified: 1, total: 1 } } });
        expect(fake.calls.find((c) => c.table === "contract_field_reviews")?.payload).toMatchObject({
            path: "foro.lei_aplicavel",
            action: "corrigido",
            ai_value: { jurisdicao: "US" },
            final_value: { jurisdicao: "BR" },
            reviewer: "duda@avenia.io",
            comment: "cl. 20",
        });
        const confirm = await decideFichaField(
            fakeDb({ "contract_fichas:select": [{ data: stored }], "contract_fichas:update": [{ data: [{ project_id: "p1" }] }] }).db,
            caller,
            "p1",
            { path: "foro.lei_aplicavel", action: "confirmar" },
        );
        expect(confirm.ok && confirm.data.findings.map((f) => f.rule_id)).toEqual(["FOR-01"]);
        expect(confirm.ok && confirm.data.choices["dados_pessoais.compartilhamento"]).toBe("boolean");
    });

    it("loses no one's work when two people validate at once", async () => {
        const stored = { project_id: "p1", ficha: { "foro.lei_aplicavel": fichaField({ jurisdicao: "US" }) }, findings: [], updated_at: "t0" };
        const fake = fakeDb({ "contract_fichas:select": [{ data: stored }], "contract_fichas:update": [{ data: [] }] });
        expect(await decideFichaField(fake.db, caller, "p1", { path: "foro.lei_aplicavel", action: "confirmar" })).toMatchObject({ kind: "conflict" });
        expect(fake.calls.some((c) => c.table === "contract_field_reviews")).toBe(false);
    });

    it("refuses a correction the rules could not read", async () => {
        const db = fakeDb({}).db;
        expect(await decideFichaField(db, caller, "p1", { path: "identificacao.papel_avenia", action: "corrigir", value: { nota: "contratada" } })).toMatchObject({
            kind: "validation",
            detail: "Escolha um dos valores deste campo.",
        });
        expect(await decideFichaField(db, caller, "p1", { path: "dados_pessoais.compartilhamento", action: "corrigir", value: "sim" })).toMatchObject({ kind: "validation" });
        expect(await decideFichaField(db, caller, "p1", { path: "alteracao_parte.cessao", action: "corrigir", value: { regime: "proibida" } })).toMatchObject({ kind: "validation" });
    });

    it("validates the field decision", async () => {
        const db = fakeDb({ contract_fichas: [{ data: null }] }).db;
        expect(await decideFichaField(db, caller, "p1", { path: "x", action: "confirmar" })).toMatchObject({ kind: "validation" });
        expect(await decideFichaField(db, caller, "p1", { path: "foro.lei_aplicavel", action: "apagar" })).toMatchObject({ kind: "validation" });
        expect(await decideFichaField(db, caller, "p1", { path: "foro.lei_aplicavel", action: "corrigir" })).toMatchObject({ kind: "validation" });
        expect(await decideFichaField(db, caller, "p1", { path: "foro.lei_aplicavel", action: "confirmar" })).toMatchObject({ kind: "not_found" });
    });
});
