// End to end over HTTP with the official MCP client: a real Express app with
// /mcp, an access token in a fake database, the legal role mocked. Fictional
// people and data only.

import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fakeDb";

const state = vi.hoisted(() => ({ db: null as unknown, role: "team" as "head" | "team" | "requester" }));
vi.mock("../../../lib/supabase", () => ({ createServerSupabase: () => state.db }));
vi.mock("../../requests/requests.service", () => ({
    whoAmI: vi.fn(async () => ({ ok: true, data: { configured: true, role: state.role, area: null, areas: [] } })),
}));
const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("../../../lib/audit", () => audit);

import { failure, ok } from "../../../lib/serviceResult";
import { allowed, argsHash, buildServer, errorCode, runTool } from "../mcp.server";
import { createAccessToken } from "../mcp.tokens";
import { defineTool, type McpContext } from "../mcp.types";
import { mcpRouter } from "../mcp.routes";

const NOW = new Date("2026-10-21T12:00:00Z");
const ana = { userId: "00000000-0000-4000-b000-000000000001", userEmail: "ana@exemplo.test" };
let base: URL;
let http: Server;
let tables: Record<string, Record<string, unknown>[]>;

async function token(over: Record<string, unknown> = {}) {
    const r = await createAccessToken(state.db as never, ana, { name: "teste", ...over });
    if (!r.ok) throw new Error("setup");
    return r.data.token;
}

async function connect(bearer: string, name = "claude-code") {
    const client = new Client({ name, version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(base, { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } });
    await client.connect(transport);
    return client;
}

beforeAll(async () => {
    const app = express();
    app.use("/mcp", express.json({ limit: "1mb" }), mcpRouter);
    await new Promise<void>((resolve) => {
        http = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
});
afterAll(() => new Promise<void>((resolve) => http.close(() => resolve())));

beforeEach(() => {
    const fake = fakeDb({}, { [ana.userId]: { email: "ana@exemplo.test", email_confirmed_at: "2026-01-01T00:00:00Z" } });
    fake.tables.user_profiles = [{ user_id: ana.userId, display_name: "Ana Teste" }];
    state.db = fake.db;
    tables = fake.tables;
    state.role = "team";
    audit.recordAudit.mockClear();
});

describe("/mcp over HTTP", () => {
    it("answers mike_quem_sou for the token's person and records the client", async () => {
        const client = await connect(await token());
        const { tools } = await client.listTools();
        // The team, default scopes: every read but the head-only Painel.
        expect(tools.map((t) => t.name)).toEqual([
            "mike_quem_sou",
            "mike_contratos_buscar",
            "mike_contratos_ficha",
            "mike_contratos_documento",
            "mike_contratos_atividade",
            "mike_prazos_proximos",
            "mike_base_perguntar",
            "mike_radar_mudancas",
            "mike_radar_contratos_afetados",
        ]);
        for (const t of tools) expect(t.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });

        const r = await client.callTool({ name: "mike_quem_sou", arguments: {} });
        expect(r.isError).toBeFalsy();
        expect(r.structuredContent).toMatchObject({ nome: "Ana Teste", email: "ana@exemplo.test", papel: "team", workspace: "personal", cliente: "claude-code" });
        expect((r.content as { text: string }[])[0].text).toBe("Agindo em nome de Ana Teste (time do Legal). 9 ferramentas disponíveis.");
        expect(tables.mcp_access_tokens[0].last_client).toBe("claude-code");

        expect(audit.recordAudit).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                userId: ana.userId,
                action: "mcp.tool",
                surface: "mcp",
                title: "mike_quem_sou",
                status: "completed",
                detail: expect.objectContaining({ client: "claude-code", tool: "mike_quem_sou", ok: true }),
            }),
        );
        await client.close();
    });

    it("shows a requester only mike_quem_sou, the Painel only to the head, and only the token's scopes", async () => {
        state.role = "requester";
        const requester = await connect(await token());
        expect((await requester.listTools()).tools.map((t) => t.name)).toEqual(["mike_quem_sou"]);
        await requester.close();

        state.role = "head";
        const head = await connect(await token());
        expect((await head.listTools()).tools.map((t) => t.name)).toContain("mike_painel_metricas");
        await head.close();

        const narrow = await connect(await token({ scopes: ["prazos:read"] }));
        expect((await narrow.listTools()).tools.map((t) => t.name)).toEqual(["mike_quem_sou", "mike_prazos_proximos"]);
        const refused = await narrow.callTool({ name: "mike_contratos_buscar", arguments: {} });
        expect(refused.isError).toBe(true);
        await narrow.close();
    });

    it("refuses a missing, unknown or revoked token with 401 and a Portuguese message", async () => {
        const none = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
        expect(none.status).toBe(401);
        expect(none.headers.get("www-authenticate")).toBe('Bearer realm="mike"');
        expect((await none.json()).error.message).toMatch(/Authorization: Bearer/);

        await expect(connect("mike_pat_nao-existe")).rejects.toThrow();

        const t = await token();
        tables.mcp_access_tokens[0].revoked_at = NOW.toISOString();
        await expect(connect(t)).rejects.toThrow();
    });

    it("refuses X-Mike-Acting-User on a personal token: it never acts as someone else", async () => {
        const t = await token();
        const r = await fetch(base, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
                Authorization: `Bearer ${t}`,
                "X-Mike-Acting-User": "slack:T1:U2",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        expect(r.status).toBe(400);
        expect((await r.json()).error.message).toMatch(/token de serviço/);
        expect(audit.recordAudit).not.toHaveBeenCalled();
    });

    it("refuses service tokens until the confirmed identity link exists", async () => {
        await expect(connect("mike_svc_qualquer-coisa")).rejects.toThrow();
    });

    it("never accepts a session (Supabase) JWT as an MCP token", async () => {
        await expect(connect("eyJhbGciOiJIUzI1NiJ9.e30.assinatura")).rejects.toThrow();
    });

    it("answers GET and DELETE with 405: the server keeps no session", async () => {
        for (const method of ["GET", "DELETE"]) {
            const r = await fetch(base, { method });
            expect(r.status).toBe(405);
            expect(r.headers.get("allow")).toBe("POST");
        }
    });
});

describe("tool gating and results", () => {
    const ctx = (over: Partial<McpContext> = {}): McpContext => ({
        db: {} as never,
        caller: ana,
        displayName: "Ana Teste",
        role: "team",
        workspace: "personal",
        scopes: ["contratos:read"],
        clientName: "codex",
        tokenId: "t1",
        actor: { actorType: "agent", actorId: "mcp:codex", actorName: "codex em nome de Ana Teste", onBehalfOf: ana.userEmail, source: "mcp" },
        ...over,
    });
    const reader = defineTool({
        name: "mike_teste_ler",
        title: "Ler",
        description: "teste",
        input: { project_id: z.string() },
        scope: "contratos:read",
        roles: ["head", "team"],
        access: "read",
        handler: async (_c, input) =>
            input.project_id === "sumiu"
                ? failure("not_found", "Contrato não encontrado.")
                : input.project_id === "quebra"
                  ? { ok: false as const, kind: "error" as const, error: new Error("db down: segredo") }
                  : ok({ id: input.project_id }),
        summary: (o) => `Contrato ${o.id}.`,
    });
    const writer = defineTool({ ...(reader as object), name: "mike_teste_escrever", access: "write" } as never);

    it("publishes a tool only with the scope on the token AND the role on screen", () => {
        expect(allowed(reader, ctx())).toBe(true);
        expect(allowed(reader, ctx({ scopes: ["prazos:read"] }))).toBe(false);
        expect(allowed(reader, ctx({ role: "requester" }))).toBe(false);
        const server = buildServer(ctx({ role: "requester" }), [reader]);
        expect(Object.keys((server as unknown as { _registeredTools: object })._registeredTools)).toEqual([]);
        const writes = buildServer(ctx(), [reader, writer]);
        expect(Object.keys((writes as unknown as { _registeredTools: object })._registeredTools)).toEqual(["mike_teste_ler"]);
    });

    it("maps service failures to MCP errors, hides internal ones, and audits without the arguments", async () => {
        expect(await runTool(reader, ctx(), { project_id: "p1" })).toEqual({
            content: [{ type: "text", text: "Contrato p1." }],
            structuredContent: { id: "p1" },
        });
        expect(await runTool(reader, ctx(), { project_id: "sumiu" })).toMatchObject({
            isError: true,
            structuredContent: { error: { code: "not_found", message: "Contrato não encontrado." } },
        });
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const broken = await runTool(reader, ctx(), { project_id: "quebra" });
        expect(broken).toMatchObject({ isError: true, structuredContent: { error: { code: "internal" } } });
        expect(JSON.stringify(broken)).not.toContain("segredo");
        expect(await runTool(reader, ctx({ role: "requester" }), { project_id: "p1" })).toMatchObject({ structuredContent: { error: { code: "forbidden" } } });
        expect(await runTool(writer, ctx(), { project_id: "p1" })).toMatchObject({ structuredContent: { error: { code: "forbidden" } } });
        spy.mockRestore();
        // Validated here too, not only by the SDK on /mcp.
        expect(await runTool(reader, ctx(), { project_id: 42 })).toMatchObject({ structuredContent: { error: { code: "invalid_input", message: "Argumentos inválidos: project_id." } } });
        expect(await runTool(reader, ctx(), { project_id: "p1", user_id: "outra-pessoa" })).toMatchObject({ structuredContent: { error: { code: "invalid_input" } } });

        const rows = audit.recordAudit.mock.calls.map((c) => (c as unknown[])[1] as Record<string, unknown>);
        expect(rows.map((r) => r.status)).toEqual(["completed", "failed", "failed", "failed", "failed", "failed", "failed"]);
        expect(rows[0]).toMatchObject({ projectId: "p1", detail: { args_hash: argsHash({ project_id: "p1" }) } });
        expect(JSON.stringify(rows)).not.toContain('"project_id":"p1"');
    });

    it("names every failure kind", () => {
        expect(["validation", "forbidden", "not_found", "conflict", "unavailable"].map((k) => errorCode(failure(k as never, "x")))).toEqual([
            "invalid_input",
            "forbidden",
            "not_found",
            "conflict",
            "unavailable",
        ]);
        expect(errorCode({ ok: false, kind: "error", error: null })).toBe("internal");
    });
});
