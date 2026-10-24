import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const access = vi.hoisted(() => ({ getOrgRole: vi.fn(), isOrgAdmin: (r: string | null) => r === "owner" || r === "admin" }));
vi.mock("../../../lib/access", () => access);
const audit = vi.hoisted(() => ({ recordAudit: vi.fn() }));
vi.mock("../../../lib/audit", () => audit);

import {
    clientForOrg,
    connectNotion,
    describeNotionBoard,
    disconnectNotion,
    getNotionConnection,
    listNotionDatabases,
    looksLikeNotionToken,
    saveNotionMapping,
} from "../notionSync.service";
import { decryptToken, encryptToken } from "../notion.connection";
import { DB_ID, fakeNotion } from "./notionFake";

const ORG = "o1";
const head = { userId: "u1", userEmail: "head@exemplo.com" };
const TOKEN = "ntn_" + "a".repeat(40) + "WXYZ";
const stored = () => ({ org_id: ORG, ...encryptToken(TOKEN), token_last4: "WXYZ", sync_enabled: false, poll_minutes: 10 });

beforeEach(() => {
    process.env.USER_API_KEYS_ENCRYPTION_SECRET = "segredo-de-teste";
    access.getOrgRole.mockReset().mockResolvedValue("admin");
    audit.recordAudit.mockReset();
});
afterEach(() => {
    delete process.env.USER_API_KEYS_ENCRYPTION_SECRET;
});

describe("token at rest", () => {
    it("round-trips, never stores the plain token and fails closed on tampering or a missing key", () => {
        const enc = encryptToken(TOKEN);
        expect(JSON.stringify(enc)).not.toContain(TOKEN);
        expect(decryptToken(enc)).toBe(TOKEN);
        expect(decryptToken({ ...enc, token_tag: Buffer.from("x".repeat(16)).toString("base64") })).toBeNull();
        expect(decryptToken({ token_encrypted: null })).toBeNull();
        process.env.USER_API_KEYS_ENCRYPTION_SECRET = "outro-segredo";
        expect(decryptToken(enc)).toBeNull();
        delete process.env.USER_API_KEYS_ENCRYPTION_SECRET;
        expect(() => encryptToken(TOKEN)).toThrow(/not configured/);
    });

    it("recognizes an internal integration token", () => {
        expect(looksLikeNotionToken(TOKEN)).toBe(true);
        expect(looksLikeNotionToken("secret_" + "b".repeat(43))).toBe(true);
        for (const bad of ["", "ntn_curto", "xoxb-123", 42, null]) expect(looksLikeNotionToken(bad)).toBe(false);
    });
});

describe("getNotionConnection", () => {
    it("shows any member whether it is connected, never the token", async () => {
        access.getOrgRole.mockResolvedValue("member");
        const result = await getNotionConnection(scriptedDb([{ table: "notion_connections", data: stored() }]).db, head, ORG);
        expect(result).toMatchObject({ ok: true, data: { connected: true, token_last4: "WXYZ", can_manage: false } });
        expect(JSON.stringify(result)).not.toContain(TOKEN);
        expect(JSON.stringify(result)).not.toContain("token_encrypted");
        expect(await getNotionConnection(scriptedDb([{ table: "notion_connections", data: null }]).db, head, ORG)).toMatchObject({
            data: { connected: false, field_map: {}, poll_minutes: 10 },
        });
        access.getOrgRole.mockResolvedValue(null);
        expect(await getNotionConnection(scriptedDb([]).db, head, ORG)).toMatchObject({ kind: "not_found" });
        access.getOrgRole.mockResolvedValue("admin");
        expect(await getNotionConnection(scriptedDb([{ table: "notion_connections", error: { message: "x" } }]).db, head, ORG)).toMatchObject({
            kind: "error",
        });
    });
});

describe("connectNotion", () => {
    it("checks the token with Notion, stores it encrypted and audits", async () => {
        const notion = fakeNotion();
        const fake = scriptedDb([{ table: "notion_connections", op: "upsert", data: stored() }]);
        const result = await connectNotion(fake.db, head, ORG, `  ${TOKEN} `, notion.fetch);
        expect(result).toMatchObject({ ok: true, data: { connected: true, token_last4: "WXYZ" } });
        expect(notion.calls[0]).toMatchObject({ method: "GET", url: "https://api.notion.com/v1/users/me" });
        expect(notion.calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
        const payload = fake.calls[0].payload as Record<string, string>;
        expect(JSON.stringify(payload)).not.toContain(TOKEN);
        expect(decryptToken(payload)).toBe(TOKEN);
        expect(payload).toMatchObject({ org_id: ORG, token_last4: "WXYZ", connected_by: "u1" });
        expect(audit.recordAudit).toHaveBeenCalledWith(fake.db, expect.objectContaining({ action: "notion.connected" }));
        expect(JSON.stringify(audit.recordAudit.mock.calls)).not.toContain(TOKEN);
    });

    it("says why Notion refused, in a sentence, without storing anything", async () => {
        for (const [status, text] of [
            [401, "O Notion recusou o token"],
            [403, "A integração não tem acesso"],
            [500, "O Notion não respondeu como esperado"],
        ] as const) {
            const notion = fakeNotion({ "GET /users/me": { status, body: { code: "x", message: TOKEN } } });
            const result = await connectNotion(scriptedDb([]).db, head, ORG, TOKEN, notion.fetch);
            expect(result).toMatchObject({ ok: false, kind: "validation", detail: expect.stringContaining(text) });
            expect(JSON.stringify(result)).not.toContain(TOKEN);
        }
        const offline = await connectNotion(scriptedDb([]).db, head, ORG, TOKEN, async () => {
            throw new Error(`ECONNREFUSED ${TOKEN}`);
        });
        expect(offline).toMatchObject({ detail: "Não consegui falar com o Notion. Confira a saída de rede do servidor." });
    });

    it("refuses a bad token, members and strangers, and maps a write failure", async () => {
        expect(await connectNotion(scriptedDb([]).db, head, ORG, "xoxb-1")).toMatchObject({ kind: "validation" });
        access.getOrgRole.mockResolvedValue("member");
        expect(await connectNotion(scriptedDb([]).db, head, ORG, TOKEN)).toMatchObject({ kind: "forbidden" });
        access.getOrgRole.mockResolvedValue(null);
        expect(await connectNotion(scriptedDb([]).db, head, ORG, TOKEN)).toMatchObject({ kind: "not_found" });
        access.getOrgRole.mockResolvedValue("owner");
        const failing = scriptedDb([{ table: "notion_connections", op: "upsert", error: { message: "x" } }]);
        expect(await connectNotion(failing.db, head, ORG, TOKEN, fakeNotion().fetch)).toMatchObject({ kind: "error" });
    });
});

describe("disconnectNotion", () => {
    it("wipes the token and stops the sync", async () => {
        const fake = scriptedDb([{ table: "notion_connections", op: "update", data: { org_id: ORG, sync_enabled: false } }]);
        expect(await disconnectNotion(fake.db, head, ORG)).toMatchObject({ ok: true, data: { connected: false } });
        expect(fake.calls[0].payload).toMatchObject({ token_encrypted: null, token_iv: null, token_tag: null, token_last4: null, sync_enabled: false });
        expect(await disconnectNotion(scriptedDb([{ table: "notion_connections", op: "update", data: null }]).db, head, ORG)).toMatchObject({ ok: true });
        expect(await disconnectNotion(scriptedDb([{ table: "notion_connections", op: "update", error: { message: "x" } }]).db, head, ORG)).toMatchObject({
            kind: "error",
        });
        access.getOrgRole.mockResolvedValue("member");
        expect(await disconnectNotion(scriptedDb([]).db, head, ORG)).toMatchObject({ kind: "forbidden" });
    });
});

describe("bases and schema", () => {
    it("lists the bases the integration sees", async () => {
        const result = await listNotionDatabases(scriptedDb([{ table: "notion_connections", data: stored() }]).db, head, ORG, fakeNotion().fetch);
        expect(result).toEqual({ ok: true, data: [{ id: DB_ID, data_source_id: DB_ID, title: "Esteira (fictícia)" }] });
        const untitled = fakeNotion({ "POST /search": { body: { results: [{ id: DB_ID }] } } });
        expect(await listNotionDatabases(scriptedDb([{ table: "notion_connections", data: stored() }]).db, head, ORG, untitled.fetch)).toMatchObject({
            data: [{ title: "Sem título" }],
        });
        const empty = fakeNotion({ "POST /search": { body: {} } });
        expect(await listNotionDatabases(scriptedDb([{ table: "notion_connections", data: stored() }]).db, head, ORG, empty.fetch)).toEqual({ ok: true, data: [] });
    });

    it("describes a base with a suggested mapping", async () => {
        const result = await describeNotionBoard(scriptedDb([{ table: "notion_connections", data: stored() }]).db, head, ORG, DB_ID, fakeNotion().fetch);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.title).toBe("Esteira (fictícia)");
        expect(result.data.suggested_field_map).toMatchObject({ Contrato: "name", Etapa: "lane", Responsável: "assignee" });
        expect(result.data.stage_options).toContain("Processos");
        expect(result.data.suggested_stage_map.Processos).toEqual({ lane: "triagem", tag: "Processos" });
        const untitled = fakeNotion({ [`GET /databases/${DB_ID}`]: { body: { properties: {} } } });
        expect(await describeNotionBoard(scriptedDb([{ table: "notion_connections", data: stored() }]).db, head, ORG, DB_ID, untitled.fetch)).toMatchObject({
            data: { title: "Sem título", properties: [], stage_options: [] },
        });
    });

    it("refuses when not connected, unreachable or for a bad id", async () => {
        const notConnected = "Conecte o Notion primeiro, com o token da integração.";
        expect(await listNotionDatabases(scriptedDb([{ table: "notion_connections", data: null }]).db, head, ORG)).toMatchObject({ detail: notConnected });
        expect(await describeNotionBoard(scriptedDb([{ table: "notion_connections", data: { org_id: ORG } }]).db, head, ORG, DB_ID)).toMatchObject({
            detail: notConnected,
        });
        expect(await describeNotionBoard(scriptedDb([]).db, head, ORG, "../x")).toMatchObject({ kind: "validation" });
        const down = fakeNotion({ "POST /search": { status: 503 }, [`GET /databases/${DB_ID}`]: { status: 404 } });
        expect(await listNotionDatabases(scriptedDb([{ table: "notion_connections", data: stored() }]).db, head, ORG, down.fetch)).toMatchObject({
            kind: "unavailable",
        });
        expect(await describeNotionBoard(scriptedDb([{ table: "notion_connections", data: stored() }]).db, head, ORG, DB_ID, down.fetch)).toMatchObject({
            kind: "unavailable",
            detail: expect.stringContaining("Conexões"),
        });
        access.getOrgRole.mockResolvedValue("member");
        expect(await listNotionDatabases(scriptedDb([]).db, head, ORG)).toMatchObject({ kind: "forbidden" });
        expect(await describeNotionBoard(scriptedDb([]).db, head, ORG, DB_ID)).toMatchObject({ kind: "forbidden" });
        access.getOrgRole.mockResolvedValue("admin");
        expect(await listNotionDatabases(scriptedDb([{ table: "notion_connections", error: { message: "x" } }]).db, head, ORG)).toMatchObject({ kind: "error" });
        expect(await describeNotionBoard(scriptedDb([{ table: "notion_connections", error: { message: "x" } }]).db, head, ORG, DB_ID)).toMatchObject({
            kind: "error",
        });
    });

    it("gives the sync jobs a client only when a token decrypts", async () => {
        expect(await clientForOrg(scriptedDb([{ table: "notion_connections", data: stored() }]).db, ORG)).not.toBeNull();
        expect(await clientForOrg(scriptedDb([{ table: "notion_connections", data: null }]).db, ORG)).toBeNull();
    });
});

describe("saveNotionMapping", () => {
    const input = {
        database_id: DB_ID,
        field_map: { Contrato: "name", Etapa: "lane", Responsável: "assignee" },
        stage_map: Object.fromEntries(
            ["Entrada", "Not started", "Triagem", "Revisão", "Negociação", "Assinatura", "Arquivado", "Done", "Processos", "Legal Estratégico", "Pendências menores (backlog)"].map(
                (o) => [o, { lane: "triagem", tag: o === "Processos" ? "Processos" : null }],
            ),
        ),
        poll_minutes: 15,
    };

    it("checks the map against the base as it is now, saves it and audits", async () => {
        const fake = scriptedDb([
            { table: "notion_connections", data: stored() },
            { table: "notion_connections", op: "update", data: { ...stored(), database_id: DB_ID, database_title: "Esteira (fictícia)" } },
        ]);
        const result = await saveNotionMapping(fake.db, head, ORG, input, fakeNotion().fetch);
        expect(result).toMatchObject({ ok: true, data: { database_title: "Esteira (fictícia)" } });
        expect(fake.calls[1].payload).toMatchObject({
            database_id: DB_ID,
            database_title: "Esteira (fictícia)",
            field_map: input.field_map,
            poll_minutes: 15,
        });
        expect((fake.calls[1].payload as { stage_map: Record<string, unknown> }).stage_map.Processos).toEqual({ lane: "triagem", tag: "Processos" });
        expect(audit.recordAudit).toHaveBeenCalledWith(fake.db, expect.objectContaining({ action: "notion.mapping_saved", detail: { fields: 3, stages: 11 } }));
        // Default polling when not given.
        const again = scriptedDb([{ table: "notion_connections", data: stored() }, { table: "notion_connections", op: "update", data: stored() }]);
        await saveNotionMapping(again.db, head, ORG, { ...input, poll_minutes: undefined }, fakeNotion().fetch);
        expect(again.calls[1].payload).toMatchObject({ poll_minutes: 10 });
    });

    it("refuses a bad base, polling, map or stage map, and when unreachable", async () => {
        const conn = () => scriptedDb([{ table: "notion_connections", data: stored() }]).db;
        expect(await saveNotionMapping(scriptedDb([]).db, head, ORG, { ...input, database_id: 3 })).toMatchObject({ detail: "Escolha uma base do Notion." });
        expect(await saveNotionMapping(scriptedDb([]).db, head, ORG, { ...input, poll_minutes: 1 })).toMatchObject({ kind: "validation" });
        expect(await saveNotionMapping(conn(), head, ORG, { ...input, field_map: { Contrato: "name" } }, fakeNotion().fetch)).toMatchObject({
            detail: "Escolha a propriedade com a etapa.",
        });
        expect(await saveNotionMapping(conn(), head, ORG, { ...input, stage_map: {} }, fakeNotion().fetch)).toMatchObject({
            detail: "Escolha a etapa do Mike para Entrada.",
        });
        expect(await saveNotionMapping(conn(), head, ORG, input, fakeNotion({ [`GET /databases/${DB_ID}`]: { status: 401 } }).fetch)).toMatchObject({
            kind: "unavailable",
        });
        expect(await saveNotionMapping(scriptedDb([{ table: "notion_connections", data: null }]).db, head, ORG, input)).toMatchObject({ kind: "conflict" });
        const failing = scriptedDb([{ table: "notion_connections", data: stored() }, { table: "notion_connections", op: "update", error: { message: "x" } }]);
        expect(await saveNotionMapping(failing.db, head, ORG, input, fakeNotion().fetch)).toMatchObject({ kind: "error" });
        access.getOrgRole.mockResolvedValue("member");
        expect(await saveNotionMapping(scriptedDb([]).db, head, ORG, input)).toMatchObject({ kind: "forbidden" });
    });
});
