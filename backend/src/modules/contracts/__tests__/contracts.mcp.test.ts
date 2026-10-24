// The contract document and activity MCP tools, and getContractText under
// them: access is the project view check, the text comes from the documents
// facade (which rechecks access), and pages never exceed 30k characters.
// Fictional contracts only.

import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({ requireProjectView: vi.fn() }));
vi.mock("../contracts.shared", async (orig) => ({ ...(await orig<object>()), requireProjectView: shared.requireProjectView }));
const documents = vi.hoisted(() => ({ findDocumentText: vi.fn(), readStoredDocumentText: vi.fn() }));
vi.mock("../../documents/documents.service", () => documents);
vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn(async () => undefined) }));

import { failure, ok } from "../../../lib/serviceResult";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { runToolForTest } from "../../mcp/__tests__/runToolForTest";
import { CONTRACT_TOOLS } from "../contracts.mcp";
import { getContractText, TEXT_PAGE } from "../contracts.text";
import { recordAgentRead } from "../contracts.events";

const P1 = "00000000-0000-4000-a000-000000000001";
const caller = { userId: "00000000-0000-4000-b000-000000000001", userEmail: "ana@exemplo.test" };
const tool = (name: string) => CONTRACT_TOOLS.find((t) => t.name === name)!;

const docSteps = () => [
    { table: "documents", data: [{ id: "d1", project_id: P1 }] },
    {
        table: "document_versions",
        data: [
            { id: "v1", document_id: "d1", filename: "nda-v1.docx", version_number: 1, deleted_at: null },
            { id: "v3", document_id: "d1", filename: "nda-v3.docx", version_number: 3, deleted_at: "2026-10-01" },
            { id: "v2", document_id: "d1", filename: "nda-v2.docx", version_number: 2, deleted_at: null },
        ],
    },
];

beforeEach(() => {
    shared.requireProjectView.mockReset().mockResolvedValue({ ok: true, access: {} });
    documents.findDocumentText.mockReset();
    documents.readStoredDocumentText.mockReset();
    process.env.FRONTEND_URL = "https://mike.exemplo.test";
});

describe("getContractText", () => {
    it("reads the current, not deleted, version through the documents facade, one page at a time", async () => {
        const text = "a".repeat(TEXT_PAGE) + "b".repeat(10);
        documents.readStoredDocumentText.mockResolvedValue({ revision: "r", status: "ready", text, textless_page_count: 0 });
        const fake = scriptedDb(docSteps());
        const first = await getContractText(fake.db, caller, P1);
        expect(documents.readStoredDocumentText).toHaveBeenCalledWith(fake.db, { userId: caller.userId, userEmail: caller.userEmail, documentId: "d1", versionId: "v2" });
        expect(first).toMatchObject({ ok: true, data: { filename: "nda-v2.docx", version_number: 2, status: "ready", page: 1, pages: 2 } });
        expect(first.ok && first.data!.text!.length).toBe(TEXT_PAGE);
        expect(fake.calls[0].filters).toContainEqual(["is", "archived_at", null]);

        const second = await getContractText(scriptedDb(docSteps()).db, caller, P1, { page: 2 });
        expect(second.ok && second.data!.text).toBe("b".repeat(10));
        expect(await getContractText(scriptedDb(docSteps()).db, caller, P1, { page: 3 })).toMatchObject({ kind: "validation", detail: "O texto tem 2 página(s)." });
        expect(await getContractText(scriptedDb([]).db, caller, P1, { page: 0 })).toMatchObject({ kind: "validation" });
    });

    it("stops at the project view check: nothing is read for a contract the person cannot open", async () => {
        shared.requireProjectView.mockResolvedValue(failure("not_found", "Não encontrei este contrato."));
        const fake = scriptedDb([]);
        expect(await getContractText(fake.db, caller, P1)).toMatchObject({ kind: "not_found" });
        expect(fake.calls).toEqual([]);
        expect(documents.readStoredDocumentText).not.toHaveBeenCalled();
    });

    it("says when there is no document or the text is not ready, and treats a refused read as not found", async () => {
        expect(await getContractText(scriptedDb([{ table: "documents", data: [] }]).db, caller, P1)).toEqual({ ok: true, data: null });
        documents.readStoredDocumentText.mockResolvedValueOnce({ revision: "r", status: "processing", text: null, textless_page_count: null });
        expect(await getContractText(scriptedDb(docSteps()).db, caller, P1)).toMatchObject({ ok: true, data: { status: "processing", text: null, pages: 0 } });
        documents.readStoredDocumentText.mockResolvedValueOnce(null);
        expect(await getContractText(scriptedDb(docSteps()).db, caller, P1)).toMatchObject({ kind: "not_found" });
        documents.readStoredDocumentText.mockRejectedValueOnce(new Error("rpc down"));
        expect(await getContractText(scriptedDb(docSteps()).db, caller, P1)).toMatchObject({ ok: false, kind: "error" });
    });

    it("finds passages in the current version", async () => {
        documents.findDocumentText.mockResolvedValue(ok({ matches: [{ start_char: 120, excerpt: "…multa de 10%…" }], next_offset: null, coverage: {} }));
        const r = await getContractText(scriptedDb(docSteps()).db, caller, P1, { find: "multa" });
        expect(documents.findDocumentText).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: "document", query: "multa", documentId: "d1", versionId: "v2", userId: caller.userId }));
        expect(r).toMatchObject({ ok: true, data: { matches: [{ start: 120, excerpt: "…multa de 10%…" }] } });
        documents.findDocumentText.mockResolvedValue(failure("validation", "Choose a scope…"));
        expect(await getContractText(scriptedDb(docSteps()).db, caller, P1, { find: "x" })).toMatchObject({ kind: "validation", detail: "Busque um trecho de 2 a 500 caracteres." });
    });
});

describe("mike_contratos_documento", () => {
    it("returns the page with a link and a Portuguese summary", async () => {
        documents.readStoredDocumentText.mockResolvedValue({ revision: "r", status: "ready", text: "Cláusula 1. Objeto.", textless_page_count: 0 });
        const { db } = scriptedDb(docSteps());
        const { result } = await runToolForTest(tool("mike_contratos_documento"), { project_id: P1 }, { db });
        expect(result.structuredContent).toMatchObject({ text: "Cláusula 1. Objeto.", link: `https://mike.exemplo.test/projects/${P1}/review` });
        expect(result.content).toEqual([{ type: "text", text: "nda-v2.docx: página 1 de 1." }]);
    });

    it("enters the contract's feed once per agent and person", async () => {
        documents.readStoredDocumentText.mockResolvedValue({ revision: "r", status: "ready", text: "Cláusula 1.", textless_page_count: 0 });
        const fake = scriptedDb([
            ...docSteps(),
            { table: "card_events", data: [] },
            { table: "projects", data: { org_id: null } },
            { table: "card_events", op: "insert", data: { id: 1 } },
        ]);
        await runToolForTest(tool("mike_contratos_documento"), { project_id: P1 }, { db: fake.db });
        expect(fake.calls[4].payload).toMatchObject({ action: "mcp.read", actor_name: "claude-code em nome de Ana Teste", after: { ferramenta: "mike_contratos_documento" } });
        fake.done();
    });

    it("summarises passages, a missing document and a text not ready", async () => {
        documents.findDocumentText.mockResolvedValue(ok({ matches: [{ start_char: 1, excerpt: "x" }], next_offset: null, coverage: {} }));
        expect((await runToolForTest(tool("mike_contratos_documento"), { project_id: P1, buscar: "multa" }, { db: scriptedDb(docSteps()).db })).result.content).toEqual([{ type: "text", text: "1 trecho(s) encontrados em nda-v2.docx." }]);
        expect((await runToolForTest(tool("mike_contratos_documento"), { project_id: P1 }, { db: scriptedDb([{ table: "documents", data: [] }]).db })).result.content).toEqual([{ type: "text", text: "Este contrato ainda não tem documento." }]);
        documents.readStoredDocumentText.mockResolvedValue({ revision: "r", status: "pending", text: null, textless_page_count: null });
        expect((await runToolForTest(tool("mike_contratos_documento"), { project_id: P1 }, { db: scriptedDb(docSteps()).db })).result.content).toEqual([{ type: "text", text: "O texto de nda-v2.docx ainda não está pronto para leitura (pending)." }]);
    });
});

describe("mike_contratos_atividade", () => {
    it("lists the card's events newest first, people and agents in one timeline", async () => {
        const fake = scriptedDb([
            {
                table: "card_events",
                data: [
                    { id: 2, project_id: P1, at: "2026-10-21T10:00:00Z", actor_type: "agent", actor_id: "mcp:codex", actor_name: "codex em nome de Ana Teste", on_behalf_of: "ana@exemplo.test", action: "mcp.read", field: null, before: null, after: null, run_id: null, source: "mcp" },
                    { id: 1, project_id: P1, at: "2026-10-20T09:00:00Z", actor_type: "user", actor_id: "u2", actor_name: null, on_behalf_of: null, action: "lane.changed", field: "lane", before: "entrada", after: "triagem", run_id: null, source: "ui" },
                ],
            },
        ]);
        const { result } = await runToolForTest(tool("mike_contratos_atividade"), { project_id: P1, limite: 5 }, { db: fake.db });
        expect(fake.calls[0].filters).toContainEqual(["limit", 5]);
        expect(result.structuredContent).toMatchObject({
            eventos: [
                { em: "2026-10-21T10:00:00Z", ator: "codex em nome de Ana Teste", em_nome_de: "ana@exemplo.test", origem: "mcp" },
                { ator: "pessoa", acao: "lane.changed", campo: "lane", antes: "entrada", depois: "triagem" },
            ],
        });
        expect(result.content).toEqual([{ type: "text", text: "2 evento(s), o mais recente em 2026-10-21." }]);
        // Reading the feed is not itself an event: only the card_events read above ran.
        fake.done();
        expect((await runToolForTest(tool("mike_contratos_atividade"), { project_id: P1 }, { db: scriptedDb([{ table: "card_events", data: [] }]).db })).result.content).toEqual([{ type: "text", text: "Nenhuma atividade registrada." }]);
    });

    it("stops at the project view check", async () => {
        shared.requireProjectView.mockResolvedValue(failure("not_found", "Não encontrei este contrato."));
        const { result } = await runToolForTest(tool("mike_contratos_atividade"), { project_id: P1 }, { db: scriptedDb([]).db });
        expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "not_found" } } });
    });
});

describe("recordAgentRead", () => {
    const read = { projectId: P1, actorId: "mcp:codex", actorName: "codex em nome de Ana Teste", onBehalfOf: "ana@exemplo.test", tool: "mike_contratos_ficha" };
    const NOW = new Date("2026-10-21T12:00:00Z");

    it("writes one mcp.read in the contract's org, unless the same agent read it for the same person in the last 10 minutes", async () => {
        const fresh = scriptedDb([
            { table: "card_events", data: [] },
            { table: "projects", data: { org_id: "org-1" } },
            { table: "card_events", op: "insert", data: { id: 7 } },
        ]);
        await recordAgentRead(fresh.db, read, NOW);
        expect(fresh.calls[0].filters).toEqual([
            ["eq", "project_id", P1],
            ["eq", "actor_id", "mcp:codex"],
            ["eq", "on_behalf_of", "ana@exemplo.test"],
            ["eq", "action", "mcp.read"],
            ["gte", "at", "2026-10-21T11:50:00.000Z"],
            ["limit", 1],
        ]);
        expect(fresh.calls[2].payload).toMatchObject({
            project_id: P1,
            org_id: "org-1",
            actor_type: "agent",
            actor_id: "mcp:codex",
            actor_name: "codex em nome de Ana Teste",
            on_behalf_of: "ana@exemplo.test",
            action: "mcp.read",
            after: { ferramenta: "mike_contratos_ficha" },
            source: "mcp",
        });
        fresh.done();

        const recent = scriptedDb([{ table: "card_events", data: [{ id: 6 }] }]);
        await recordAgentRead(recent.db, read, NOW);
        recent.done();
    });

    it("never fails the read it describes", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const broken = scriptedDb([{ table: "card_events", error: { message: "down" } }]);
        await expect(recordAgentRead(broken.db, read, NOW)).resolves.toBeUndefined();
        spy.mockRestore();
    });
});

