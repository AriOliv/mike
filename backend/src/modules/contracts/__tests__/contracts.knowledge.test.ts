import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const access = vi.hoisted(() => ({
    checkProjectAccess: vi.fn(),
    listAccessibleProjectIds: vi.fn(),
}));
vi.mock("../../../lib/access", () => access);

const llm = vi.hoisted(() => ({ completeText: vi.fn() }));
vi.mock("../../../lib/llm", async (actual) => ({
    ...(await actual<typeof import("../../../lib/llm")>()),
    completeText: llm.completeText,
}));

const docs = vi.hoisted(() => ({ findDocumentText: vi.fn(), readStoredDocumentText: vi.fn() }));
vi.mock("../../documents/documents.service", async (actual) => ({
    ...(await actual<typeof import("../../documents/documents.service")>()),
    ...docs,
}));

const web = vi.hoisted(() => ({ searchWeb: vi.fn(), readWebPage: vi.fn() }));
vi.mock("../../../lib/webSearch", async (actual) => ({
    ...(await actual<typeof import("../../../lib/webSearch")>()),
    ...web,
}));

const files = vi.hoisted(() => ({ downloadFile: vi.fn(), extractPdfText: vi.fn() }));
vi.mock("../../../lib/storage", async (actual) => ({
    ...(await actual<typeof import("../../../lib/storage")>()),
    downloadFile: files.downloadFile,
}));
vi.mock("../../../lib/pdfText", async (actual) => ({
    ...(await actual<typeof import("../../../lib/pdfText")>()),
    extractPdfText: files.extractPdfText,
}));

const settings = vi.hoisted(() => ({
    value: {} as Record<string, unknown>,
}));
vi.mock("../../user/user.service", () => ({
    getUserModelSettings: vi.fn(async () => settings.value),
}));

import { askAcervo } from "../contracts.service";
import { SEARCH_BUDGET } from "../contracts.acervo";
import {
    findOccurrences,
    isOfficialLawUrl,
    locateQuote,
    passageWindows,
    questionTerms,
} from "../contracts.knowledge";

const caller = { userId: "u", userEmail: "u@example.com" };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P1 = uuid(1);
const P2 = uuid(2);
const P3 = uuid(3);
const D1 = uuid(101);
const V1 = uuid(201);

const project = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    counterparty: null,
    contract_type: null,
    org_id: null,
    ...extra,
});

const CLAUSE =
    "11.2. A mudança de controle societário da CONTRATADA dependerá de prévia autorização por escrito da CONTRATANTE.";
const FILLER = "Disposições gerais sem relevância para a pergunta. ".repeat(400);
const FULL_TEXT = `${FILLER}${CLAUSE} ${FILLER}`;
const CLAUSE_AT = FILLER.length;

const coverage = (indexed = 1, total = 1) => ({
    total_versions: total,
    indexed_versions: indexed,
    pending_versions: total - indexed,
    failed_versions: 0,
    versions_needing_ocr: 0,
});

const hit = (documentId = D1, versionId = V1) => ({
    ok: true as const,
    data: {
        matches: [
            {
                document_id: documentId,
                version_id: versionId,
                version_number: 1,
                revision: "r",
                filename: "c.pdf",
                file_type: "pdf",
                storage_path: "x",
                library_kind: "file",
                start_char: CLAUSE_AT + 9,
                end_char: CLAUSE_AT + 28,
                excerpt_start_char: CLAUSE_AT,
                excerpt: CLAUSE,
            },
        ],
        next_offset: null,
        coverage: coverage(),
    },
});
const miss = (indexed = 1, total = 1) => ({
    ok: true as const,
    data: { matches: [], next_offset: null, coverage: coverage(indexed, total) },
});

const modelAnswer = (body: Record<string, unknown>) => llm.completeText.mockResolvedValueOnce(JSON.stringify(body));

beforeEach(() => {
    vi.clearAllMocks();
    access.listAccessibleProjectIds.mockReset();
    docs.findDocumentText.mockReset();
    docs.readStoredDocumentText.mockReset();
    llm.completeText.mockReset();
    settings.value = {
        tabular_model: "test-model",
        last_selected_chat_model: null,
        web_search: { enabled: false, claude: "provider", openai: "provider", other: "off" },
        api_keys: {},
    };
});

describe("question terms", () => {
    it("expands legal concepts into the phrasings contracts use", () => {
        expect(questionTerms("Quais contratos têm cláusula de mudança de controle?")).toEqual([
            "mudança de controle",
            "alteração de controle",
            "change of control",
            "controle societário",
        ]);
        // Concepts in the order the question names them, synonyms interleaved.
        expect(questionTerms("Os contratos preveem renovação automática e multa?")).toEqual([
            "renovação automática",
            "multa",
            "renovado automaticamente",
            "penalidade",
            "prorrogação automática",
        ]);
        expect(questionTerms("tratamento de dados pessoais (LGPD)")).toContain("LGPD");
        expect(questionTerms("Quem pode ceder o contrato?")[0]).toBe("cessão");
        expect(questionTerms("Qual a jurisdição?")).toEqual(["foro", "jurisdição", "comarca"]);
        expect(questionTerms("aviso prévio para denúncia")).toEqual(
            expect.arrayContaining(["aviso prévio", "denúncia"]),
        );
        expect(questionTerms("responsabilidade limitada do fornecedor")[0]).toBe("limitação de responsabilidade");
    });

    it("falls back to the question's own words, accents kept", () => {
        expect(questionTerms("Qual o prazo de vigência da Acme?")).toEqual(["prazo", "vigência", "acme"]);
        expect(questionTerms("o que é?")).toEqual([]);
    });
});

describe("passages and quotes", () => {
    it("finds occurrences ignoring accents and merges nearby windows", () => {
        const text = "abc Mudanca de Controle xyz ... mudança de controle";
        expect(findOccurrences(text, ["mudança de controle"]).map((o) => o.start)).toEqual([4, 32]);
        expect(passageWindows(10000, [{ start: 100, end: 110 }, { start: 900, end: 910 }], { radius: 500 })).toEqual([
            { start: 0, end: 1410 },
        ]);
        const far = passageWindows(100000, [10, 50000, 90000].map((s) => ({ start: s, end: s + 5 })), {
            radius: 100,
            maxWindows: 2,
        });
        expect(far).toHaveLength(2);
    });

    it("verifies a quote exactly, then ignoring case, accents and whitespace, and refuses an invented one", () => {
        expect(locateQuote(FULL_TEXT, CLAUSE)).toEqual({ start: CLAUSE_AT, end: CLAUSE_AT + CLAUSE.length });
        const sloppy = "“a  MUDANCA de controle\nsocietario da contratada”";
        expect(locateQuote(FULL_TEXT, sloppy)?.start).toBe(CLAUSE_AT + 6);
        expect(locateQuote(FULL_TEXT, "A mudança de controle ... autorização por escrito")).not.toBeNull();
        expect(locateQuote(FULL_TEXT, "A cessão depende de autorização prévia")).toBeNull();
        expect(locateQuote(FULL_TEXT, "...")).toBeNull();
    });

    it("accepts only official Brazilian sources for legislation", () => {
        expect(isOfficialLawUrl("https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm")).toBe(true);
        expect(isOfficialLawUrl("https://www.gov.br/anpd/pt-br")).toBe(true);
        expect(isOfficialLawUrl("https://www.gov.br/receitafederal")).toBe(false);
        expect(isOfficialLawUrl("https://planalto.gov.br.evil.com/x")).toBe(false);
        expect(isOfficialLawUrl("not a url")).toBe(false);
        expect(isOfficialLawUrl("https://www.gov.br/anpdx/fake")).toBe(false);
        expect(isOfficialLawUrl("https://qualquer.gov.br/anpd/x")).toBe(false);
        expect(isOfficialLawUrl("https://www.gov.br/anpd")).toBe(true);
        expect(isOfficialLawUrl("https://evilplanalto.gov.br/x")).toBe(false);
        expect(isOfficialLawUrl("ftp://planalto.gov.br/x")).toBe(false);
    });
});

describe("askAcervo", () => {
    it("answers from numbered passages, verifies the quotes and flags the invented one", async () => {
        access.listAccessibleProjectIds.mockResolvedValue([P1, P2]);
        const fake = scriptedDb([
            { table: "projects", data: [project(P1, "MSA Acme", { counterparty: "Acme" }), project(P2, "NDA Beta")] },
            { table: "dossiers", data: [] },
        ]);
        docs.findDocumentText.mockImplementation(async (_db, args) => (args.projectId === P1 ? hit() : miss()));
        docs.readStoredDocumentText.mockResolvedValue({ revision: "r", status: "ready", text: FULL_TEXT, textless_page_count: 0 });
        modelAnswer({
            answer: "Só o MSA Acme exige autorização [1]. Também prevê multa [2].",
            found: true,
            sources: [
                { n: 1, passage: "P1", project_id: P1, ref: "cl. 11.2", quote: CLAUSE },
                { n: 2, passage: "P1", project_id: P1, ref: "cl. 12", quote: "multa de 20% sobre o valor total" },
            ],
            matches: [{ project_id: P1, hit: true, quote: CLAUSE }],
        });

        const result = await askAcervo(fake.db, caller, { question: "Quais contratos têm mudança de controle?" });
        fake.done();
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const data = result.data;

        const prompt = llm.completeText.mock.calls[0][0].user as string;
        expect(prompt).toMatch(new RegExp(`\\[P1\\] contrato id=${P1} · MSA Acme — contraparte: Acme · caracteres \\d+–\\d+`));
        expect(prompt).not.toContain("[P2]");
        // The middle of a long contract is read, not just its head and tail.
        expect(prompt).toContain(CLAUSE);
        expect(FULL_TEXT.length).toBeGreaterThan(24000);

        // [2] cites a clause the contract does not have: the answer is not found.
        expect(data.found).toBe(false);
        expect(data.searched).toBe(1);
        expect(data.sources).toEqual([
            expect.objectContaining({ n: 1, project_id: P1, document_id: D1, verified: true, start_char: CLAUSE_AT, end_char: CLAUSE_AT + CLAUSE.length }),
            expect.objectContaining({ n: 2, verified: false, start_char: null }),
        ]);
        expect(data.aggregate).toBe(true);
        expect(data.total).toBe(2);
        expect(data.matches).toEqual([
            expect.objectContaining({ project_id: P1, hit: true, verified: true, basis: "lido", counterparty: "Acme" }),
            expect.objectContaining({ project_id: P2, hit: false, basis: "busca" }),
        ]);
        expect(data.coverage).toMatchObject({ total_versions: 2, indexed_versions: 2, contracts_pending: 0 });
        expect(data.law_available).toBe(false);
    });

    it("finds the answer when every cited source checks out, drops a repeated number and an unchecked hit", async () => {
        access.listAccessibleProjectIds.mockResolvedValue([P1]);
        const fake = scriptedDb([
            { table: "projects", data: [project(P1, "MSA Acme")] },
            { table: "dossiers", data: [] },
        ]);
        docs.findDocumentText.mockResolvedValue(hit());
        docs.readStoredDocumentText.mockResolvedValue({ revision: "r", status: "ready", text: FULL_TEXT, textless_page_count: 0 });
        modelAnswer({
            answer: "O MSA Acme exige autorização [1].",
            found: true,
            sources: [
                { n: 1, passage: "P1", project_id: P1, quote: CLAUSE },
                { n: 1, passage: "P1", project_id: P1, quote: "outra coisa citada com o mesmo número" },
            ],
            matches: [{ project_id: P1, hit: true, quote: "trecho que o contrato não tem de jeito nenhum" }],
        });
        const result = await askAcervo(fake.db, caller, { question: "mudança de controle" });
        fake.done();
        if (!result.ok) throw new Error("expected ok");
        expect(result.data.found).toBe(true);
        expect(result.data.sources).toHaveLength(1);
        // The model's unverifiable "hit" does not override the literal search.
        expect(result.data.matches[0]).toMatchObject({ project_id: P1, basis: "busca" });
    });

    it("says found=false when no source can be verified", async () => {
        access.listAccessibleProjectIds.mockResolvedValue([P1]);
        const fake = scriptedDb([
            { table: "projects", data: [project(P1, "MSA Acme")] },
            { table: "dossiers", data: [] },
        ]);
        docs.findDocumentText.mockResolvedValue(hit());
        docs.readStoredDocumentText.mockResolvedValue({ revision: "r", status: "ready", text: FULL_TEXT, textless_page_count: 0 });
        modelAnswer({
            answer: "Exige notificação de 90 dias [1].",
            found: true,
            sources: [{ n: 1, passage: "P1", project_id: P1, quote: "aviso prévio de 90 dias" }],
            matches: [],
        });
        const result = await askAcervo(fake.db, caller, { question: "mudança de controle" });
        fake.done();
        expect(result).toMatchObject({ ok: true, data: { found: false, sources: [{ verified: false }] } });
    });

    it("does not call the model when no contract contains the phrases", async () => {
        access.listAccessibleProjectIds.mockResolvedValue([P1, P2]);
        const fake = scriptedDb([
            { table: "projects", data: [project(P1, "MSA Acme"), project(P2, "NDA Beta")] },
            { table: "dossiers", data: [] },
        ]);
        docs.findDocumentText.mockResolvedValue(miss());
        const result = await askAcervo(fake.db, caller, { question: "Há cláusula de exclusividade?" });
        fake.done();
        expect(llm.completeText).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            ok: true,
            data: { found: false, sources: [], searched: 0, total: 2, matches: [{ hit: false }, { hit: false }] },
        });
    });

    it("keeps the full-text search within its call budget", async () => {
        const ids = Array.from({ length: 50 }, (_, i) => uuid(i + 1));
        access.listAccessibleProjectIds.mockResolvedValue(ids);
        const fake = scriptedDb([
            { table: "projects", data: ids.map((id, i) => project(id, `Contrato ${i}`)) },
            { table: "dossiers", data: [] },
        ]);
        docs.findDocumentText.mockResolvedValue(miss());
        const result = await askAcervo(fake.db, caller, {
            question: "Quais têm mudança de controle?",
        });
        fake.done();
        expect(docs.findDocumentText.mock.calls.length).toBe(SEARCH_BUDGET);
        expect(result.ok && result.data.coverage.contracts_not_searched).toBe(0);
        // Every call is scoped to one project, as the caller.
        for (const [, args] of docs.findDocumentText.mock.calls) {
            expect(args).toMatchObject({ scope: "project", userId: "u", workspace: "personal" });
        }

        // More contracts than the budget: the rest are reported, not guessed.
        const many = Array.from({ length: 80 }, (_, i) => uuid(i + 1));
        access.listAccessibleProjectIds.mockResolvedValue(many);
        docs.findDocumentText.mockClear();
        const fake2 = scriptedDb([
            { table: "projects", data: many.map((id, i) => project(id, `Contrato ${i}`)) },
            { table: "dossiers", data: [] },
        ]);
        const result2 = await askAcervo(fake2.db, caller, { question: "mudança de controle" });
        fake2.done();
        expect(docs.findDocumentText.mock.calls.length).toBe(SEARCH_BUDGET);
        expect(result2.ok && result2.data.coverage.contracts_not_searched).toBe(20);
        expect(result2.ok && result2.data.matches.filter((m) => m.basis === "nao_buscado")).toHaveLength(20);
    });

    it("filters by counterparty, type and ids", async () => {
        access.listAccessibleProjectIds.mockResolvedValue([P1, P2, P3]);
        const rows = [
            project(P1, "MSA", { counterparty: "Acme Ltda", contract_type: "MSA" }),
            project(P2, "NDA", { counterparty: "Beta", contract_type: "NDA" }),
            project(P3, "NDA 2", { counterparty: "Acme Ltda", contract_type: "NDA" }),
        ];
        docs.findDocumentText.mockResolvedValue(miss());

        const fake = scriptedDb([{ table: "projects", data: rows }, { table: "dossiers", data: [] }]);
        const byCounterparty = await askAcervo(fake.db, caller, { question: "foro", scope: { counterparty: "acme" } });
        expect(byCounterparty.ok && byCounterparty.data.matches.map((m) => m.project_id).sort()).toEqual([P1, P3]);

        const fake2 = scriptedDb([{ table: "projects", data: rows }, { table: "dossiers", data: [] }]);
        const byType = await askAcervo(fake2.db, caller, {
            question: "foro",
            scope: { counterparty: "acme", contract_type: "nda" },
        });
        expect(byType.ok && byType.data.matches.map((m) => m.project_id)).toEqual([P3]);

        const fake3 = scriptedDb([{ table: "projects", data: [rows[1]] }, { table: "dossiers", data: [] }]);
        await askAcervo(fake3.db, caller, { question: "foro", scope: { project_ids: [P2, uuid(999)] } });
        // Only ids the caller can see are queried.
        expect(fake3.calls[0].filters).toContainEqual(["in", "id", [P2]]);

        expect(await askAcervo(scriptedDb([]).db, caller, { question: "foro", scope: { project_ids: ["x"] } })).toMatchObject({
            ok: false,
            kind: "validation",
        });
        expect(await askAcervo(scriptedDb([]).db, caller, { question: "foro", scope: 3 })).toMatchObject({
            ok: false,
            kind: "validation",
        });
    });

    it("reads the files when the text index is not available, and reports pending indexing", async () => {
        access.listAccessibleProjectIds.mockResolvedValue([P1, P2]);
        const fake = scriptedDb([
            { table: "projects", data: [project(P1, "MSA Acme"), project(P2, "NDA Beta")] },
            { table: "dossiers", data: [] },
            { table: "documents", data: [{ id: D1, project_id: P1 }] },
            {
                table: "document_versions",
                data: [{ document_id: D1, storage_path: "a.pdf", pdf_storage_path: null, filename: "a.pdf", version_number: 1, deleted_at: null }],
            },
        ]);
        docs.findDocumentText.mockResolvedValue({ ok: false, kind: "error", error: { code: "PGRST202" } });
        files.downloadFile.mockResolvedValue(Buffer.from("pdf"));
        files.extractPdfText.mockResolvedValue(FULL_TEXT);
        modelAnswer({
            answer: "Exige autorização [1].",
            found: true,
            sources: [{ n: 1, passage: "P1", project_id: P1, quote: CLAUSE }],
            matches: [{ project_id: P1, hit: true, quote: CLAUSE }],
        });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const result = await askAcervo(fake.db, caller, { question: "mudança de controle" });
        warn.mockRestore();
        fake.done();
        // The search stopped at the first failure instead of spending the budget.
        expect(docs.findDocumentText.mock.calls.length).toBeLessThanOrEqual(2);
        expect(result).toMatchObject({
            ok: true,
            data: { found: true, searched: 1, sources: [{ verified: true, start_char: CLAUSE_AT }] },
        });
        expect(result.ok && result.data.matches.find((m) => m.project_id === P2)?.basis).toBe("pendente");
    });

    it("uses the index excerpt with true offsets when the stored text is not ready", async () => {
        access.listAccessibleProjectIds.mockResolvedValue([P1, P2]);
        const fake = scriptedDb([
            { table: "projects", data: [project(P1, "MSA Acme"), project(P2, "NDA Beta")] },
            { table: "dossiers", data: [] },
        ]);
        docs.findDocumentText.mockImplementation(async (_db, args) => (args.projectId === P1 ? hit() : miss(0, 1)));
        docs.readStoredDocumentText.mockResolvedValue({ revision: "r", status: "processing", text: null, textless_page_count: null });
        modelAnswer({
            answer: "Exige autorização [1].",
            found: true,
            sources: [{ n: 1, passage: "P1", project_id: P1, quote: CLAUSE }],
            matches: [{ project_id: P1, hit: true, quote: CLAUSE }],
        });
        const result = await askAcervo(fake.db, caller, { question: "mudança de controle" });
        fake.done();
        expect(result).toMatchObject({
            ok: true,
            data: {
                found: true,
                sources: [{ verified: true, start_char: CLAUSE_AT, end_char: CLAUSE_AT + CLAUSE.length }],
                coverage: { contracts_pending: 1, pending_versions: 1 },
            },
        });
        expect(llm.completeText.mock.calls[0][0].user).toContain(`caracteres ${CLAUSE_AT}–`);
    });

    it("returns a generic failure, not the model's output, when the answer is not JSON", async () => {
        access.listAccessibleProjectIds.mockResolvedValue([P1]);
        const fake = scriptedDb([
            { table: "projects", data: [project(P1, "MSA Acme")] },
            { table: "dossiers", data: [] },
        ]);
        docs.findDocumentText.mockResolvedValue(hit());
        docs.readStoredDocumentText.mockResolvedValue({ revision: "r", status: "ready", text: FULL_TEXT, textless_page_count: 0 });
        llm.completeText.mockResolvedValueOnce("desculpe, não sei");
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const result = await askAcervo(fake.db, caller, { question: "mudança de controle" });
        warn.mockRestore();
        expect(result).toMatchObject({ ok: false, kind: "error" });
    });

    describe("legislation", () => {
        const withSearch = () => {
            settings.value = {
                ...settings.value,
                web_search: { enabled: true, claude: "brave", openai: "brave", other: "brave" },
                api_keys: { brave: "test-key" },
            };
        };
        const LAW = "Art. 7º O tratamento de dados pessoais somente poderá ser realizado nas seguintes hipóteses";

        it("cites only official pages, with their URL", async () => {
            withSearch();
            access.listAccessibleProjectIds.mockResolvedValue([P1]);
            const fake = scriptedDb([
                { table: "projects", data: [project(P1, "DPA Acme")] },
                { table: "dossiers", data: [] },
            ]);
            docs.findDocumentText.mockResolvedValue(hit());
            docs.readStoredDocumentText.mockResolvedValue({ revision: "r", status: "ready", text: FULL_TEXT, textless_page_count: 0 });
            web.searchWeb.mockResolvedValue([
                { url: "https://blog.example.com/lgpd", title: "Blog", snippet: "opinião" },
                { url: "https://www.planalto.gov.br/ccivil_03/lei/l13709.htm", title: "Lei 13.709", snippet: LAW },
            ]);
            web.readWebPage.mockResolvedValue({ url: "https://www.planalto.gov.br/ccivil_03/lei/l13709.htm", title: null, text: `Preâmbulo. ${LAW}: I - mediante consentimento.` });
            modelAnswer({
                answer: "A LGPD lista as bases legais [1]; o DPA exige autorização [2].",
                found: true,
                sources: [
                    { n: 1, passage: "L1", project_id: null, ref: "art. 7º", quote: LAW },
                    { n: 2, passage: "P1", project_id: P1, quote: CLAUSE },
                ],
                matches: [],
            });
            const result = await askAcervo(fake.db, caller, { question: "dados pessoais e mudança de controle", include_law: true });
            fake.done();
            expect(web.searchWeb.mock.calls[0][0]).toContain("site:planalto.gov.br");
            expect(llm.completeText.mock.calls[0][0].user).not.toContain("blog.example.com");
            expect(result).toMatchObject({
                ok: true,
                data: {
                    law_available: true,
                    law_sources: [{ n: 1, url: "https://www.planalto.gov.br/ccivil_03/lei/l13709.htm", verified: true }],
                    sources: [{ n: 2, verified: true }],
                },
            });
        });

        it("does not search the web without include_law, and says when no search is configured", async () => {
            access.listAccessibleProjectIds.mockResolvedValue([P1]);
            const fake = scriptedDb([
                { table: "projects", data: [project(P1, "DPA Acme")] },
                { table: "dossiers", data: [] },
            ]);
            docs.findDocumentText.mockResolvedValue(miss());
            const result = await askAcervo(fake.db, caller, { question: "LGPD", include_law: true });
            fake.done();
            expect(web.searchWeb).not.toHaveBeenCalled();
            expect(result).toMatchObject({ ok: true, data: { law_available: false, law_sources: [] } });
        });
    });
});

describe("quote verification is strict", () => {
    const TEXT =
        "11.1 A Contratada poderá ceder este contrato sem anuência da Contratante. " +
        "x".repeat(800) +
        " 12.1 A multa será de 20% sobre o saldo remanescente.";

    it("rejects a quote whose short fragment would be dropped", () => {
        expect(locateQuote(TEXT, "Não ... poderá ceder este contrato sem anuência")).toBeNull();
    });

    it("rejects a quote too short to prove anything", () => {
        expect(locateQuote(TEXT, "multa será")).toBeNull();
    });

    it("rejects fragments far apart in the contract", () => {
        expect(locateQuote(TEXT, "poderá ceder este contrato … a multa será de 20% sobre o saldo")).toBeNull();
    });

    it("still finds a verbatim or loosely spaced quote", () => {
        expect(locateQuote(TEXT, "A Contratada poderá ceder este contrato")).not.toBeNull();
        expect(locateQuote(TEXT, "a  contratada PODERÁ ceder … sem anuência da Contratante")).not.toBeNull();
    });
});
