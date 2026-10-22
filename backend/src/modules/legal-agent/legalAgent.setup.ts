// The installation assistant: for each chat channel, the files and steps an
// admin needs to connect the legal team's agent, generated from what they
// typed. Pure functions; nothing here calls Slack, Telegram or Meta, stores a
// secret or turns a bot on. Where a secret goes, the output says where to put
// it (the deployment's secret store) and shows a placeholder.
//
// Formats follow docs/product/10b-advogado-por-chat-canais.md. The bot runs
// on Hermes (hermes-gcp-deploy); the generated Hermes snippet points it at
// Mike's MCP server with an agent token, and the acting person's e-mail is
// added by Hermes's router code (X-Mike-Acting-User), never by the model.

import { stringify } from "yaml";
import type { AgentSettings } from "./legalAgent.settings";

export const CHANNEL_KINDS = ["slack", "whatsapp", "telegram"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export type ChannelConfig = {
    slack: { workspace: string; channels: string[]; bot_name: string };
    telegram: { bot_username: string; mode: "polling" | "webhook" };
    whatsapp: { phone_last4: string; business_name: string };
};

export type SetupFile = { name: string; language: "yaml" | "http" | "text" | "env"; content: string };
export type SetupStep = { title: string; detail: string };
export type ChannelSetup = {
    kind: ChannelKind;
    /** Where the person goes next, in order. */
    steps: SetupStep[];
    files: SetupFile[];
    /** What the channel needs that this deployment may not have. */
    warnings: string[];
};

/** Something that looks like a credential: never accepted in a settings field. */
const SECRET_PATTERNS = [
    /xox[abprs]-/i, // Slack bot/user tokens
    /xapp-/i, // Slack app-level tokens
    /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/, // Telegram bot token
    /\bEAA[A-Za-z0-9]{20,}/, // Meta access token
    /mike_(pat|agt)_/i, // Mike access tokens
    /sk-[A-Za-z0-9]{16,}/, // provider API keys
];

export function looksLikeSecret(value: string): boolean {
    return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

type Parsed<T> = { ok: true; value: T } | { ok: false; detail: string };
const SECRET_REFUSAL =
    "Não cole tokens nem segredos aqui. Eles ficam no cofre do deploy; o Mike guarda só o que é seguro mostrar.";

function cleanName(value: unknown, max: number): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= max ? trimmed : null;
}

/** The non-secret details of a channel, checked. Every refusal is a sentence for the person. */
export function parseChannelConfig(kind: ChannelKind, input: unknown): Parsed<ChannelConfig[ChannelKind]> {
    const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const strings = Object.values(raw).flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => typeof v === "string");
    if (strings.some((s) => looksLikeSecret(s as string))) return { ok: false, detail: SECRET_REFUSAL };

    if (kind === "slack") {
        const workspace = cleanName(raw.workspace, 80);
        if (!workspace) return { ok: false, detail: "Informe o nome do workspace do Slack." };
        const botName = cleanName(raw.bot_name ?? "advogado-mike", 80);
        if (!botName || !/^[a-z0-9._-]+$/.test(botName))
            return { ok: false, detail: "O nome do bot no Slack usa só letras minúsculas, números, ponto, hífen e sublinhado." };
        const channels = Array.isArray(raw.channels) ? raw.channels : [];
        const names: string[] = [];
        for (const c of channels) {
            const name = typeof c === "string" ? c.trim().replace(/^#/, "") : "";
            if (!/^[a-z0-9._-]{1,80}$/.test(name)) return { ok: false, detail: `Nome de canal inválido: ${String(c)}.` };
            if (!names.includes(name)) names.push(name);
        }
        return { ok: true, value: { workspace, channels: names, bot_name: botName } };
    }
    if (kind === "telegram") {
        const username = cleanName(raw.bot_username, 64)?.replace(/^@/, "") ?? null;
        if (!username || !/^[A-Za-z][A-Za-z0-9_]{3,30}bot$/i.test(username))
            return { ok: false, detail: "O usuário do bot no Telegram termina em 'bot', como acme_juridico_bot." };
        const mode = raw.mode === "webhook" ? "webhook" : raw.mode === undefined || raw.mode === "polling" ? "polling" : null;
        if (!mode) return { ok: false, detail: "Escolha como o bot recebe mensagens: polling ou webhook." };
        return { ok: true, value: { bot_username: username, mode } };
    }
    const last4 = typeof raw.phone_last4 === "string" ? raw.phone_last4.trim() : "";
    if (!/^\d{4}$/.test(last4)) return { ok: false, detail: "Informe só os 4 últimos dígitos do número do WhatsApp." };
    const business = cleanName(raw.business_name, 80);
    if (!business) return { ok: false, detail: "Informe o nome da empresa na conta do WhatsApp Business." };
    return { ok: true, value: { phone_last4: last4, business_name: business } };
}

/** The Hermes profile's MCP entry: Mike as the bot's only source of work and record. */
function hermesMcpSnippet(mcpUrl: string, kind: ChannelKind): string {
    return (
        "# Trecho para o config.yaml do perfil no Hermes (hermes-gcp-deploy).\n" +
        "# O token de agente é criado em Configurações > Tokens de acesso para agentes e fica no .env do perfil.\n" +
        "# O header X-Mike-Acting-User (e-mail de quem fala) é posto pelo roteador do Hermes, nunca pelo modelo.\n" +
        stringify({
            mcp_servers: {
                mike: {
                    url: mcpUrl,
                    auth: "header",
                    headers: { Authorization: "Bearer ${MIKE_AGENT_TOKEN}", "X-Mike-Channel": kind },
                    tools: { resources: false, prompts: false },
                },
            },
        })
    );
}

export function slackManifest(settings: Pick<AgentSettings, "display_name">, config: ChannelConfig["slack"]): string {
    return stringify({
        _metadata: { major_version: 2, minor_version: 1 },
        display_information: {
            name: settings.display_name.slice(0, 35),
            description: "Peça ao Legal, acompanhe seus pedidos e tire dúvidas jurídicas.".slice(0, 140),
            background_color: "#1f2937",
        },
        features: {
            app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
            bot_user: { display_name: config.bot_name, always_online: true },
        },
        oauth_config: {
            scopes: {
                bot: [
                    "app_mentions:read",
                    "chat:write",
                    "im:history",
                    "im:read",
                    "im:write",
                    "files:read",
                    "users:read",
                    "users:read.email",
                ],
            },
        },
        settings: {
            event_subscriptions: { bot_events: ["app_mention", "message.im"] },
            interactivity: { is_enabled: true },
            socket_mode_enabled: true,
            org_deploy_enabled: false,
            token_rotation_enabled: false,
        },
    });
}

export function channelSetup(
    kind: ChannelKind,
    config: ChannelConfig[ChannelKind],
    settings: Pick<AgentSettings, "display_name">,
    mcpUrl: string,
): ChannelSetup {
    if (kind === "slack") {
        const slack = config as ChannelConfig["slack"];
        const where = slack.channels.length ? slack.channels.map((c) => `#${c}`).join(", ") : "mensagens diretas";
        return {
            kind,
            steps: [
                { title: "Criar o app", detail: "Em api.slack.com/apps, clique em Create New App > From a manifest, escolha o workspace e cole o manifest abaixo." },
                { title: "Gerar o token de conexão", detail: "Em Basic Information > App-Level Tokens, gere um token com o escopo connections:write. Ele começa com xapp-." },
                { title: "Instalar no workspace", detail: "Em Install App, clique em Install to Workspace. Copie o Bot User OAuth Token, que começa com xoxb-." },
                { title: "Guardar os tokens no cofre", detail: "Os dois tokens vão para o .env do perfil no Hermes, nunca para o Mike nem para o chat." },
                { title: "Ligar ao Mike", detail: "Cole o trecho do Hermes no config.yaml do perfil, com o token de agente do Mike no .env." },
                { title: "Convidar o bot", detail: `O agente atende em ${where}. Num canal, use /invite @${slack.bot_name}.` },
            ],
            files: [
                { name: "slack_app_manifest.yaml", language: "yaml", content: slackManifest(settings, slack) },
                {
                    name: ".env (perfil do Hermes)",
                    language: "env",
                    content: "SLACK_BOT_TOKEN=<Bot User OAuth Token, do passo 3>\nSLACK_APP_TOKEN=<App-Level Token, do passo 2>\nMIKE_AGENT_TOKEN=<token de agente do Mike>\n",
                },
                { name: "config.yaml (trecho)", language: "yaml", content: slackHermesSnippet(slack, mcpUrl) },
            ],
            warnings: [
                "App criado por manifest serve para uso interno da empresa e para pilotos. Para oferecer a outros clientes, o Slack exige um app distribuído pelo Marketplace.",
                "Atenda por mensagem direta. Canais compartilhados com outras empresas (Slack Connect) ficam de fora.",
            ],
        };
    }
    if (kind === "telegram") {
        const telegram = config as ChannelConfig["telegram"];
        const files: SetupFile[] = [
            {
                name: telegram.mode === "webhook" ? "setWebhook.http" : "polling.http",
                language: "http",
                content:
                    telegram.mode === "webhook"
                        ? "POST https://api.telegram.org/bot<TOKEN>/setWebhook\nContent-Type: application/json\n\n" +
                          JSON.stringify(
                              {
                                  url: "https://<host público>/integrations/telegram/webhook",
                                  secret_token: "<segredo aleatório de 1 a 256 caracteres A-Za-z0-9_->",
                                  allowed_updates: ["message", "callback_query"],
                                  drop_pending_updates: true,
                                  max_connections: 40,
                              },
                              null,
                              2,
                          ) +
                          "\n"
                        : "# Sem endereço público: o bot busca as mensagens (um único processo por token).\n" +
                          "POST https://api.telegram.org/bot<TOKEN>/deleteWebhook\n\n" +
                          "POST https://api.telegram.org/bot<TOKEN>/getUpdates\nContent-Type: application/json\n\n" +
                          JSON.stringify({ offset: "<último update_id + 1>", timeout: 50, limit: 100, allowed_updates: ["message", "callback_query"] }, null, 2) +
                          "\n",
            },
            { name: ".env (perfil do Hermes)", language: "env", content: "TELEGRAM_BOT_TOKEN=<token do BotFather>\nMIKE_AGENT_TOKEN=<token de agente do Mike>\n" },
            { name: "config.yaml (trecho)", language: "yaml", content: hermesMcpSnippet(mcpUrl, "telegram") },
        ];
        return {
            kind,
            steps: [
                { title: "Criar o bot", detail: `No Telegram, abra o @BotFather, mande /newbot e use o usuário @${telegram.bot_username}.` },
                { title: "Fechar o bot para grupos", detail: "No BotFather, use /setprivacy > Enable e /setjoingroups > Disable: o agente atende só em conversa direta." },
                { title: "Guardar o token no cofre", detail: "O token do BotFather vai para o .env do perfil no Hermes, nunca para o Mike nem para o chat." },
                {
                    title: telegram.mode === "webhook" ? "Apontar o webhook" : "Ligar a busca de mensagens",
                    detail:
                        telegram.mode === "webhook"
                            ? "Rode a chamada setWebhook abaixo com o endereço público e um segredo; o Telegram manda esse segredo em cada mensagem."
                            : "O Hermes busca as mensagens sozinho (getUpdates). Não precisa de endereço público.",
                },
                { title: "Ligar ao Mike", detail: "Cole o trecho do Hermes no config.yaml do perfil, com o token de agente do Mike no .env." },
            ],
            files,
            warnings: [
                "Telegram só para demonstração e piloto: as conversas com bots não têm criptografia de ponta a ponta.",
                ...(telegram.mode === "webhook"
                    ? ["O webhook precisa de um endereço HTTPS público. O staging fica atrás do IAP: use polling até ter um."]
                    : []),
            ],
        };
    }
    const whatsapp = config as ChannelConfig["whatsapp"];
    return {
        kind,
        steps: [
            { title: "Criar o app na Meta", detail: "No App Dashboard da Meta, crie um app com o caso de uso 'Connect with customers through WhatsApp' e ligue ao portfólio da empresa." },
            { title: "Pegar os identificadores", detail: `Em WhatsApp > API Setup, anote o WABA ID e o Phone number ID do número que termina em ${whatsapp.phone_last4}.` },
            { title: "Gerar o token permanente", detail: "Em Business Settings > System users, crie um usuário de sistema, dê acesso ao app e à conta e gere um token sem validade com whatsapp_business_messaging e whatsapp_business_management." },
            { title: "Guardar no cofre", detail: "O token, o App Secret e o verify token vão para o cofre do deploy, nunca para o Mike nem para o chat." },
            { title: "Configurar o webhook", detail: "Em WhatsApp > Configuration, informe o endereço público e o verify token, e assine o campo messages." },
            { title: "Aprovar os modelos de mensagem", detail: "Fora da janela de 24 horas o WhatsApp só aceita modelos aprovados. Envie para aprovação: lembrete_prazo, pedido_atualizado e info_pendente." },
        ],
        files: [
            {
                name: "webhook.txt",
                language: "text",
                content:
                    "Callback URL: https://<host público>/integrations/whatsapp/webhook\n" +
                    "Verify token: <segredo aleatório, guardado no cofre>\n" +
                    "Campos assinados: messages\n\n" +
                    "Verificação (GET): responder hub.challenge quando hub.mode=subscribe e hub.verify_token confere; senão 403.\n" +
                    "Eventos (POST): conferir X-Hub-Signature-256 = sha256=HMAC-SHA256(App Secret, corpo bruto) em tempo constante.\n",
            },
            {
                name: "modelos.txt",
                language: "text",
                content:
                    "lembrete_prazo (Utility): Olá {{1}}, o pedido {{2}} vence em {{3}}. Responda para continuar.\n" +
                    "pedido_atualizado (Utility): Olá {{1}}, o pedido {{2}} mudou para {{3}}. Veja no Mike: {{4}}\n" +
                    "info_pendente (Utility): Olá {{1}}, o Legal precisa de uma informação para seguir com o pedido {{2}}. Responda esta mensagem.\n",
            },
            { name: "config.yaml (trecho)", language: "yaml", content: hermesMcpSnippet(mcpUrl, "whatsapp") },
        ],
        warnings: [
            "O WhatsApp exige um endereço HTTPS público para o webhook. O staging fica atrás do IAP: aqui o canal só roda com mensagens simuladas.",
            "Use a API oficial da Meta. Provedores não oficiais violam os termos do WhatsApp e arriscam o bloqueio do número.",
        ],
    };
}

function slackHermesSnippet(config: ChannelConfig["slack"], mcpUrl: string): string {
    return (
        hermesMcpSnippet(mcpUrl, "slack") +
        stringify({
            slack: {
                require_mention: true,
                // Channel names; Hermes takes ids, so swap them after inviting the bot.
                allowed_channels: config.channels.map((c) => `<id de #${c}>`),
            },
        })
    );
}
