import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { channelSetup, looksLikeSecret, parseChannelConfig, slackManifest } from "../legalAgent.setup";

const settings = { display_name: "Assistente do Legal com um nome bem comprido demais" };
const MCP = "https://mike.example/mcp";

describe("looksLikeSecret", () => {
    it.each(["xoxb-1-2", "xapp-1-A", "123456789:AAH" + "a".repeat(32), "EAA" + "B".repeat(30), "mike_agt_abc", "sk-" + "a".repeat(20)])(
        "flags %s",
        (value) => expect(looksLikeSecret(value)).toBe(true),
    );
    it("lets ordinary names through", () => {
        expect(looksLikeSecret("Avenia Legal")).toBe(false);
        expect(looksLikeSecret("acme_juridico_bot")).toBe(false);
    });
});

describe("parseChannelConfig", () => {
    it("refuses anything that looks like a token, in any field", () => {
        expect(parseChannelConfig("slack", { workspace: "Avenia", channels: ["xoxb-123"] })).toEqual({
            ok: false,
            detail: expect.stringMatching(/^Não cole tokens/),
        });
        expect(parseChannelConfig("telegram", { bot_username: "123456789:AA" + "x".repeat(33) }).ok).toBe(false);
    });

    it("reads a Slack channel", () => {
        expect(parseChannelConfig("slack", { workspace: " Avenia ", channels: ["#juridico", "juridico", "pedidos-legal"] })).toEqual({
            ok: true,
            value: { workspace: "Avenia", channels: ["juridico", "pedidos-legal"], bot_name: "advogado-mike" },
        });
        expect(parseChannelConfig("slack", {}).ok).toBe(false);
        expect(parseChannelConfig("slack", null)).toEqual({ ok: false, detail: "Informe o nome do workspace do Slack." });
        expect(parseChannelConfig("slack", { workspace: "A", bot_name: "Advogado Mike" })).toMatchObject({ ok: false });
        expect(parseChannelConfig("slack", { workspace: "A", channels: ["Canal Geral"] })).toEqual({
            ok: false,
            detail: "Nome de canal inválido: Canal Geral.",
        });
        expect(parseChannelConfig("slack", { workspace: "A", channels: [3] })).toMatchObject({ ok: false });
    });

    it("reads a Telegram bot", () => {
        expect(parseChannelConfig("telegram", { bot_username: "@acme_juridico_bot" })).toEqual({
            ok: true,
            value: { bot_username: "acme_juridico_bot", mode: "polling" },
        });
        expect(parseChannelConfig("telegram", { bot_username: "acme_juridico_bot", mode: "webhook" })).toMatchObject({
            value: { mode: "webhook" },
        });
        expect(parseChannelConfig("telegram", { bot_username: "acme" }).ok).toBe(false);
        expect(parseChannelConfig("telegram", { bot_username: "acme_bot", mode: "push" })).toEqual({
            ok: false,
            detail: "Escolha como o bot recebe mensagens: polling ou webhook.",
        });
    });

    it("reads a WhatsApp number by its last digits only", () => {
        expect(parseChannelConfig("whatsapp", { phone_last4: "1234", business_name: "Avenia" })).toEqual({
            ok: true,
            value: { phone_last4: "1234", business_name: "Avenia" },
        });
        expect(parseChannelConfig("whatsapp", { phone_last4: "+55 11 99999-1234" }).ok).toBe(false);
        expect(parseChannelConfig("whatsapp", { phone_last4: "1234" })).toEqual({
            ok: false,
            detail: "Informe o nome da empresa na conta do WhatsApp Business.",
        });
    });
});

describe("channelSetup", () => {
    it("builds a Slack manifest in Socket Mode with exactly the scopes the agent needs", () => {
        const manifest = parse(slackManifest(settings, { workspace: "A", channels: [], bot_name: "advogado-mike" }));
        expect(manifest.display_information.name).toHaveLength(35);
        expect(manifest.settings).toMatchObject({ socket_mode_enabled: true, org_deploy_enabled: false });
        expect(manifest.settings.event_subscriptions.bot_events).toEqual(["app_mention", "message.im"]);
        expect(manifest.oauth_config.scopes.bot).toContain("users:read.email");
        expect(manifest.oauth_config.scopes.bot).not.toContain("channels:history");
    });

    it("gives Slack steps and files with placeholders, never a token", () => {
        const setup = channelSetup("slack", { workspace: "A", channels: ["juridico"], bot_name: "advogado-mike" }, settings, MCP);
        expect(setup.steps.map((s) => s.title)).toContain("Guardar os tokens no cofre");
        expect(setup.steps.at(-1)?.detail).toContain("#juridico");
        const snippet = setup.files.find((f) => f.name.startsWith("config.yaml"))!.content;
        const parsed = parse(snippet);
        expect(parsed.mcp_servers.mike).toMatchObject({ url: MCP, headers: { "X-Mike-Channel": "slack" } });
        expect(parsed.mcp_servers.mike.headers.Authorization).toBe("Bearer ${MIKE_AGENT_TOKEN}");
        expect(parsed.slack.allowed_channels).toEqual(["<id de #juridico>"]);
        expect(snippet).toContain("nunca pelo modelo");
        expect(setup.warnings.join(" ")).toMatch(/Marketplace/);
        const dm = channelSetup("slack", { workspace: "A", channels: [], bot_name: "b" }, settings, MCP);
        expect(dm.steps.at(-1)?.detail).toContain("mensagens diretas");
        for (const file of [...setup.files, ...dm.files]) expect(looksLikeSecret(file.content)).toBe(false);
    });

    it("uses polling for Telegram when there is no public address, and warns about webhooks", () => {
        const polling = channelSetup("telegram", { bot_username: "acme_bot", mode: "polling" }, settings, MCP);
        expect(polling.files[0]).toMatchObject({ name: "polling.http" });
        expect(polling.files[0].content).toContain("deleteWebhook");
        expect(polling.warnings).toHaveLength(1);
        const webhook = channelSetup("telegram", { bot_username: "acme_bot", mode: "webhook" }, settings, MCP);
        expect(webhook.files[0].name).toBe("setWebhook.http");
        expect(webhook.files[0].content).toContain('"secret_token"');
        expect(webhook.warnings.join(" ")).toMatch(/IAP/);
        expect(webhook.steps.map((s) => s.title)).toContain("Apontar o webhook");
    });

    it("lists WhatsApp's webhook, templates and the IAP limit", () => {
        const setup = channelSetup("whatsapp", { phone_last4: "1234", business_name: "Avenia" }, settings, MCP);
        expect(setup.steps[1].detail).toContain("1234");
        expect(setup.files.map((f) => f.name)).toEqual(["webhook.txt", "modelos.txt", "config.yaml (trecho)"]);
        expect(setup.files[1].content).toMatch(/lembrete_prazo.*pedido_atualizado.*info_pendente/s);
        expect(setup.warnings.join(" ")).toMatch(/IAP.*simuladas/s);
    });
});
