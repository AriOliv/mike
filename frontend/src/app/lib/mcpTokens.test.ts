import { describe, expect, it } from "vitest";
import {
    clientLabel,
    clientSetup,
    DEFAULT_SCOPES,
    lastUseLabel,
    mcpServerUrl,
    SCOPE_OPTIONS,
    scopesFor,
    scopesSummary,
    STATE_LABEL,
    TOOL_LABELS,
    tokenState,
    validityLabel,
} from "./mcpTokens";

const NOW = Date.parse("2026-10-21T15:00:00Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe("access token words", () => {
    it("offers only read permissions by default", () => {
        expect(DEFAULT_SCOPES).toEqual(SCOPE_OPTIONS.map((o) => o.scope));
        expect(SCOPE_OPTIONS.every((o) => o.readOnly)).toBe(true);
        expect(DEFAULT_SCOPES).not.toContain("pedidos:write");
    });

    it("tells active, soon to expire, expired and revoked apart", () => {
        expect(tokenState({ revoked_at: null, expires_at: iso(NOW + 30 * DAY) }, NOW)).toBe("ativo");
        expect(tokenState({ revoked_at: null, expires_at: iso(NOW + 3 * DAY) }, NOW)).toBe("expira_em_breve");
        expect(tokenState({ revoked_at: null, expires_at: iso(NOW - 1) }, NOW)).toBe("expirado");
        expect(tokenState({ revoked_at: iso(NOW - DAY), expires_at: iso(NOW + 30 * DAY) }, NOW)).toBe("revogado");
        expect(STATE_LABEL.expira_em_breve).toBe("Expira em breve");
    });

    it("says when and by which client a token was last used", () => {
        expect(lastUseLabel({ last_used_at: null, last_client: null }, NOW)).toBe("Nunca usado");
        expect(lastUseLabel({ last_used_at: iso(NOW - 5 * 60_000), last_client: "claude-code" }, NOW)).toBe("Usado há 5 min pelo Claude Code");
        expect(lastUseLabel({ last_used_at: iso(NOW - 5 * 60_000), last_client: "meu-bot" }, NOW)).toBe("Usado há 5 min pelo meu-bot");
        expect(lastUseLabel({ last_used_at: iso(NOW - 5 * 60_000), last_client: null }, NOW)).toBe("Usado há 5 min");
    });

    it("says how long a token has left, or when it stopped", () => {
        expect(validityLabel({ revoked_at: null, expires_at: iso(NOW + 12 * DAY + 60_000) }, NOW)).toBe("Expira em 12 dias");
        expect(validityLabel({ revoked_at: null, expires_at: iso(NOW + DAY + 60_000) }, NOW)).toBe("Expira amanhã");
        expect(validityLabel({ revoked_at: null, expires_at: iso(NOW + 3_600_000) }, NOW)).toBe("Expira hoje");
        expect(validityLabel({ revoked_at: null, expires_at: "2026-10-20T15:00:00Z" }, NOW)).toBe("Expirou em 20/10/2026");
        expect(validityLabel({ revoked_at: "2026-10-21T12:00:00Z", expires_at: iso(NOW + DAY) }, NOW)).toBe("Revogado em 21/10/2026");
    });

    it("points agents at /mcp on this site unless the deployment says otherwise", () => {
        expect(mcpServerUrl(undefined, "https://preview.exemplo.test/")).toBe("https://preview.exemplo.test/mcp");
        expect(mcpServerUrl("  ", "https://preview.exemplo.test")).toBe("https://preview.exemplo.test/mcp");
        expect(mcpServerUrl("https://mcp.exemplo.test/mcp/", "https://x")).toBe("https://mcp.exemplo.test/mcp");
    });

    it("writes the setup for Claude Code and Codex, the Codex token kept out of the config file", () => {
        const [claude, codex] = clientSetup("https://x.test/mcp", "mike_pat_abc");
        expect(claude).toEqual({
            label: "Claude Code",
            text: 'claude mcp add --transport http mike https://x.test/mcp --header "Authorization: Bearer mike_pat_abc"',
        });
        expect(codex.label).toBe("Codex (~/.codex/config.toml)");
        expect(codex.text.split("\n# no shell")[0]).not.toContain("mike_pat_abc");
        expect(codex.text).toContain('bearer_token_env_var = "MIKE_TOKEN"');
        expect(codex.text).toContain('export MIKE_TOKEN="mike_pat_abc"');
    });

    it("offers each role only the permissions it can use", () => {
        const scopes = (who: Parameters<typeof scopesFor>[0]) => scopesFor(who).map((o) => o.scope);
        expect(scopes({ configured: true, role: "head" })).toContain("painel:read");
        expect(scopes({ configured: true, role: "team" })).not.toContain("painel:read");
        expect(scopes({ configured: true, role: "team" })).toContain("contratos:read");
        expect(scopes({ configured: true, role: "requester" })).toEqual(["pedidos:read"]);
        // No Legal team configured, or role not known yet: the team's, as the menu.
        expect(scopes({ configured: false, role: "requester" })).toEqual(scopes({ configured: true, role: "team" }));
        expect(scopes(null)).toEqual(scopes({ configured: true, role: "team" }));
    });

    it("names clients and tools in the Legal team's words", () => {
        expect(clientLabel("Codex")).toBe("Codex");
        expect(clientLabel("hermes-docbot")).toBe("Hermes");
        expect(clientLabel("outro")).toBe("outro");
        expect(TOOL_LABELS.mike_contratos_ficha).toBe("leu a Ficha de um contrato");
    });

    it("says 'all permissions' in one phrase instead of repeating eight", () => {
        const team = scopesFor({ configured: true, role: "team" });
        expect(scopesSummary(team.map((o) => o.scope), team)).toBe("Só leitura · todas as permissões");
        // A head's token that skipped the Painel lists what it has.
        const head = scopesFor({ configured: true, role: "head" });
        expect(scopesSummary(["prazos:read", "contratos:read"], head)).toBe("Ler contratos · Ver prazos");
        expect(scopesSummary([], [])).toBe("");
    });
});
