import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const access = vi.hoisted(() => ({ getOrgRole: vi.fn(), isOrgAdmin: (r: string | null) => r === "owner" || r === "admin" }));
vi.mock("../../../lib/access", () => access);
const audit = vi.hoisted(() => ({ recordAudit: vi.fn() }));
vi.mock("../../../lib/audit", () => audit);
const contracts = vi.hoisted(() => ({ recordCardEvent: vi.fn() }));
vi.mock("../../contracts/contracts.service", () => contracts);

import { applyNotionImport, planImport, previewNotionImport } from "../notionSync.service";
import { encryptToken } from "../notion.connection";
import { DB_ID, fakeNotion } from "./notionFake";

const ORG = "o1";
const head = { userId: "u1", userEmail: "head@exemplo.com" };
const P_EXISTING = "11111111-1111-4111-8111-111111111111";
const P_FOREIGN = "22222222-2222-4222-8222-222222222222";
const fieldMap = { Contrato: "name", Etapa: "lane", Contraparte: "counterparty", ProjectId: "project_id", "Abrir no app": "app_link", Progresso: "status", Risco: "risk_level" } as const;
const stageMap = { Revisão: { lane: "revisao", tag: null }, Processos: { lane: "triagem", tag: "Processos" } } as const;

const page = (id: string, props: { name?: string; stage?: string | null; counterparty?: string; projectId?: string; link?: string; archived?: boolean }) => ({
    id,
    url: `https://notion.example/${id}`,
    archived: props.archived ?? false,
    properties: {
        Contrato: { type: "title", title: props.name ? [{ plain_text: props.name }] : [] },
        Etapa: { type: "select", select: props.stage ? { name: props.stage } : null },
        Contraparte: { type: "rich_text", rich_text: props.counterparty ? [{ plain_text: props.counterparty }] : [] },
        ProjectId: { type: "rich_text", rich_text: props.projectId ? [{ plain_text: props.projectId }] : [] },
        "Abrir no app": { type: "url", url: props.link ?? null },
        Progresso: { type: "select", select: { name: "Em andamento" } },
        Risco: { type: "select", select: { name: "Atenção" } },
    },
});

const PAGES = [
    page("pg-linked", { name: "Já ligado", stage: "Revisão" }),
    page("pg-project", { name: "Da era localhost", stage: "Revisão", projectId: P_EXISTING, link: "http://localhost:3000/projects/x" }),
    page("pg-dup", { name: "NDA  Fictício", stage: "Processos", counterparty: "Empresa Fictícia S.A." }),
    page("pg-new", { name: "Novo", stage: "Fase sem mapa" }),
    page("pg-foreign", { name: "Outro", stage: null, projectId: P_FOREIGN }),
    page("pg-untitled", { stage: "Revisão" }),
];
const CARDS = [
    { id: "c-linked", name: "Já ligado", counterparty: null, notion_page_id: "pg-linked" },
    { id: P_EXISTING, name: "Qualquer", counterparty: null, notion_page_id: null },
    { id: "c-dup", name: "nda fictício", counterparty: "empresa ficticia s a", notion_page_id: null },
];

const conn = (over: Record<string, unknown> = {}) => ({
    org_id: ORG,
    ...encryptToken("ntn_" + "a".repeat(40)),
    database_id: DB_ID,
    field_map: fieldMap,
    stage_map: stageMap,
    sync_enabled: false,
    ...over,
});

beforeEach(() => {
    process.env.USER_API_KEYS_ENCRYPTION_SECRET = "segredo-de-teste";
    delete process.env.APP_BASE_URL;
    access.getOrgRole.mockReset().mockResolvedValue("admin");
    audit.recordAudit.mockReset();
    contracts.recordCardEvent.mockReset();
});

describe("planImport", () => {
    it("links by page, then ProjectId, then counterparty + name, and flags what needs a look", () => {
        const plan = planImport(PAGES as never, CARDS, fieldMap, stageMap);
        expect(plan.counts).toEqual({ linked: 1, project: 1, duplicate: 1, new: 2, skipped: 1 });
        const by = Object.fromEntries(plan.items.map((i) => [i.page_id, i]));
        expect(by["pg-linked"]).toMatchObject({ match: "linked", project_id: "c-linked" });
        expect(by["pg-project"]).toMatchObject({ match: "project", project_id: P_EXISTING });
        expect(by["pg-project"].warnings).toEqual(["O link “Abrir no app” aponta para localhost; será trocado pelo endereço do Mike."]);
        expect(by["pg-dup"]).toMatchObject({ match: "duplicate", project_id: "c-dup", lane: "triagem", tag: "Processos" });
        expect(by["pg-new"]).toMatchObject({ match: "new", project_id: null, lane: null });
        expect(by["pg-new"].warnings).toEqual(["A etapa Fase sem mapa não está no mapeamento; entra em Entrada."]);
        expect(by["pg-foreign"].warnings).toEqual(["Sem etapa no Notion; entra em Entrada.", "O ProjectId da página não existe nesta organização; entra como card novo."]);
        expect(plan.skipped).toEqual([{ page_id: "pg-untitled", reason: "A página não tem nome de contrato." }]);
    });

    it("never lands two pages on one card", () => {
        const twins = [page("a", { name: "X", stage: "Revisão", projectId: P_EXISTING }), page("b", { name: "Qualquer", stage: "Revisão", projectId: P_EXISTING })];
        const plan = planImport(twins as never, CARDS, fieldMap, stageMap);
        expect(plan.items.map((i) => i.match)).toEqual(["project", "new"]);
        const dups = [page("a", { name: "nda fictício", counterparty: "Empresa Fictícia S.A." }), page("b", { name: "NDA Fictício", counterparty: "empresa ficticia sa" })];
        expect(planImport(dups as never, CARDS, fieldMap, stageMap).items.map((i) => i.match)).toEqual(["duplicate", "new"]);
        const noStageProp = planImport([page("c", { name: "Y" })] as never, [], { Contrato: "name" } as never, {});
        expect(noStageProp.items[0].warnings).toEqual(["Sem etapa no Notion; entra em Entrada."]);
    });
});

describe("previewNotionImport", () => {
    it("reads every page across Notion's cursor, skips archived ones and changes nothing", async () => {
        const notion = fakeNotion({
            [`POST /databases/${DB_ID}/query`]: [
                { body: { results: PAGES.slice(0, 3), has_more: true, next_cursor: "c2" } },
                { body: { results: [...PAGES.slice(3), page("pg-gone", { name: "Arquivado", archived: true })], has_more: false } },
            ],
        });
        const fake = scriptedDb([{ table: "notion_connections", data: conn() }, { table: "projects", data: CARDS }]);
        const result = await previewNotionImport(fake.db, head, ORG, notion.fetch);
        expect(result).toMatchObject({ ok: true, data: { total: 6, counts: { linked: 1, project: 1, duplicate: 1, new: 2, skipped: 1 } } });
        expect(notion.calls.map((c) => c.body)).toEqual([{ page_size: 100 }, { page_size: 100, start_cursor: "c2" }]);
        expect(notion.calls.every((c) => c.method === "POST")).toBe(true);
        expect(fake.calls[1].filters).toEqual([["eq", "org_id", ORG], ["not", "lane", "is", null]]);
        expect(fake.calls.every((c) => c.op === "select")).toBe(true);
        expect(result.ok && "fields" in result.data).toBe(false);
    });

    it("refuses members, strangers, an unready connection and an unreachable Notion", async () => {
        access.getOrgRole.mockResolvedValue("member");
        expect(await previewNotionImport(scriptedDb([]).db, head, ORG)).toMatchObject({ kind: "forbidden" });
        access.getOrgRole.mockResolvedValue(null);
        expect(await previewNotionImport(scriptedDb([]).db, head, ORG)).toMatchObject({ kind: "not_found" });
        access.getOrgRole.mockResolvedValue("admin");
        const notReady = "Conecte o Notion e salve o mapeamento antes de importar.";
        expect(await previewNotionImport(scriptedDb([{ table: "notion_connections", data: null }]).db, head, ORG)).toMatchObject({ detail: notReady });
        expect(await previewNotionImport(scriptedDb([{ table: "notion_connections", data: conn({ database_id: null }) }]).db, head, ORG)).toMatchObject({ detail: notReady });
        expect(await previewNotionImport(scriptedDb([{ table: "notion_connections", data: conn({ field_map: { Contrato: "name" } }) }]).db, head, ORG)).toMatchObject({
            detail: notReady,
        });
        expect(await previewNotionImport(scriptedDb([{ table: "notion_connections", data: conn({ field_map: null }) }]).db, head, ORG)).toMatchObject({ detail: notReady });
        const down = fakeNotion({ [`POST /databases/${DB_ID}/query`]: { status: 403 } });
        expect(await previewNotionImport(scriptedDb([{ table: "notion_connections", data: conn() }]).db, head, ORG, down.fetch)).toMatchObject({ kind: "unavailable" });
        const failing = scriptedDb([{ table: "notion_connections", data: conn() }, { table: "projects", error: { message: "x" } }]);
        expect(await previewNotionImport(failing.db, head, ORG, fakeNotion({ [`POST /databases/${DB_ID}/query`]: { body: { results: [] } } }).fetch)).toMatchObject({
            kind: "error",
        });
    });
});

describe("applyNotionImport", () => {
    const query = () => ({ [`POST /databases/${DB_ID}/query`]: { body: { results: PAGES, has_more: false } } });

    it("links existing cards, creates the new ones, records one event each and never writes to Notion with the sync off", async () => {
        const notion = fakeNotion(query());
        const fake = scriptedDb([
            { table: "notion_connections", data: conn() },
            { table: "projects", data: CARDS },
            // pg-project → existing card
            { table: "projects", op: "update" },
            // pg-dup → existing card
            { table: "projects", op: "update" },
            // pg-new → new card
            { rpc: "create_project_with_memory", data: [{ id: "c-new" }] },
            { table: "projects", op: "update" },
            // pg-foreign → new card
            { rpc: "create_project_with_memory", data: { id: "c-new2" } },
            { table: "projects", op: "update" },
        ]);
        const result = await applyNotionImport(fake.db, head, ORG, { writeBack: true }, notion.fetch);
        expect(result).toEqual({ ok: true, data: { created: 2, linked: 3, skipped: 1, failed: 0 } });
        // Existing card: the legal team's fields, not Mike's derived ones.
        expect(fake.calls[2].payload).toMatchObject({ lane: "revisao", status: "em_andamento", notion_page_id: "pg-project", visibility: "organization" });
        expect(fake.calls[2].payload).not.toHaveProperty("risk_level");
        expect(fake.calls[2].filters).toEqual([["eq", "id", P_EXISTING], ["eq", "org_id", ORG]]);
        expect(fake.calls[3].payload).toMatchObject({ lane: "triagem", notion_stage: "Processos", notion_page_id: "pg-dup" });
        expect(fake.calls[4].args).toMatchObject({ p_name: "Novo", p_org_id: ORG, p_user_id: "u1" });
        // New card: Mike has nothing yet, so the page's derived values come in.
        expect(fake.calls[5].payload).toMatchObject({ lane: "entrada", risk_level: "medio", notion_page_id: "pg-new", notion_url: "https://notion.example/pg-new" });
        expect(contracts.recordCardEvent.mock.calls.map((c) => [c[1].projectId, c[1].action, c[1].source])).toEqual([
            [P_EXISTING, "notion.linked", "notion"],
            ["c-dup", "notion.linked", "notion"],
            ["c-new", "notion.imported", "notion"],
            ["c-new2", "notion.imported", "notion"],
        ]);
        expect(notion.calls.filter((c) => c.method === "PATCH")).toEqual([]);
        expect(audit.recordAudit).toHaveBeenCalledWith(fake.db, expect.objectContaining({ action: "notion.imported", detail: expect.objectContaining({ write_back: false }) }));
    });

    it("writes Mike's link back only when asked and the sync is on, with the app's address", async () => {
        process.env.APP_BASE_URL = "https://mike.example/";
        const notion = fakeNotion({ ...query(), [`PATCH /pages/pg-new`]: { body: {} } });
        const onlyNew = { [`POST /databases/${DB_ID}/query`]: { body: { results: [PAGES[3]] } } };
        const n2 = fakeNotion({ ...onlyNew, "PATCH /pages/pg-new": { body: {} } });
        const fake = scriptedDb([
            { table: "notion_connections", data: conn({ sync_enabled: true }) },
            { table: "projects", data: [] },
            { rpc: "create_project_with_memory", data: [{ id: "c-new" }] },
            { table: "projects", op: "update" },
        ]);
        expect(await applyNotionImport(fake.db, head, ORG, { writeBack: true }, n2.fetch)).toMatchObject({ data: { created: 1 } });
        const patch = n2.calls.find((c) => c.method === "PATCH")!;
        expect(patch.url).toMatch(/\/pages\/pg-new$/);
        expect(patch.body).toEqual({
            properties: {
                "Abrir no app": { url: "https://mike.example/projects/c-new" },
                ProjectId: { rich_text: [{ text: { content: "c-new" } }] },
            },
        });
        void notion;

        // Sync on but not asked: still no write.
        const n3 = fakeNotion(onlyNew);
        const quiet = scriptedDb([
            { table: "notion_connections", data: conn({ sync_enabled: true }) },
            { table: "projects", data: [] },
            { rpc: "create_project_with_memory", data: [{ id: "c-new" }] },
            { table: "projects", op: "update" },
        ]);
        await applyNotionImport(quiet.db, head, ORG, {}, n3.fetch);
        expect(n3.calls.filter((c) => c.method === "PATCH")).toEqual([]);

        // Sync on, asked, but no link properties mapped: nothing to write.
        const n4 = fakeNotion(onlyNew);
        const noLinks = scriptedDb([
            { table: "notion_connections", data: conn({ sync_enabled: true, field_map: { Contrato: "name", Etapa: "lane" } }) },
            { table: "projects", data: [] },
            { rpc: "create_project_with_memory", data: [{ id: "c-new" }] },
            { table: "projects", op: "update" },
        ]);
        await applyNotionImport(noLinks.db, head, ORG, { writeBack: true }, n4.fetch);
        expect(n4.calls.filter((c) => c.method === "PATCH")).toEqual([]);
    });

    it("is idempotent: a second run finds every page linked and changes nothing", async () => {
        const linkedCards = PAGES.filter((p) => p.properties.Contrato.title.length).map((p, i) => ({ id: `c${i}`, name: "x", counterparty: null, notion_page_id: p.id }));
        const fake = scriptedDb([{ table: "notion_connections", data: conn() }, { table: "projects", data: linkedCards }]);
        expect(await applyNotionImport(fake.db, head, ORG, {}, fakeNotion(query()).fetch)).toEqual({
            ok: true,
            data: { created: 0, linked: 5, skipped: 1, failed: 0 },
        });
        expect(contracts.recordCardEvent).not.toHaveBeenCalled();
        fake.done();
    });

    it("counts a page it could not import and goes on with the rest", async () => {
        const two = { [`POST /databases/${DB_ID}/query`]: { body: { results: [PAGES[3], PAGES[4]] } } };
        const fake = scriptedDb([
            { table: "notion_connections", data: conn() },
            { table: "projects", data: [] },
            { rpc: "create_project_with_memory", error: { message: "x" } },
            { rpc: "create_project_with_memory", data: [] },
        ]);
        expect(await applyNotionImport(fake.db, head, ORG, {}, fakeNotion(two).fetch)).toMatchObject({ data: { created: 0, failed: 2 } });
        const updateFails = scriptedDb([
            { table: "notion_connections", data: conn() },
            { table: "projects", data: [] },
            { rpc: "create_project_with_memory", data: [{ id: "c-new" }] },
            { table: "projects", op: "update", error: { message: "x" } },
        ]);
        expect(
            await applyNotionImport(updateFails.db, head, ORG, {}, fakeNotion({ [`POST /databases/${DB_ID}/query`]: { body: { results: [PAGES[3]] } } }).fetch),
        ).toMatchObject({ data: { failed: 1 } });
    });

    it("refuses like the preview and maps failures", async () => {
        access.getOrgRole.mockResolvedValue("member");
        expect(await applyNotionImport(scriptedDb([]).db, head, ORG)).toMatchObject({ kind: "forbidden" });
        access.getOrgRole.mockResolvedValue("admin");
        expect(
            await applyNotionImport(scriptedDb([{ table: "notion_connections", data: conn() }]).db, head, ORG, {}, fakeNotion({ [`POST /databases/${DB_ID}/query`]: { status: 500 } }).fetch),
        ).toMatchObject({ kind: "unavailable" });
        expect(await applyNotionImport(scriptedDb([{ table: "notion_connections", error: { message: "x" } }]).db, head, ORG)).toMatchObject({ kind: "error" });
    });
});
