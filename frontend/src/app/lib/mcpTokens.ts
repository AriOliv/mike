// The words and rules behind Configurações → Tokens de acesso para agentes
// (doc 09 §3.1): what each permission means in the Legal team's words, a
// token's state, and the ready-to-paste client configuration.

import type { McpAccessToken, McpScope } from "./mikeApi";
import { relativeTime } from "./activityFeed";

/** Every permission, in the order the screen lists them, with what it lets an agent do. */
export const SCOPE_OPTIONS: readonly { scope: McpScope; label: string; hint: string; readOnly: boolean }[] = [
    { scope: "contratos:read", label: "Ler contratos", hint: "Carteira, Ficha com citações, texto e atividade", readOnly: true },
    { scope: "prazos:read", label: "Ver prazos", hint: "Avisos prévios e renovações", readOnly: true },
    { scope: "base:ask", label: "Perguntar à base", hint: "Respostas com citação dos contratos", readOnly: true },
    { scope: "revisao:read", label: "Ler revisões", hint: "Resultado das revisões por playbook", readOnly: true },
    { scope: "controle:read", label: "Ler o Controle de Contratos", hint: "Tabelas de análise", readOnly: true },
    { scope: "radar:read", label: "Ver o radar regulatório", hint: "Mudanças e contratos afetados", readOnly: true },
    { scope: "painel:read", label: "Ver o Painel do Legal", hint: "Só para a liderança do Legal", readOnly: true },
    { scope: "pedidos:read", label: "Ver pedidos", hint: "Os pedidos que você vê na tela", readOnly: true },
];

/** What a new token gets unless the person unticks it: reading only. */
export const DEFAULT_SCOPES: McpScope[] = SCOPE_OPTIONS.map((o) => o.scope);

export const VALIDITY_OPTIONS = [
    { days: 7, label: "7 dias" },
    { days: 30, label: "30 dias" },
    { days: 90, label: "90 dias" },
] as const;

const DAY = 86_400_000;

export type TokenState = "ativo" | "expira_em_breve" | "expirado" | "revogado";

export function tokenState(token: Pick<McpAccessToken, "revoked_at" | "expires_at">, now: number = Date.now()): TokenState {
    if (token.revoked_at) return "revogado";
    const left = Date.parse(token.expires_at) - now;
    if (left <= 0) return "expirado";
    return left <= 7 * DAY ? "expira_em_breve" : "ativo";
}

export const STATE_LABEL: Record<TokenState, string> = {
    ativo: "Ativo",
    expira_em_breve: "Expira em breve",
    expirado: "Expirado",
    revogado: "Revogado",
};

/** "Usado há 5 min pelo claude-code", or "Nunca usado". */
export function lastUseLabel(token: Pick<McpAccessToken, "last_used_at" | "last_client">, now: number = Date.now()): string {
    if (!token.last_used_at) return "Nunca usado";
    const when = relativeTime(token.last_used_at, now);
    return token.last_client ? `Usado ${when} pelo ${token.last_client}` : `Usado ${when}`;
}

/** "Expira em 12 dias", "Expira hoje", "Expirou em 20/10/2026" or "Revogado em 21/10/2026". */
export function validityLabel(token: Pick<McpAccessToken, "revoked_at" | "expires_at">, now: number = Date.now()): string {
    const date = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
    if (token.revoked_at) return `Revogado em ${date(token.revoked_at)}`;
    const left = Date.parse(token.expires_at) - now;
    if (left <= 0) return `Expirou em ${date(token.expires_at)}`;
    const days = Math.floor(left / DAY);
    if (days === 0) return "Expira hoje";
    return days === 1 ? "Expira amanhã" : `Expira em ${days} dias`;
}

/**
 * The public address agents connect to. /mcp is served by the backend at the
 * site's root, not through the /api proxy (doc 09 §9): NEXT_PUBLIC_MCP_URL
 * when a deployment puts it elsewhere, else this origin's /mcp.
 */
export function mcpServerUrl(configured: string | undefined, origin: string): string {
    const explicit = configured?.trim();
    return explicit ? explicit.replace(/\/+$/, "") : `${origin.replace(/\/+$/, "")}/mcp`;
}

/** Ready-to-run setup for the two clients the Legal team uses, with the token in it. */
export function clientSetup(url: string, token: string): { label: string; text: string }[] {
    return [
        {
            label: "Claude Code",
            text: `claude mcp add --transport http mike ${url} --header "Authorization: Bearer ${token}"`,
        },
        {
            // The token stays in an environment variable, not in the config file.
            label: "Codex (~/.codex/config.toml)",
            text: `[mcp_servers.mike]\nurl = "${url}"\nbearer_token_env_var = "MIKE_TOKEN"\n\n# no shell: export MIKE_TOKEN="${token}"`,
        },
    ];
}
