// Two-step confirmation of writes (doc 09 §6), through the real runner:
// the first call changes nothing, the second runs only with this person's
// token for these exact arguments, once, in time. Fictional data only.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("../../../lib/audit", () => audit);
// The test writes are switched on here; the real list is the catalog's.
vi.mock("../mcp.catalog", () => ({
    WRITE_TOOLS_ENABLED: new Set(["mike_teste_mover", "mike_teste_outra"]),
    catalogTools: () => [],
}));

import { ok } from "../../../lib/serviceResult";
import { argumentsHash, canonicalJson, CONFIRM_MINUTES } from "../mcp.confirm";
import { buildServer, CONFIRM_FIELD, runTool } from "../mcp.server";
import { defineTool } from "../mcp.types";
import { fakeDb } from "./fakeDb";
import { testContext } from "./runToolForTest";

const P1 = "00000000-0000-4000-a000-000000000001";
const moved: string[] = [];
const mover = defineTool({
    name: "mike_teste_mover",
    title: "Mover",
    description: "Move um card de etapa.",
    input: { project_id: z.string(), etapa: z.enum(["triagem", "revisao"]) },
    scope: "pedidos:write",
    roles: ["head", "team"],
    access: "write",
    confirm: {
        preview: async (_ctx, input) => ok({ resumo: `Mover o contrato para ${input.etapa}.`, detalhes: { de: "entrada" } }),
    },
    handler: async (_ctx, input) => {
        moved.push(`${input.project_id}->${input.etapa}`);
        return ok({ etapa: input.etapa });
    },
    summary: (o) => `Movido para ${o.etapa}.`,
});
const unconfirmed = defineTool({ ...(mover as object), name: "mike_teste_sem_confirmacao", confirm: undefined } as never);

let db: ReturnType<typeof fakeDb>;
const ctx = (over = {}) => testContext({ db: db.db, scopes: ["pedidos:write"], ...over });

beforeEach(() => {
    db = fakeDb({ mcp_confirmations: [] });
    moved.length = 0;
    audit.recordAudit.mockClear();
});

async function propose(input = { project_id: P1, etapa: "revisao" }, c = ctx()) {
    const r = await runTool(mover, c, input);
    return { r, token: (r.structuredContent as { confirm_token: string }).confirm_token };
}

describe("two-step writes", () => {
    it("changes nothing on the first call and returns a summary and a single-use token", async () => {
        const { r, token } = await propose();
        expect(moved).toEqual([]);
        expect(r.structuredContent).toMatchObject({
            precisa_confirmar: true,
            resumo: "Mover o contrato para revisao.",
            detalhes: { de: "entrada" },
            confirm_token: expect.stringMatching(/^mike_cfm_/),
        });
        expect((r.content as { text: string }[])[0].text).toMatch(/^Confirme com a pessoa antes: Mover o contrato para revisao\. Se ela concordar/);
        const row = db.tables.mcp_confirmations[0];
        expect(row).toMatchObject({ user_id: ctx().caller.userId, access_token_id: "token-1", link_id: null, tool: "mike_teste_mover" });
        expect(row.token_hash).not.toBe(token);
        expect(JSON.stringify(db.tables)).not.toContain(token);
        expect(Date.parse(String(row.expires_at)) - Date.now()).toBeLessThanOrEqual(CONFIRM_MINUTES * 60_000);
    });

    it("runs once with the token and the same arguments, and audits both steps", async () => {
        const { token } = await propose();
        const done = await runTool(mover, ctx(), { project_id: P1, etapa: "revisao", [CONFIRM_FIELD]: token });
        expect(done).toEqual({ content: [{ type: "text", text: "Movido para revisao." }], structuredContent: { etapa: "revisao" } });
        expect(moved).toEqual([`${P1}->revisao`]);

        const again = await runTool(mover, ctx(), { project_id: P1, etapa: "revisao", [CONFIRM_FIELD]: token });
        expect(again).toMatchObject({ isError: true, structuredContent: { error: { code: "invalid_input" } } });
        expect(moved).toHaveLength(1);

        const steps = audit.recordAudit.mock.calls.map((c) => ((c as unknown[])[1] as { detail: { step?: string; ok: boolean } }).detail);
        expect(steps.map((d) => [d.step, d.ok])).toEqual([["proposta", true], ["confirmada", true], ["confirmada", false]]);
    });

    it("refuses the token for other arguments, another tool, another person, another access token or link", async () => {
        const { token } = await propose();
        const refused = async (c: ReturnType<typeof ctx>, input: Record<string, unknown>, tool = mover) =>
            (await runTool(tool, c, { ...input, [CONFIRM_FIELD]: token })).isError;
        expect(await refused(ctx(), { project_id: P1, etapa: "triagem" })).toBe(true);
        expect(await refused(ctx(), { project_id: "outro", etapa: "revisao" })).toBe(true);
        expect(await refused(ctx({ caller: { userId: "outra-pessoa", userEmail: "x@exemplo.test" } }), { project_id: P1, etapa: "revisao" })).toBe(true);
        expect(await refused(ctx({ tokenId: "outro-token" }), { project_id: P1, etapa: "revisao" })).toBe(true);
        expect(await refused(ctx({ linkId: "outro-vinculo" }), { project_id: P1, etapa: "revisao" })).toBe(true);
        const otherTool = defineTool({ ...(mover as object), name: "mike_teste_outra" } as never);
        expect(await refused(ctx(), { project_id: P1, etapa: "revisao" }, otherTool)).toBe(true);
        expect(moved).toEqual([]);
        // Still good for the right call: refusals do not burn it.
        expect((await runTool(mover, ctx(), { project_id: P1, etapa: "revisao", [CONFIRM_FIELD]: token })).isError).toBeFalsy();
    });

    it("refuses an expired or made-up token", async () => {
        const { token } = await propose();
        db.tables.mcp_confirmations[0].expires_at = new Date(Date.now() - 1000).toISOString();
        expect((await runTool(mover, ctx(), { project_id: P1, etapa: "revisao", [CONFIRM_FIELD]: token })).isError).toBe(true);
        expect((await runTool(mover, ctx(), { project_id: P1, etapa: "revisao", [CONFIRM_FIELD]: "mike_cfm_inventado" })).isError).toBe(true);
        expect((await runTool(mover, ctx(), { project_id: P1, etapa: "revisao", [CONFIRM_FIELD]: "qualquer" })).isError).toBe(true);
        expect(moved).toEqual([]);
    });

    it("never runs a write without a confirmation step, and a read takes no token", async () => {
        expect(await runTool(unconfirmed, ctx(), { project_id: P1, etapa: "revisao" })).toMatchObject({ structuredContent: { error: { code: "forbidden" } } });
        // Not switched on by name: refused even with a preview, even called directly.
        const off = defineTool({ ...(mover as object), name: "mike_teste_desligada" } as never);
        expect(await runTool(off, ctx(), { project_id: P1, etapa: "revisao" })).toMatchObject({ structuredContent: { error: { code: "forbidden" } } });
        expect(db.tables.mcp_confirmations).toEqual([]);
        const reader = defineTool({ ...(mover as object), name: "mike_teste_ler", access: "read", scope: "contratos:read", confirm: undefined } as never);
        expect(await runTool(reader, ctx({ scopes: ["contratos:read"] }), { project_id: P1, etapa: "revisao", [CONFIRM_FIELD]: "x" })).toMatchObject({
            structuredContent: { error: { code: "invalid_input" } },
        });
    });

    it("publishes writes with the confirm_token argument and not-read-only annotations; hides unconfirmed writes", () => {
        const server = buildServer(ctx(), [mover, unconfirmed]);
        const tools = (server as unknown as { _registeredTools: Record<string, { annotations?: Record<string, unknown>; inputSchema?: unknown }> })._registeredTools;
        expect(Object.keys(tools)).toEqual(["mike_teste_mover"]);
        expect(tools.mike_teste_mover.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    });

    it("hashes arguments by content, not key order", () => {
        expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"x":2,"y":1}]},"b":1}');
        expect(argumentsHash({ a: 1, b: 2 })).toBe(argumentsHash({ b: 2, a: 1 }));
        expect(argumentsHash({ a: 1 })).not.toBe(argumentsHash({ a: "1" }));
    });
});
