import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const access = vi.hoisted(() => ({ getOrgRole: vi.fn(), isOrgAdmin: (r: string | null) => r === "owner" || r === "admin" }));
vi.mock("../../../lib/access", () => access);
const audit = vi.hoisted(() => ({ recordAudit: vi.fn() }));
vi.mock("../../../lib/audit", () => audit);
const contracts = vi.hoisted(() => ({ recordCardEvent: vi.fn() }));
vi.mock("../../contracts/contracts.service", () => contracts);
const queue = vi.hoisted(() => ({ enqueueDbJob: vi.fn() }));
vi.mock("../../../lib/dbq/enqueue", () => queue);

import {
    enqueueDueNotionSyncs,
    getNotionSyncStatus,
    handleNotionSync,
    pullOrg,
    pushOrg,
    setNotionSyncEnabled,
    syncNotionNow,
} from "../notionSync.service";
import { encryptToken } from "../notion.connection";
import { DB_ID, fakeNotion } from "./notionFake";

const ORG = "o1";
const head = { userId: "u1", userEmail: "head@exemplo.com" };
const fieldMap = {
    Contrato: "name",
    Etapa: "lane",
    Progresso: "status",
    Prioridade: "priority",
    Responsável: "assignee",
    Prazo: "deadline",
    Contraparte: "counterparty",
    Risco: "risk_level",
    Renovação: "renewal",
    "Abrir no app": "app_link",
    ProjectId: "project_id",
};
const stageMap = { Revisão: { lane: "revisao", tag: null }, Processos: { lane: "triagem", tag: "Processos" } };
const conn = (over: Record<string, unknown> = {}) => ({
    org_id: ORG,
    ...encryptToken("ntn_" + "a".repeat(40)),
    database_id: DB_ID,
    field_map: fieldMap,
    stage_map: stageMap,
    field_types: { Progresso: "status" },
    sync_enabled: true,
    pull_cursor: "2026-10-22T09:00:00.000Z",
    connected_by: "u1",
    ...over,
});
const card = (over: Record<string, unknown> = {}) => ({
    id: "c1",
    org_id: ORG,
    name: "Contrato Fictício",
    lane: "revisao",
    notion_stage: null,
    status: "em_andamento",
    priority: "media",
    assignee_email: "ana@exemplo.com",
    deadline: "2026-11-30",
    completed_at: null,
    requester_name: null,
    counterparty: "Empresa Fictícia",
    risk_level: "alto",
    contract_type: null,
    notion_page_id: "pg1",
    notion_seen_at: "2026-10-22T09:00:00.000Z",
    ...over,
});
const USERS = { "GET /users": { body: { results: [{ id: "n-ana", type: "person", person: { email: "Ana@Exemplo.com" } }, { id: "n-bot", type: "bot" }, { id: "n-bia", type: "person", person: { email: "bia@exemplo.com" } }] } } };
const notionPage = (over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) => ({
    id: "pg1",
    url: "https://notion.example/pg1",
    last_edited_time: "2026-10-22T10:00:00.000Z",
    properties: {
        Contrato: { type: "title", title: [{ plain_text: "Contrato Fictício" }] },
        Etapa: { type: "select", select: { name: "Processos" } },
        Progresso: { type: "status", status: { name: "Bloqueado" } },
        Prioridade: { type: "select", select: { name: "Alta" } },
        Responsável: { type: "people", people: [{ id: "n-bia" }] },
        Prazo: { type: "date", date: { start: "2026-12-15" } },
        Contraparte: { type: "rich_text", rich_text: [{ plain_text: "Outro nome no Notion" }] },
        Risco: { type: "select", select: { name: "OK" } },
        ...props,
    },
    ...over,
});

beforeEach(() => {
    process.env.USER_API_KEYS_ENCRYPTION_SECRET = "segredo-de-teste";
    process.env.APP_BASE_URL = "https://mike.example";
    access.getOrgRole.mockReset().mockResolvedValue("admin");
    audit.recordAudit.mockReset();
    contracts.recordCardEvent.mockReset();
    queue.enqueueDbJob.mockReset();
});

describe("pushOrg", () => {
    it("writes every field of a queued card, Mike's derived ones included, with this deployment's link", async () => {
        const notion = fakeNotion({ ...USERS, "PATCH /pages/pg1": { body: { last_edited_time: "2026-10-22T11:00:00.000Z" } } });
        const fake = scriptedDb([
            { table: "notion_sync_outbox", data: [{ project_id: "c1", attempts: 0 }] },
            { table: "notion_connections", data: conn() },
            { table: "projects", data: [card({ lane: "triagem", notion_stage: "Processos" })] },
            { table: "contract_terms", data: [{ project_id: "c1", notice_deadline: "2027-01-01" }] },
            { table: "projects", op: "update" },
            { table: "notion_sync_outbox", op: "update" },
        ]);
        expect(await pushOrg(fake.db, ORG, notion.fetch)).toEqual({ sent: 1, failed: 0 });
        const patch = notion.calls.find((c) => c.method === "PATCH")!.body as { properties: Record<string, unknown> };
        expect(patch.properties).toMatchObject({
            Etapa: { select: { name: "Processos" } },
            // The board's Progresso is a status property, written as one.
            Progresso: { status: { name: "Em andamento" } },
            Responsável: { people: [{ id: "n-ana" }] },
            Contraparte: { rich_text: [{ text: { content: "Empresa Fictícia" } }] },
            Risco: { select: { name: "Risco crítico" } },
            Renovação: { date: { start: "2027-01-01" } },
            "Abrir no app": { url: "https://mike.example/projects/c1" },
        });
        expect(patch.properties).not.toHaveProperty("ProjectId");
        expect(fake.calls[4].payload).toEqual({ notion_seen_at: "2026-10-22T11:00:00.000Z" });
        expect(fake.calls[5].payload).toMatchObject({ status: "sent", attempts: 1, last_error: null });
        fake.done();
    });

    it("retries a failed write and gives up after five tries, with a sentence, not Notion's text", async () => {
        const notion = fakeNotion({ "PATCH /pages/pg1": { status: 409, body: { code: "conflict_error", message: "raw" } } });
        const noAssignee = { ...fieldMap } as Record<string, string>;
        delete noAssignee["Responsável"];
        const fake = scriptedDb([
            { table: "notion_sync_outbox", data: [{ project_id: "c1", attempts: 4 }] },
            { table: "notion_connections", data: conn({ field_map: noAssignee }) },
            { table: "projects", data: [card()] },
            { table: "contract_terms", data: null },
            { table: "notion_sync_outbox", op: "update" },
        ]);
        expect(await pushOrg(fake.db, ORG, notion.fetch)).toEqual({ sent: 0, failed: 1 });
        expect(fake.calls[4].payload).toEqual({ status: "failed", attempts: 5, last_error: "O Notion não respondeu como esperado. Tente de novo mais tarde." });
        const again = scriptedDb([
            { table: "notion_sync_outbox", data: [{ project_id: "c1", attempts: 0 }] },
            { table: "notion_connections", data: conn({ field_map: noAssignee }) },
            { table: "projects", data: [card()] },
            { table: "contract_terms", data: [] },
            { table: "notion_sync_outbox", op: "update" },
        ]);
        await pushOrg(again.db, ORG, notion.fetch);
        expect(again.calls[4].payload).toMatchObject({ status: "pending", attempts: 1 });
    });

    it("drops cards that lost their page, the whole queue when the sync is off, and does nothing when empty", async () => {
        const gone = scriptedDb([
            { table: "notion_sync_outbox", data: [{ project_id: "c1", attempts: 0 }] },
            { table: "notion_connections", data: conn({ field_map: { Contrato: "name", Etapa: "lane" } }) },
            { table: "projects", data: [card({ notion_page_id: null })] },
            { table: "contract_terms", data: [] },
            { table: "notion_sync_outbox", op: "delete" },
        ]);
        expect(await pushOrg(gone.db, ORG, fakeNotion().fetch)).toEqual({ sent: 0, failed: 0 });
        const off = scriptedDb([
            { table: "notion_sync_outbox", data: [{ project_id: "c1", attempts: 0 }] },
            { table: "notion_connections", data: conn({ sync_enabled: false }) },
            { table: "notion_sync_outbox", op: "delete" },
        ]);
        expect(await pushOrg(off.db, ORG)).toEqual({ sent: 0, failed: 0 });
        expect(off.calls[2].filters).toEqual([["eq", "org_id", ORG], ["eq", "status", "pending"]]);
        expect(await pushOrg(scriptedDb([{ table: "notion_sync_outbox", data: [] }]).db, ORG)).toEqual({ sent: 0, failed: 0 });
        await expect(pushOrg(scriptedDb([{ table: "notion_sync_outbox", error: { message: "x" } }]).db, ORG)).rejects.toMatchObject({ message: "x" });
        await expect(
            pushOrg(scriptedDb([{ table: "notion_sync_outbox", data: [{ project_id: "c1", attempts: 0 }] }, { table: "notion_connections", data: conn({ sync_enabled: false }) }, { table: "notion_sync_outbox", op: "delete", error: { message: "y" } }]).db, ORG),
        ).rejects.toMatchObject({ message: "y" });
        await expect(
            pushOrg(scriptedDb([{ table: "notion_sync_outbox", data: [{ project_id: "c1", attempts: 0 }] }, { table: "notion_connections", data: conn() }, { table: "projects", error: { message: "z" } }]).db, ORG),
        ).rejects.toMatchObject({ message: "z" });
        await expect(
            pushOrg(
                scriptedDb([
                    { table: "notion_sync_outbox", data: [{ project_id: "c1", attempts: 0 }] },
                    { table: "notion_connections", data: conn() },
                    { table: "projects", data: [] },
                    { table: "contract_terms", error: { message: "w" } },
                ]).db,
                ORG,
            ),
        ).rejects.toMatchObject({ message: "w" });
    });

    it("pages through Notion's users and skips bots and people without e-mail", async () => {
        const notion = fakeNotion({
            "GET /users": [
                { body: { results: [{ id: "n-ana", type: "person", person: { email: "ana@exemplo.com" } }], has_more: true, next_cursor: "u2" } },
                { body: { results: [{ id: "n-x", type: "person", person: {} }] } },
            ],
            "PATCH /pages/pg1": { body: {} },
        });
        const fake = scriptedDb([
            { table: "notion_sync_outbox", data: [{ project_id: "c1", attempts: 0 }] },
            { table: "notion_connections", data: conn() },
            { table: "projects", data: [card({ assignee_email: "ninguem@exemplo.com" })] },
            { table: "contract_terms", data: [] },
            { table: "projects", op: "update" },
            { table: "notion_sync_outbox", op: "update" },
        ]);
        await pushOrg(fake.db, ORG, notion.fetch);
        expect(notion.calls.filter((c) => c.method === "GET").map((c) => c.url)).toEqual([
            "https://api.notion.com/v1/users?page_size=100",
            "https://api.notion.com/v1/users?page_size=100&start_cursor=u2",
        ]);
        expect((notion.calls.find((c) => c.method === "PATCH")!.body as { properties: Record<string, unknown> }).properties.Responsável).toEqual({ people: [] });
        expect(fake.calls[4].payload).toEqual({ notion_seen_at: null });
    });
});

describe("pullOrg", () => {
    const query = (pages: unknown[], more: Record<string, unknown> = {}) => ({ [`POST /databases/${DB_ID}/query`]: { body: { results: pages, ...more } } });

    it("applies the legal team's edits, never Mike's derived fields, and logs each change", async () => {
        const notion = fakeNotion({ ...USERS, ...query([notionPage()]) });
        const fake = scriptedDb([
            { table: "notion_connections", data: conn() },
            { table: "projects", data: [card()] },
            { table: "card_events", data: [{ project_id: "c1", at: "2026-10-22T08:00:00.000Z" }] },
            { table: "projects", op: "update" },
            { table: "notion_connections", op: "update" },
        ]);
        const result = await pullOrg(fake.db, ORG, notion.fetch, new Date("2026-10-22T12:00:00Z"));
        expect(result).toEqual({ read: 1, updated: 1, created: 0, unchanged: 0 });
        const query0 = notion.calls[0].body as Record<string, unknown>;
        expect(query0.filter).toEqual({ timestamp: "last_edited_time", last_edited_time: { on_or_after: "2026-10-22T09:00:00.000Z" } });
        expect(fake.calls[2].filters).toEqual([["in", "project_id", ["c1"]], ["neq", "source", "notion"], ["order", "at", { ascending: false }]]);
        expect(fake.calls[3].payload).toEqual({
            lane: "triagem",
            notion_stage: "Processos",
            lane_updated_at: "2026-10-22T12:00:00.000Z",
            status: "bloqueado",
            priority: "alta",
            assignee_email: "bia@exemplo.com",
            deadline: "2026-12-15",
            notion_seen_at: "2026-10-22T10:00:00.000Z",
        });
        expect(fake.calls[3].payload).not.toHaveProperty("counterparty");
        expect(fake.calls[3].payload).not.toHaveProperty("risk_level");
        expect(contracts.recordCardEvent.mock.calls.map((c) => [c[1].action, c[1].field, c[1].after, c[1].source])).toEqual([
            ["lane.changed", "Etapa", "Processos", "notion"],
            ["field.updated", "Progresso", "bloqueado", "notion"],
            ["field.updated", "Prioridade", "alta", "notion"],
            ["field.updated", "Responsável", "bia@exemplo.com", "notion"],
            ["field.updated", "Prazo", "2026-12-15", "notion"],
        ]);
        expect(fake.calls[4].payload).toEqual({ pull_cursor: "2026-10-22T10:00:00.000Z" });
    });

    it("skips its own push, keeps Mike's value when Mike changed later, and counts a no-op edit", async () => {
        const own = notionPage({ last_edited_time: "2026-10-22T09:00:00.000Z" });
        const later = notionPage({ id: "pg2", last_edited_time: "2026-10-22T10:00:00.000Z" });
        const same = notionPage({ id: "pg3", last_edited_time: "2026-10-22T10:30:00.000Z" }, {
            Etapa: { type: "select", select: { name: "Revisão" } },
            Progresso: { type: "status", status: { name: "Em andamento" } },
            Prioridade: { type: "select", select: { name: "Média" } },
            Responsável: { type: "people", people: [] },
            Prazo: { type: "date", date: { start: "2026-11-30" } },
            Contrato: { type: "title", title: [] },
        });
        const notion = fakeNotion({ ...USERS, ...query([own, later, same]) });
        const fake = scriptedDb([
            { table: "notion_connections", data: conn() },
            {
                table: "projects",
                data: [card(), card({ id: "c2", notion_page_id: "pg2", notion_seen_at: null }), card({ id: "c3", notion_page_id: "pg3", assignee_email: null, notion_seen_at: null })],
            },
            { table: "card_events", data: [{ project_id: "c2", at: "2026-10-22T10:05:00.000Z" }, { project_id: "c2", at: "2026-10-22T07:00:00.000Z" }] },
            { table: "projects", op: "update" },
            { table: "projects", op: "update" },
            { table: "notion_connections", op: "update" },
        ]);
        expect(await pullOrg(fake.db, ORG, notion.fetch)).toEqual({ read: 3, updated: 0, created: 0, unchanged: 3 });
        expect(fake.calls[3].payload).toEqual({ notion_seen_at: "2026-10-22T10:00:00.000Z" });
        expect(fake.calls[4].payload).toEqual({ notion_seen_at: "2026-10-22T10:30:00.000Z" });
        expect(contracts.recordCardEvent).not.toHaveBeenCalled();
    });

    it("brings a page made in Notion in as a new card", async () => {
        const fresh = notionPage({ id: "pg-new" });
        const fake = scriptedDb([
            { table: "notion_connections", data: conn({ pull_cursor: null }) },
            { table: "projects", data: [] },
            { rpc: "create_project_with_memory", data: [{ id: "c-new" }] },
            { table: "projects", op: "update" },
            { table: "notion_connections", op: "update" },
        ]);
        const notion = fakeNotion({ ...USERS, ...query([fresh, notionPage({ id: "pg-nameless" }, { Contrato: { type: "title", title: [] } })]) });
        expect(await pullOrg(fake.db, ORG, notion.fetch)).toMatchObject({ created: 1 });
        expect((notion.calls[0].body as Record<string, unknown>).filter).toBeUndefined();
        expect(fake.calls[2].args).toMatchObject({ p_user_id: "u1", p_org_id: ORG, p_name: "Contrato Fictício" });
        expect(fake.calls[3].payload).toMatchObject({
            lane: "triagem",
            notion_stage: "Processos",
            counterparty: "Outro nome no Notion",
            risk_level: "baixo",
            assignee_email: "bia@exemplo.com",
            notion_page_id: "pg-new",
            notion_seen_at: "2026-10-22T10:00:00.000Z",
        });
        expect(contracts.recordCardEvent).toHaveBeenCalledWith(fake.db, expect.objectContaining({ projectId: "c-new", action: "notion.imported", source: "notion" }));
    });

    it("follows the cursor, skips archived pages, and does nothing with the sync off or nothing new", async () => {
        const notion = fakeNotion({
            [`POST /databases/${DB_ID}/query`]: [
                { body: { results: [notionPage({ archived: true })], has_more: true, next_cursor: "n2" } },
                { body: { results: [] } },
            ],
        });
        const fake = scriptedDb([{ table: "notion_connections", data: conn({ field_map: { Contrato: "name", Etapa: "lane" } }) }]);
        expect(await pullOrg(fake.db, ORG, notion.fetch)).toEqual({ read: 0, updated: 0, created: 0, unchanged: 0 });
        expect((notion.calls[1].body as Record<string, unknown>).start_cursor).toBe("n2");
        expect(await pullOrg(scriptedDb([{ table: "notion_connections", data: conn({ sync_enabled: false }) }]).db, ORG)).toEqual({ read: 0, updated: 0, created: 0, unchanged: 0 });
        expect(await pullOrg(scriptedDb([{ table: "notion_connections", data: conn({ database_id: null }) }]).db, ORG)).toMatchObject({ read: 0 });
    });

    it("keeps a card's stage when the page has none, and fails loudly on a write error", async () => {
        const blank = notionPage({}, { Etapa: { type: "select", select: null }, Responsável: { type: "people", people: [] } });
        const fake = scriptedDb([
            { table: "notion_connections", data: conn() },
            { table: "projects", data: [card({ notion_seen_at: null, assignee_email: null })] },
            { table: "card_events", data: [] },
            { table: "projects", op: "update" },
            { table: "notion_connections", op: "update" },
        ]);
        await pullOrg(fake.db, ORG, fakeNotion({ ...USERS, ...query([blank]) }).fetch);
        expect(fake.calls[3].payload).not.toHaveProperty("lane");
        const failing = scriptedDb([
            { table: "notion_connections", data: conn() },
            { table: "projects", data: [card({ notion_seen_at: null })] },
            { table: "card_events", data: [] },
            { table: "projects", op: "update", error: { message: "x" } },
        ]);
        await expect(pullOrg(failing.db, ORG, fakeNotion({ ...USERS, ...query([notionPage()]) }).fetch)).rejects.toMatchObject({ message: "x" });
        await expect(
            pullOrg(scriptedDb([{ table: "notion_connections", data: conn() }, { table: "projects", error: { message: "y" } }]).db, ORG, fakeNotion(query([notionPage()])).fetch),
        ).rejects.toMatchObject({ message: "y" });
        await expect(
            pullOrg(
                scriptedDb([{ table: "notion_connections", data: conn() }, { table: "projects", data: [card()] }, { table: "card_events", error: { message: "z" } }]).db,
                ORG,
                fakeNotion(query([notionPage()])).fetch,
            ),
        ).rejects.toMatchObject({ message: "z" });
        await expect(
            pullOrg(
                scriptedDb([{ table: "notion_connections", data: conn({ pull_cursor: null }) }, { table: "projects", data: [] }, { rpc: "create_project_with_memory", error: { message: "w" } }]).db,
                ORG,
                fakeNotion({ ...USERS, ...query([notionPage({ id: "pg-new" })]) }).fetch,
            ),
        ).rejects.toMatchObject({ message: "w" });
        await expect(
            pullOrg(
                scriptedDb([
                    { table: "notion_connections", data: conn({ pull_cursor: null }) },
                    { table: "projects", data: [] },
                    { rpc: "create_project_with_memory", data: [{ id: "c" }] },
                    { table: "projects", op: "update", error: { message: "v" } },
                ]).db,
                ORG,
                fakeNotion({ ...USERS, ...query([notionPage({ id: "pg-new" })]) }).fetch,
            ),
        ).rejects.toMatchObject({ message: "v" });
    });
});

describe("the job, the sweep and the controls", () => {
    it("runs pull then push and records the outcome, or the failure in words", async () => {
        const fake = scriptedDb([
            { table: "notion_connections", data: conn({ sync_enabled: false }) },
            { table: "notion_sync_outbox", data: [] },
            { table: "notion_connections", op: "update" },
        ]);
        expect(await handleNotionSync(fake.db, { org_id: ORG })).toEqual({ read: 0, updated: 0, created: 0, unchanged: 0, sent: 0, failed: 0 });
        expect(fake.calls[2].payload).toMatchObject({ last_sync_error: null });
        expect(await handleNotionSync(scriptedDb([]).db, {})).toEqual({ skipped: "no_org" });
        const down = scriptedDb([{ table: "notion_connections", data: conn() }, { table: "notion_connections", op: "update" }]);
        await expect(handleNotionSync(down.db, { org_id: ORG }, fakeNotion({ [`POST /databases/${DB_ID}/query`]: { status: 401 } }).fetch)).rejects.toBeTruthy();
        expect(down.calls[1].payload).toMatchObject({ last_sync_error: "O Notion recusou o token. Confira se ele está certo e ativo." });
    });

    it("queues organizations whose interval passed or that have cards waiting", async () => {
        const now = new Date("2026-10-22T12:00:00Z");
        const fake = scriptedDb([
            {
                table: "notion_connections",
                data: [
                    { org_id: "due", poll_minutes: 10, last_sync_at: "2026-10-22T11:45:00Z" },
                    { org_id: "never", poll_minutes: 10, last_sync_at: null },
                    { org_id: "recent", poll_minutes: 10, last_sync_at: "2026-10-22T11:58:00Z" },
                    { org_id: "waiting", poll_minutes: 60, last_sync_at: "2026-10-22T11:59:00Z" },
                ],
            },
            { table: "notion_sync_outbox", data: [{ org_id: "waiting" }] },
        ]);
        expect(await enqueueDueNotionSyncs(fake.db, now)).toBe(3);
        expect(queue.enqueueDbJob.mock.calls.map((c) => c[1].dedupeKey)).toEqual(["notion.sync:due", "notion.sync:never", "notion.sync:waiting"]);
        expect(await enqueueDueNotionSyncs(scriptedDb([{ table: "notion_connections", data: [] }]).db)).toBe(0);
        await expect(enqueueDueNotionSyncs(scriptedDb([{ table: "notion_connections", error: { message: "x" } }]).db)).rejects.toBeTruthy();
        await expect(
            enqueueDueNotionSyncs(scriptedDb([{ table: "notion_connections", data: [{ org_id: "a", poll_minutes: 5, last_sync_at: null }] }, { table: "notion_sync_outbox", error: { message: "y" } }]).db),
        ).rejects.toBeTruthy();
    });

    it("reports the sync state to any member", async () => {
        access.getOrgRole.mockResolvedValue("member");
        const fake = scriptedDb([
            { table: "notion_connections", data: { sync_enabled: true, last_sync_at: "t", last_sync_error: null } },
            { table: "notion_sync_outbox", data: [{ status: "pending" }, { status: "pending" }, { status: "failed" }] },
            { table: "projects", data: [{ id: "a" }, { id: "b" }] },
        ]);
        expect(await getNotionSyncStatus(fake.db, head, ORG)).toEqual({
            ok: true,
            data: { sync_enabled: true, last_sync_at: "t", last_sync_error: null, pending: 2, failed: 1, linked_cards: 2 },
        });
        expect(
            await getNotionSyncStatus(scriptedDb([{ table: "notion_connections", data: null }, { table: "notion_sync_outbox", data: null }, { table: "projects", data: null }]).db, head, ORG),
        ).toMatchObject({ data: { sync_enabled: false, pending: 0, linked_cards: 0 } });
        for (const failing of [
            [{ table: "notion_connections", error: { message: "x" } }],
            [{ table: "notion_connections", data: null }, { table: "notion_sync_outbox", error: { message: "x" } }],
            [{ table: "notion_connections", data: null }, { table: "notion_sync_outbox", data: [] }, { table: "projects", error: { message: "x" } }],
        ])
            expect(await getNotionSyncStatus(scriptedDb(failing).db, head, ORG)).toMatchObject({ kind: "error" });
        access.getOrgRole.mockResolvedValue(null);
        expect(await getNotionSyncStatus(scriptedDb([]).db, head, ORG)).toMatchObject({ kind: "not_found" });
    });

    it("lets only an admin turn the sync on, once mapped, and audits it", async () => {
        const fake = scriptedDb([
            { table: "notion_connections", data: { database_id: DB_ID, field_map: fieldMap, token_encrypted: "x" } },
            { table: "notion_connections", op: "update" },
        ]);
        expect(await setNotionSyncEnabled(fake.db, head, ORG, true)).toEqual({ ok: true, data: { sync_enabled: true } });
        expect(fake.calls[1].payload).toMatchObject({ sync_enabled: true });
        expect(audit.recordAudit).toHaveBeenCalledWith(fake.db, expect.objectContaining({ action: "notion.sync_on" }));
        const off = scriptedDb([{ table: "notion_connections", data: null }, { table: "notion_connections", op: "update" }]);
        expect(await setNotionSyncEnabled(off.db, head, ORG, false)).toEqual({ ok: true, data: { sync_enabled: false } });
        expect(audit.recordAudit).toHaveBeenLastCalledWith(off.db, expect.objectContaining({ action: "notion.sync_off" }));
        expect(await setNotionSyncEnabled(scriptedDb([{ table: "notion_connections", data: { database_id: null, field_map: null, token_encrypted: "x" } }]).db, head, ORG, true)).toMatchObject({
            kind: "conflict",
        });
        expect(await setNotionSyncEnabled(scriptedDb([]).db, head, ORG, "sim")).toMatchObject({ kind: "validation" });
        expect(await setNotionSyncEnabled(scriptedDb([{ table: "notion_connections", error: { message: "x" } }]).db, head, ORG, true)).toMatchObject({ kind: "error" });
        access.getOrgRole.mockResolvedValue("member");
        expect(await setNotionSyncEnabled(scriptedDb([]).db, head, ORG, true)).toMatchObject({ kind: "forbidden" });
        access.getOrgRole.mockResolvedValue(null);
        expect(await setNotionSyncEnabled(scriptedDb([]).db, head, ORG, true)).toMatchObject({ kind: "not_found" });
    });

    it("queues a sync now, only when on, deduped with the sweep", async () => {
        expect(await syncNotionNow(scriptedDb([{ table: "notion_connections", data: { sync_enabled: true } }]).db, head, ORG)).toEqual({ ok: true, data: { queued: true } });
        expect(queue.enqueueDbJob).toHaveBeenCalledWith(expect.anything(), { kind: "notion.sync", payload: { org_id: ORG }, dedupeKey: "notion.sync:o1" });
        expect(await syncNotionNow(scriptedDb([{ table: "notion_connections", data: null }]).db, head, ORG)).toMatchObject({ detail: "Ligue a sincronia antes." });
        expect(await syncNotionNow(scriptedDb([{ table: "notion_connections", error: { message: "x" } }]).db, head, ORG)).toMatchObject({ kind: "error" });
        access.getOrgRole.mockResolvedValue("member");
        expect(await syncNotionNow(scriptedDb([]).db, head, ORG)).toMatchObject({ kind: "forbidden" });
        access.getOrgRole.mockResolvedValue(null);
        expect(await syncNotionNow(scriptedDb([]).db, head, ORG)).toMatchObject({ kind: "not_found" });
    });
});
