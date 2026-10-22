import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const access = vi.hoisted(() => ({
    getOrgRole: vi.fn(),
    isOrgAdmin: (role: string | null) => role === "owner" || role === "admin",
}));
vi.mock("../../../lib/access", () => access);
const audit = vi.hoisted(() => ({ recordAudit: vi.fn() }));
vi.mock("../../../lib/audit", () => audit);

import {
    deleteLegalAgentChannel,
    getAgentConfigForBot,
    getLegalAgent,
    getLegalAgentChannelSetup,
    mcpUrl,
    saveLegalAgentChannel,
    saveLegalAgentSettings,
    setLegalAgentChannelStatus,
    AGENT_TOOLS,
} from "../legalAgent.service";
import { DEFAULT_SETTINGS } from "../legalAgent.settings";

const caller = { userId: "u1", userEmail: "head@avenia.io" };
const ORG = "o1";
const form = {
    enabled: true,
    display_name: "Assistente do Jurídico",
    persona: "p",
    tone: "formal",
    hours: { timezone: "America/Sao_Paulo", days: [1], start: "09:00", end: "18:00", outside: "avisa_e_registra" },
    permissions: [],
    escalation: { risk_levels: ["alto"], kinds: [], low_confidence: true, escalate_to_email: "" },
    proactive: { deadline_days: [30], renewals: true, radar: true, digest_time: "08:00" },
};
const channel = {
    id: "c1",
    kind: "slack",
    status: "rascunho",
    name: "Slack da Avenia",
    config: { workspace: "Avenia", channels: ["juridico"], bot_name: "advogado-mike" },
    created_at: "2026-10-21T00:00:00Z",
    updated_at: "2026-10-21T00:00:00Z",
};

beforeEach(() => {
    access.getOrgRole.mockReset();
    audit.recordAudit.mockReset();
    delete process.env.APP_BASE_URL;
    delete process.env.FRONTEND_URL;
});

describe("getLegalAgent", () => {
    it("shows any member the settings and channels, with what they may change", async () => {
        access.getOrgRole.mockResolvedValue("member");
        const fake = scriptedDb([
            { table: "legal_agent_settings", data: null },
            { table: "legal_agent_channels", data: [channel] },
        ]);
        const result = await getLegalAgent(fake.db, caller, ORG);
        expect(result).toMatchObject({
            ok: true,
            data: { settings: DEFAULT_SETTINGS, channels: [channel], can_manage: false, options: { tones: ["formal", "cordial", "direto"] } },
        });
        expect(fake.calls[0].filters).toContainEqual(["eq", "org_id", ORG]);
        expect(fake.calls[1].filters).toContainEqual(["eq", "org_id", ORG]);
        fake.done();
    });

    it("hides another organization's agent and maps read failures", async () => {
        access.getOrgRole.mockResolvedValue(null);
        expect(await getLegalAgent(scriptedDb([]).db, caller, ORG)).toMatchObject({ ok: false, kind: "not_found" });
        access.getOrgRole.mockResolvedValue("admin");
        expect(
            await getLegalAgent(scriptedDb([{ table: "legal_agent_settings", error: { message: "x" } }]).db, caller, ORG),
        ).toMatchObject({ ok: false, kind: "error" });
        expect(
            await getLegalAgent(
                scriptedDb([{ table: "legal_agent_settings", data: null }, { table: "legal_agent_channels", error: { message: "y" } }]).db,
                caller,
                ORG,
            ),
        ).toMatchObject({ ok: false, kind: "error" });
    });
});

describe("saveLegalAgentSettings", () => {
    it("lets an admin save, stamps who and audits", async () => {
        access.getOrgRole.mockResolvedValue("owner");
        const fake = scriptedDb([{ table: "legal_agent_settings", op: "upsert", data: { ...form, updated_at: "2026-10-21T01:00:00Z" } }]);
        const result = await saveLegalAgentSettings(fake.db, caller, ORG, form);
        expect(result).toMatchObject({ ok: true, data: { tone: "formal", updated_at: "2026-10-21T01:00:00Z" } });
        expect(fake.calls[0].payload).toMatchObject({ org_id: ORG, updated_by: "u1", enabled: true });
        expect(audit.recordAudit).toHaveBeenCalledWith(
            fake.db,
            expect.objectContaining({ action: "legal_agent.settings_updated", orgId: ORG, detail: { enabled: true, tone: "formal" } }),
        );
    });

    it("refuses members, strangers and a bad form, and maps a write failure", async () => {
        access.getOrgRole.mockResolvedValue("member");
        expect(await saveLegalAgentSettings(scriptedDb([]).db, caller, ORG, form)).toMatchObject({ kind: "forbidden" });
        access.getOrgRole.mockResolvedValue(null);
        expect(await saveLegalAgentSettings(scriptedDb([]).db, caller, ORG, form)).toMatchObject({ kind: "not_found" });
        access.getOrgRole.mockResolvedValue("admin");
        expect(await saveLegalAgentSettings(scriptedDb([]).db, caller, ORG, { ...form, tone: "x" })).toMatchObject({
            kind: "validation",
            detail: "Escolha o tom: formal, cordial ou direto.",
        });
        const failing = scriptedDb([{ table: "legal_agent_settings", op: "upsert", error: { message: "down" } }]);
        expect(await saveLegalAgentSettings(failing.db, caller, ORG, form)).toMatchObject({ kind: "error" });
        expect(audit.recordAudit).not.toHaveBeenCalled();
    });
});

describe("channels", () => {
    it("creates a draft channel and hands back the setup, pointing at /mcp", async () => {
        process.env.APP_BASE_URL = "https://mike.example/";
        access.getOrgRole.mockResolvedValue("admin");
        const fake = scriptedDb([
            { table: "legal_agent_channels", op: "insert", data: channel },
            { table: "legal_agent_settings", data: null },
        ]);
        const result = await saveLegalAgentChannel(fake.db, caller, ORG, {
            kind: "slack",
            name: " Slack da Avenia ",
            config: { workspace: "Avenia", channels: ["juridico"] },
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(fake.calls[0].payload).toMatchObject({ org_id: ORG, kind: "slack", name: "Slack da Avenia", status: "rascunho", created_by: "u1" });
        expect(result.data.setup.files.find((f) => f.name.startsWith("config.yaml"))!.content).toContain("https://mike.example/mcp");
        expect(audit.recordAudit).toHaveBeenCalledWith(fake.db, expect.objectContaining({ action: "legal_agent.channel_saved" }));
    });

    it("edits a channel only inside its organization", async () => {
        access.getOrgRole.mockResolvedValue("admin");
        const fake = scriptedDb([{ table: "legal_agent_channels", op: "update", data: null }]);
        expect(
            await saveLegalAgentChannel(fake.db, caller, ORG, { id: "c9", kind: "slack", name: "S", config: { workspace: "A" } }),
        ).toMatchObject({ kind: "not_found", detail: "Canal não encontrado." });
        expect(fake.calls[0].filters).toEqual([
            ["eq", "id", "c9"],
            ["eq", "org_id", ORG],
        ]);
    });

    it("keeps the workspace id links count on, and says when another channel has it", async () => {
        access.getOrgRole.mockResolvedValue("admin");
        const fake = scriptedDb([
            { table: "legal_agent_channels", op: "insert", data: channel },
            { table: "legal_agent_settings", data: null },
        ]);
        await saveLegalAgentChannel(fake.db, caller, ORG, { kind: "slack", name: "S", config: { workspace: "A" }, platform_team_id: " T01 " });
        expect(fake.calls[0].payload).toMatchObject({ platform_team_id: "T01" });
        expect(
            await saveLegalAgentChannel(scriptedDb([]).db, caller, ORG, { kind: "slack", name: "S", config: { workspace: "A" }, platform_team_id: "T 01" }),
        ).toMatchObject({ kind: "validation" });
        const taken = scriptedDb([{ table: "legal_agent_channels", op: "insert", error: { code: "23505", message: "dup" } }]);
        expect(await saveLegalAgentChannel(taken.db, caller, ORG, { kind: "slack", name: "S", config: { workspace: "A" }, platform_team_id: "T01" })).toMatchObject({
            kind: "conflict",
            detail: "Este workspace já está ligado a outro canal desta organização.",
        });
    });

    it("refuses a bad channel before touching the database", async () => {
        access.getOrgRole.mockResolvedValue("admin");
        const db = scriptedDb([]).db;
        expect(await saveLegalAgentChannel(db, caller, ORG, { kind: "email", name: "x" })).toMatchObject({
            detail: "Escolha o canal: Slack, WhatsApp ou Telegram.",
        });
        expect(await saveLegalAgentChannel(db, caller, ORG, { kind: "slack", name: "" })).toMatchObject({ kind: "validation" });
        expect(
            await saveLegalAgentChannel(db, caller, ORG, { kind: "slack", name: "S", config: { workspace: "xoxb-1" } }),
        ).toMatchObject({ detail: expect.stringMatching(/^Não cole tokens/) });
        access.getOrgRole.mockResolvedValue("member");
        expect(await saveLegalAgentChannel(db, caller, ORG, { kind: "slack" })).toMatchObject({ kind: "forbidden" });
        access.getOrgRole.mockResolvedValue(null);
        expect(await saveLegalAgentChannel(db, caller, ORG, { kind: "slack" })).toMatchObject({ kind: "not_found" });
        access.getOrgRole.mockResolvedValue("admin");
        const failing = scriptedDb([{ table: "legal_agent_channels", op: "insert", error: { message: "x" } }]);
        expect(await saveLegalAgentChannel(failing.db, caller, ORG, { kind: "slack", name: "S", config: { workspace: "A" } })).toMatchObject({
            kind: "error",
        });
    });

    it("regenerates a saved channel's setup for admins only", async () => {
        access.getOrgRole.mockResolvedValue("admin");
        const fake = scriptedDb([
            { table: "legal_agent_channels", data: channel },
            { table: "legal_agent_settings", data: { display_name: "Jurídico" } },
        ]);
        const result = await getLegalAgentChannelSetup(fake.db, caller, ORG, "c1");
        expect(result).toMatchObject({ ok: true, data: { kind: "slack" } });
        expect(fake.calls[0].filters).toEqual([
            ["eq", "id", "c1"],
            ["eq", "org_id", ORG],
        ]);
        expect(
            await getLegalAgentChannelSetup(scriptedDb([{ table: "legal_agent_channels", data: null }]).db, caller, ORG, "c9"),
        ).toMatchObject({ kind: "not_found" });
        expect(
            await getLegalAgentChannelSetup(
                scriptedDb([{ table: "legal_agent_channels", data: { ...channel, config: {} } }]).db,
                caller,
                ORG,
                "c1",
            ),
        ).toMatchObject({ kind: "conflict" });
        expect(
            await getLegalAgentChannelSetup(scriptedDb([{ table: "legal_agent_channels", error: { message: "x" } }]).db, caller, ORG, "c1"),
        ).toMatchObject({ kind: "error" });
        access.getOrgRole.mockResolvedValue("member");
        expect(await getLegalAgentChannelSetup(scriptedDb([]).db, caller, ORG, "c1")).toMatchObject({ kind: "forbidden" });
        access.getOrgRole.mockResolvedValue(null);
        expect(await getLegalAgentChannelSetup(scriptedDb([]).db, caller, ORG, "c1")).toMatchObject({ kind: "not_found" });
    });

    it("marks a channel installed or paused, and deletes it", async () => {
        access.getOrgRole.mockResolvedValue("owner");
        const marked = scriptedDb([{ table: "legal_agent_channels", op: "update", data: { ...channel, status: "configurado" } }]);
        expect(await setLegalAgentChannelStatus(marked.db, caller, ORG, "c1", "configurado")).toMatchObject({
            ok: true,
            data: { status: "configurado" },
        });
        expect(marked.calls[0].filters).toContainEqual(["eq", "org_id", ORG]);
        expect(await setLegalAgentChannelStatus(scriptedDb([]).db, caller, ORG, "c1", "ligado")).toMatchObject({
            detail: "Situação do canal desconhecida.",
        });
        expect(
            await setLegalAgentChannelStatus(scriptedDb([{ table: "legal_agent_channels", op: "update", data: null }]).db, caller, ORG, "c9", "pausado"),
        ).toMatchObject({ kind: "not_found" });
        expect(
            await setLegalAgentChannelStatus(
                scriptedDb([{ table: "legal_agent_channels", op: "update", error: { message: "x" } }]).db,
                caller,
                ORG,
                "c1",
                "pausado",
            ),
        ).toMatchObject({ kind: "error" });

        const removed = scriptedDb([{ table: "legal_agent_channels", op: "delete", data: { id: "c1", name: "Slack" } }]);
        expect(await deleteLegalAgentChannel(removed.db, caller, ORG, "c1")).toEqual({ ok: true, data: { deleted: true } });
        expect(
            await deleteLegalAgentChannel(scriptedDb([{ table: "legal_agent_channels", op: "delete", data: null }]).db, caller, ORG, "c9"),
        ).toMatchObject({ kind: "not_found" });
        expect(
            await deleteLegalAgentChannel(scriptedDb([{ table: "legal_agent_channels", op: "delete", error: { message: "x" } }]).db, caller, ORG, "c1"),
        ).toMatchObject({ kind: "error" });
        expect(audit.recordAudit.mock.calls.map((c) => c[1].action)).toEqual(["legal_agent.channel_status", "legal_agent.channel_deleted"]);

        for (const role of ["member", null]) {
            access.getOrgRole.mockResolvedValue(role);
            const kind = role ? "forbidden" : "not_found";
            expect(await setLegalAgentChannelStatus(scriptedDb([]).db, caller, ORG, "c1", "pausado")).toMatchObject({ kind });
            expect(await deleteLegalAgentChannel(scriptedDb([]).db, caller, ORG, "c1")).toMatchObject({ kind });
        }
    });
});

describe("what the bot reads (mike_agente_config)", () => {
    it("serves the settings and the installed channel it speaks on", async () => {
        const fake = scriptedDb([
            { table: "legal_agent_settings", data: { enabled: true, display_name: "Jurídico" } },
            { table: "legal_agent_channels", data: [{ kind: "slack", name: "Slack da Avenia" }] },
        ]);
        const result = await getAgentConfigForBot(fake.db, ORG, "slack");
        expect(result).toMatchObject({ ok: true, data: { ativo: true, nome: "Jurídico", canal_atual: { kind: "slack" } } });
        expect(fake.calls[1].filters).toContainEqual(["eq", "status", "configurado"]);
        const none = scriptedDb([{ table: "legal_agent_settings", data: null }, { table: "legal_agent_channels", data: null }]);
        expect(await getAgentConfigForBot(none.db, ORG, "telegram")).toMatchObject({ data: { ativo: false, canal_atual: null } });
        const failing = scriptedDb([{ table: "legal_agent_settings", data: null }, { table: "legal_agent_channels", error: { message: "x" } }]);
        expect(await getAgentConfigForBot(failing.db, ORG, "whatsapp")).toMatchObject({ kind: "error" });
    });

    it("is registered as mike_agente_config, read-only, for the agente:config scope", async () => {
        const [tool] = AGENT_TOOLS;
        expect(tool).toMatchObject({ name: "mike_agente_config", scope: "agente:config", access: "read" });
        expect(await tool.handler({ db: scriptedDb([]).db, workspace: "personal" }, {})).toMatchObject({ kind: "not_found" });
        expect(await tool.handler({ db: scriptedDb([]).db, workspace: null }, {})).toMatchObject({ kind: "not_found" });

        const viaHeader = scriptedDb([{ table: "legal_agent_settings", data: null }, { table: "legal_agent_channels", data: [] }]);
        await tool.handler({ db: viaHeader.db, workspace: ORG, channel: "telegram" }, {});
        expect(viaHeader.calls[1].filters).toContainEqual(["eq", "kind", "telegram"]);
        const viaArg = scriptedDb([{ table: "legal_agent_settings", data: { enabled: true } }]);
        const off = await tool.handler({ db: viaArg.db, workspace: ORG }, {});
        expect(off.ok).toBe(true);
        if (off.ok) expect(tool.summary(off.data)).toMatch(/está ligado, em tom cordial, de seg, ter, qua, qui, sex, das 09:00 às 18:00/);
        const offResult = await tool.handler({ db: scriptedDb([{ table: "legal_agent_settings", data: null }]).db, workspace: ORG }, {});
        if (offResult.ok) expect(tool.summary(offResult.data)).toMatch(/está desligado/);
    });

    it("points the bot at the backend's /mcp", () => {
        expect(mcpUrl()).toBe("http://localhost:3000/mcp");
        process.env.FRONTEND_URL = "https://front.example/";
        expect(mcpUrl()).toBe("https://front.example/mcp");
    });
});
