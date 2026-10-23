// mike_feedback_reportar through the real runner: a write in two steps, no
// open world, any role, redacted on the way in (doc 13 §4).

import { beforeEach, describe, expect, it, vi } from "vitest";

const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("../../../lib/audit", () => audit);
const queue = vi.hoisted(() => ({ enqueueDbJob: vi.fn(async () => ({ id: "j", deduped: false })) }));
vi.mock("../../../lib/dbq/enqueue", () => queue);

import { fakeDb } from "../../mcp/__tests__/fakeDb";
import { testContext } from "../../mcp/__tests__/runToolForTest";
import { CONFIRM_FIELD, runTool } from "../../mcp/mcp.server";
import { catalogTools, WRITE_TOOLS_ENABLED } from "../../mcp/mcp.catalog";
import { FEEDBACK_TOOLS } from "../feedback.mcp";

const tool = FEEDBACK_TOOLS[0];
let db: ReturnType<typeof fakeDb>;
const ctx = (over = {}) => testContext({ db: db.db, scopes: ["feedback:write"], role: "requester", ...over });

beforeEach(() => {
    process.env.FEEDBACK_ENABLED = "true";
    db = fakeDb({ mcp_confirmations: [], feedback_reports: [] });
    queue.enqueueDbJob.mockClear();
});

describe("mike_feedback_reportar", () => {
    it("is a confirmed write that does not reach outside, open to every role", () => {
        expect(tool).toMatchObject({ access: "write", scope: "feedback:write", roles: ["head", "team", "requester"] });
        expect(tool.annotations?.openWorldHint).toBe(false);
        expect(tool.confirm).toBeDefined();
        expect(WRITE_TOOLS_ENABLED.has("mike_feedback_reportar")).toBe(true);
    });

    it("is in the catalog only while the flag is on", () => {
        // The catalog is built once: this checks the allowlist and the tool's shape, not a rebuild.
        expect(catalogTools().every((t) => t.access === "read" || WRITE_TOOLS_ENABLED.has(t.name))).toBe(true);
    });

    it("first call stores nothing and shows the redacted text; the confirmed call files the report", async () => {
        const input = { tipo: "bug", descricao: "Erro com ana@exemplo.test no pedido", rota: "/pedidos?x=1" };
        const first = await runTool(tool, ctx(), input);
        expect(first.structuredContent).toMatchObject({ precisa_confirmar: true });
        expect(JSON.stringify(first.structuredContent)).not.toContain("ana@exemplo.test");
        expect(db.tables.feedback_reports).toEqual([]);

        const token = (first.structuredContent as { confirm_token: string }).confirm_token;
        const done = await runTool(tool, ctx(), { ...input, [CONFIRM_FIELD]: token });
        expect(done.isError).toBeFalsy();
        // The fake has no Postgres sequence, so the number is not assigned here (the real one is).
        expect((done.content as { text: string }[])[0].text).toMatch(/^Relato REL-\S+ enviado ao time de tecnologia \(dados pessoais foram apagados/);
        expect(db.tables.feedback_reports).toHaveLength(1);
        expect(db.tables.feedback_reports[0]).toMatchObject({ source: "agent", client: "claude-code", body: "Erro com [e-mail] no pedido", route: "/pedidos" });
    });
});
