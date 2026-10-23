import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const shared = vi.hoisted(() => ({ requireContractEdit: vi.fn(), contractDocument: vi.fn() }));
vi.mock("../contractReview.shared", async (actual) => ({
    ...(await actual<typeof import("../contractReview.shared")>()),
    ...shared,
}));
const documents = vi.hoisted(() => ({ applyTrackedEditsToDocument: vi.fn() }));
vi.mock("../../documents/documents.service", () => documents);
const contracts = vi.hoisted(() => ({ recordCardEvent: vi.fn(async () => 1) }));
vi.mock("../../contracts/contracts.service", () => contracts);
vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn(async () => undefined) }));

import { analysisDocx, analysisMarkdown, decideAnalysisRedline, exportAnalysis, listRedlineDecisions } from "../contractReview.service";
import type { AnalysisResult } from "../contractReview.analysis";

const caller = { userId: "u1", userEmail: "time@example.com" };
const ID = "11111111-2222-4333-8444-555555555555";
const docx = { documentId: "d1", versionId: "v1", versionNumber: 1, filename: "Contrato.docx", fileType: "docx", storagePath: "s", isDocx: true };
const result: AnalysisResult = {
    notice: "Rascunho gerado por IA para o time jurídico. Não é parecer jurídico.",
    executive_summary: { text: "Serviços de suporte entre duas empresas fictícias.", object: "Suporte", parties: ["A", "B"], value: null },
    critical: [{ id: "c1", title: "Multa alta", quote: "multa de 50%", clause: "cl. 5.1", rationale: "Desproporcional.", suggestion: "Reduzir.", light: "red", rule_id: null, span: null }],
    attention: [],
    favorable: [{ id: "f1", title: "Foro", quote: "foro de São Paulo", clause: "cl. 9", rationale: "Bom.", suggestion: null, light: "green", rule_id: null, span: null }],
    redlines: [
        { id: "r1", clause: "cl. 5.1", from: "multa de 50%", to: "multa de 10%", why: "Proporção.", item_id: "c1", span: null },
        { id: "r2", clause: "cl. 6", from: "prazo de 5 dias", to: "prazo de 30 dias", why: "Operável.", item_id: null, span: null },
    ],
    compliance: { data_protection: "Sem dados pessoais.", confidentiality: "Adequada.", governing_law_forum: "Brasil.", term_termination_penalties: "Multa alta." },
    open_points: [{ id: "o1", text: "Aprovação do founder.", depends_on: "founder" }],
};
const analysis = (extra: Record<string, unknown> = {}) => ({ id: ID, project_id: "p1", version_id: "v1", status: "done", result, ...extra });
const edit = { edit_id: "e1", status: "pending" };

beforeEach(() => {
    vi.clearAllMocks();
    shared.requireContractEdit.mockResolvedValue({ ok: true, access: { project: { org_id: "org-1" } } });
    shared.contractDocument.mockResolvedValue(docx);
    documents.applyTrackedEditsToDocument.mockResolvedValue({ ok: true, annotations: [edit] });
});

describe("decideAnalysisRedline", () => {
    it("accepts a redline as a tracked change in the Word document and records who did it", async () => {
        const fake = scriptedDb([
            { table: "contract_analyses", data: analysis() },
            { table: "contract_analysis_decisions", data: null },
            { table: "user_profiles", data: { display_name: "Pessoa do Jurídico", email: "time@example.com" } },
            { table: "contract_analysis_decisions", op: "insert" },
        ]);
        const decided = await decideAnalysisRedline(fake.db, caller, "p1", ID, "r1", { decision: "aceito" });
        expect(decided).toMatchObject({ ok: true, data: { decision: "aceito", decided_by: "Pessoa do Jurídico", edit } });
        expect(documents.applyTrackedEditsToDocument).toHaveBeenCalledWith(
            expect.objectContaining({ documentId: "d1", edits: [expect.objectContaining({ find: "multa de 50%", replace: "multa de 10%" })] }),
        );
        expect(fake.calls[3].payload).toMatchObject({ analysis_id: ID, redline_id: "r1", decision: "aceito" });
        expect(contracts.recordCardEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "analysis.redline_aceito" }));
        fake.done();
    });

    it("applies an edit with the person's wording, and records a rejection without touching the document", async () => {
        const edited = scriptedDb([
            { table: "contract_analyses", data: analysis() },
            { table: "contract_analysis_decisions", data: null },
            { table: "user_profiles", data: null },
            { table: "contract_analysis_decisions", op: "insert" },
        ]);
        await decideAnalysisRedline(edited.db, caller, "p1", ID, "r2", { decision: "editado", edited_text: "prazo de 15 dias" });
        expect(documents.applyTrackedEditsToDocument.mock.calls[0][0].edits[0]).toMatchObject({ find: "prazo de 5 dias", replace: "prazo de 15 dias" });

        documents.applyTrackedEditsToDocument.mockClear();
        const rejected = scriptedDb([
            { table: "contract_analyses", data: analysis() },
            { table: "contract_analysis_decisions", data: null },
            { table: "user_profiles", data: null },
            { table: "contract_analysis_decisions", op: "insert" },
        ]);
        expect(await decideAnalysisRedline(rejected.db, caller, "p1", ID, "r2", { decision: "rejeitado", reason: "Prazo é comercial." })).toMatchObject({
            ok: true,
            data: { decision: "rejeitado", reason: "Prazo é comercial.", edit: null },
        });
        expect(documents.applyTrackedEditsToDocument).not.toHaveBeenCalled();
    });

    it("records the decision alone on a PDF contract, which has no redline", async () => {
        shared.contractDocument.mockResolvedValue({ ...docx, isDocx: false, fileType: "pdf", filename: "Contrato.pdf" });
        const fake = scriptedDb([
            { table: "contract_analyses", data: analysis() },
            { table: "contract_analysis_decisions", data: null },
            { table: "user_profiles", data: null },
            { table: "contract_analysis_decisions", op: "insert" },
        ]);
        expect(await decideAnalysisRedline(fake.db, caller, "p1", ID, "r1", { decision: "aceito" })).toMatchObject({ ok: true, data: { edit: null } });
        expect(documents.applyTrackedEditsToDocument).not.toHaveBeenCalled();
    });

    it("accepts a second redline on the version the first one made: an analysis's own edits are not 'stale'", async () => {
        // r1 was accepted and made v2; the contract is now v2, and r2 still quotes text that v2 holds.
        shared.contractDocument.mockResolvedValueOnce({ ...docx, versionId: "v2" });
        const fake = scriptedDb([
            { table: "contract_analyses", data: analysis() },
            { table: "contract_analysis_decisions", data: null },
            { table: "contract_analysis_decisions", data: [{ edit: { version_id: "v2" } }] },
            { table: "user_profiles", data: { display_name: "Pessoa", email: "time@example.com" } },
            { table: "contract_analysis_decisions", op: "insert" },
        ]);
        expect(await decideAnalysisRedline(fake.db, caller, "p1", ID, "r2", { decision: "aceito" })).toMatchObject({ ok: true });
        fake.done();
    });

    it("says so, and saves nothing, when the contract was written by someone else at the same time and every retry lost", async () => {
        documents.applyTrackedEditsToDocument.mockResolvedValueOnce({ ok: false, error: "x", conflict: true });
        const fake = scriptedDb([
            { table: "contract_analyses", data: analysis() },
            { table: "contract_analysis_decisions", data: null },
        ]);
        const decided = await decideAnalysisRedline(fake.db, caller, "p1", ID, "r1", { decision: "aceito" });
        expect(decided).toMatchObject({ ok: false, kind: "conflict", code: "document_busy" });
        expect(decided).toMatchObject({ detail: expect.stringMatching(/não foi gravada/) });
        // No decision row was written: the person can try again.
        expect(fake.calls.some((call) => call.op === "insert")).toBe(false);
        fake.done();
    });

    it("refuses a stale analysis, a decided redline, an unplaceable change and bad input", async () => {
        shared.contractDocument.mockResolvedValueOnce({ ...docx, versionId: "v2" });
        const stale = scriptedDb([
            { table: "contract_analyses", data: analysis() },
            { table: "contract_analysis_decisions", data: null },
            { table: "contract_analysis_decisions", data: [] }, // no decision of this analysis made version v2
        ]);
        expect(await decideAnalysisRedline(stale.db, caller, "p1", ID, "r1", { decision: "aceito" })).toMatchObject({ ok: false, kind: "conflict", code: "stale_analysis" });

        const decided = scriptedDb([
            { table: "contract_analyses", data: analysis() },
            { table: "contract_analysis_decisions", data: { redline_id: "r1" } },
        ]);
        expect(await decideAnalysisRedline(decided.db, caller, "p1", ID, "r1", { decision: "aceito" })).toMatchObject({ ok: false, kind: "conflict" });

        documents.applyTrackedEditsToDocument.mockResolvedValueOnce({ ok: false });
        const unplaced = scriptedDb([
            { table: "contract_analyses", data: analysis() },
            { table: "contract_analysis_decisions", data: null },
        ]);
        expect(await decideAnalysisRedline(unplaced.db, caller, "p1", ID, "r1", { decision: "aceito" })).toMatchObject({ ok: false, kind: "conflict" });

        expect(await decideAnalysisRedline(scriptedDb([]).db, caller, "p1", ID, "r1", { decision: "talvez" })).toMatchObject({ ok: false, kind: "validation" });
        expect(await decideAnalysisRedline(scriptedDb([]).db, caller, "p1", ID, "r1", { decision: "editado" })).toMatchObject({ ok: false, kind: "validation" });
        const missing = scriptedDb([{ table: "contract_analyses", data: analysis() }]);
        expect(await decideAnalysisRedline(missing.db, caller, "p1", ID, "r9", { decision: "aceito" })).toMatchObject({ ok: false, kind: "not_found" });
    });

    it("lets the second of two people deciding at once lose", async () => {
        const fake = scriptedDb([
            { table: "contract_analyses", data: analysis() },
            { table: "contract_analysis_decisions", data: null },
            { table: "user_profiles", data: null },
            { table: "contract_analysis_decisions", op: "insert", error: { code: "23505" } },
        ]);
        expect(await decideAnalysisRedline(fake.db, caller, "p1", ID, "r2", { decision: "rejeitado" })).toMatchObject({ ok: false, kind: "conflict" });
    });
});

describe("export", () => {
    it("writes the analyst's layout, with decisions applied and rejected redlines left out", () => {
        const md = analysisMarkdown("Contrato Exemplo", result, [
            { redline_id: "r1", decision: "editado", edited_text: "multa de 5%", reason: null, decided_by: "x", decided_at: "", edit: null },
            { redline_id: "r2", decision: "rejeitado", edited_text: null, reason: "não", decided_by: "x", decided_at: "", edit: null },
        ]);
        expect(md.split("\n").slice(0, 2)).toEqual(["📋 *Análise — Contrato Exemplo*", `_${result.notice}_`]);
        for (const heading of ["*Resumo executivo*", "🔴 *Riscos críticos*", "🟡 *Pontos de atenção*", "🟢 *Pontos favoráveis*", "📌 *Sugestões de redline*", "*Conformidade*", "❓ *Pontos abertos*"])
            expect(md).toContain(heading);
        expect(md).toContain('- *Multa alta* (cl. 5.1): "multa de 50%"');
        expect(md).toContain('PARA: "multa de 5%"');
        expect(md).not.toContain("prazo de 30 dias");
        expect(md).toContain("- Aprovação do founder. (depende de: founder)");
        expect(md).toContain("🟡 *Pontos de atenção*\n- Nenhum.");
    });

    it("builds a Word file from it", async () => {
        const file = await analysisDocx(analysisMarkdown("Contrato Exemplo", result));
        expect(file.subarray(0, 2).toString()).toBe("PK");
    });

    it("exports for the legal team with the contract's name, and lists decisions", async () => {
        const fake = scriptedDb([
            { table: "contract_analyses", data: analysis() },
            { table: "projects", data: { name: "Contrato / Exemplo" } },
            { table: "contract_analysis_decisions", data: [] },
        ]);
        const exported = await exportAnalysis(fake.db, caller, "p1", ID);
        expect(exported).toMatchObject({ ok: true, data: { filename: "Análise - Contrato   Exemplo" } });
        const listed = scriptedDb([
            { table: "contract_analyses", data: analysis() },
            { table: "contract_analysis_decisions", data: [{ redline_id: "r1", decision: "aceito" }] },
        ]);
        expect(await listRedlineDecisions(listed.db, caller, "p1", ID)).toMatchObject({ ok: true, data: [{ redline_id: "r1" }] });
        shared.requireContractEdit.mockResolvedValueOnce({ ok: false, kind: "forbidden" });
        expect(await exportAnalysis(scriptedDb([]).db, caller, "p1", ID)).toMatchObject({ ok: false });
        const notDone = scriptedDb([{ table: "contract_analyses", data: analysis({ status: "running", result: null }) }]);
        expect(await exportAnalysis(notDone.db, caller, "p1", ID)).toMatchObject({ ok: false, kind: "not_found" });
    });
});
