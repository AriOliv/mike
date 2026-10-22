import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MikeApiError, createMcpToken, getRequestRole, listMcpTokens, revokeMcpToken, type McpAccessToken } from "@/app/lib/mikeApi";
import { needsMfaVerification } from "@/app/components/popups/MfaVerificationPopup";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/lib/mikeApi")>();
    return { ...actual, listMcpTokens: vi.fn(), createMcpToken: vi.fn(), revokeMcpToken: vi.fn(), getRequestRole: vi.fn() };
});
const mfa = vi.hoisted(() => ({ onVerified: null as null | (() => void), open: false }));
vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
    MfaVerificationPopup: (p: { open: boolean; onVerified: () => void }) => {
        mfa.open = p.open;
        mfa.onVerified = p.onVerified;
        return p.open ? <div role="dialog" aria-label="Código de verificação" /> : null;
    },
    needsMfaVerification: vi.fn(),
}));
const ws = vi.hoisted(() => ({ workspaceId: "personal" as string | null }));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
    useWorkspace: () => ({ workspaceId: ws.workspaceId, organizations: [{ id: "org-1", name: "Legal Avenia", role: "member", kind: "team" }] }),
}));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("@/app/components/ui/toast", () => toast);
const errors = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock("@/app/lib/userFacingError", async (orig) => ({ ...(await orig<object>()), notifyError: errors.notifyError }));

import AgentTokensPage from "./page";

const DAY = 86_400_000;
const token = (over: Partial<McpAccessToken> = {}): McpAccessToken => ({
    id: "t1",
    name: "Claude Code do notebook",
    kind: "pessoal",
    workspace: "org-1",
    prefix: "mike_pat_Ab12…",
    scopes: ["contratos:read", "prazos:read"],
    expires_at: new Date(Date.now() + 30 * DAY).toISOString(),
    revoked_at: null,
    last_used_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    last_client: "claude-code",
    created_at: "2026-10-21T12:00:00Z",
    ...over,
});

async function renderPage() {
    await act(async () => {
        render(<AgentTokensPage />);
    });
}

beforeEach(() => {
    vi.mocked(listMcpTokens).mockReset();
    vi.mocked(createMcpToken).mockReset();
    vi.mocked(revokeMcpToken).mockReset();
    vi.mocked(getRequestRole).mockReset().mockResolvedValue({ configured: true, role: "head", area: null, areas: [] });
    vi.mocked(needsMfaVerification).mockReset().mockResolvedValue(false);
    push.mockReset();
    ws.workspaceId = "personal";
    toast.showToast.mockReset();
    errors.notifyError.mockReset();
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
});
afterEach(cleanup);

describe("Tokens de acesso para agentes", () => {
    it("lists each token with its workspace, last use, validity and permissions, revoked ones last and without Revogar", async () => {
        vi.mocked(listMcpTokens).mockResolvedValue([
            token({ id: "old", name: "Codex antigo", revoked_at: "2026-10-01T12:00:00Z", workspace: "personal", last_used_at: null, last_client: null }),
            token(),
        ]);
        await renderPage();
        const items = within(screen.getByRole("list", { name: "Tokens de acesso" })).getAllByRole("listitem");
        expect(items.map((i) => i.textContent?.slice(0, 22))).toEqual(["Claude Code do noteboo", "Codex antigoRevogadomi"]);
        expect(items[0].textContent).toContain("Legal Avenia");
        expect(items[0].textContent).toContain("Usado há 5 min pelo Claude Code");
        expect(items[0].textContent).toContain("Expira em 29 dias");
        expect(items[0].textContent).toContain("Ler contratos · Ver prazos");
        expect(items[0].textContent).not.toContain("todas as permissões");
        expect(within(items[0]).getByRole("button", { name: "Revogar Claude Code do notebook" })).toBeTruthy();
        // Inactive is neutral grey, never the red of a failure.
        const revoked = within(items[1]).getByText("Revogado");
        expect(revoked.className).toContain("text-gray-400");
        expect(revoked.className).not.toMatch(/red/);
        expect(items[1].textContent).toContain("Pessoal");
        expect(items[1].textContent).toContain("Nunca usado");
        expect(within(items[1]).queryByRole("button")).toBeNull();
    });

    it("lists an app the person connected, and disconnects it", async () => {
        vi.mocked(listMcpTokens).mockResolvedValue([token({ id: "app", kind: "aplicativo", name: "Claude", prefix: "mike_ort_x…", last_client: "claude-ai" })]);
        vi.mocked(revokeMcpToken).mockResolvedValue(token({ id: "app", kind: "aplicativo", name: "Claude", revoked_at: new Date().toISOString() }));
        await renderPage();
        const item = within(screen.getByRole("list", { name: "Tokens de acesso" })).getByRole("listitem");
        expect(item.textContent).toContain("Aplicativo conectado");
        expect(item.textContent).not.toContain("mike_ort_");
        fireEvent.click(within(item).getByRole("button", { name: "Desconectar Claude" }));
        expect(screen.getByText(/conecte de novo pelo próprio aplicativo/)).toBeTruthy();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Desconectar" }));
        });
        expect(revokeMcpToken).toHaveBeenCalledWith("app");
    });

    it("shows skeleton lines while loading, then an empty state with a way to start", async () => {
        let resolve!: (v: McpAccessToken[]) => void;
        vi.mocked(listMcpTokens).mockReturnValue(new Promise((r) => (resolve = r)));
        await renderPage();
        expect(screen.getByLabelText("Carregando tokens").getAttribute("aria-busy")).toBe("true");
        await act(async () => resolve([]));
        expect(screen.getByText("Nenhum token ainda")).toBeTruthy();
    });

    it("creates a read-only token in the chosen workspace and shows it once, with the client setup", async () => {
        vi.mocked(listMcpTokens).mockResolvedValue([]);
        vi.mocked(createMcpToken).mockResolvedValue({ token: "mike_pat_SEGREDO", access_token: token({ id: "t2", name: "Claude Code" }) });
        await renderPage();
        fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
        fireEvent.change(screen.getByPlaceholderText("Ex.: Claude Code do notebook"), { target: { value: "  Claude Code  " } });
        fireEvent.change(screen.getByLabelText("Espaço"), { target: { value: "org-1" } });
        fireEvent.click(screen.getByLabelText(/Ver o Painel do Legal/));
        await act(async () => {
            fireEvent.click(screen.getAllByRole("button", { name: "Criar token" }).at(-1)!);
        });

        expect(createMcpToken).toHaveBeenCalledWith({
            name: "Claude Code",
            workspace: "org-1",
            scopes: ["contratos:read", "prazos:read", "base:ask", "revisao:read", "controle:read", "radar:read", "pedidos:read"],
            expires_in_days: 30,
        });
        expect(screen.getByText(/não aparece de novo/)).toBeTruthy();
        expect(screen.getAllByText("mike_pat_SEGREDO").length).toBe(1);
        expect(screen.getByText(/claude mcp add --transport http mike .*\/mcp --header "Authorization: Bearer mike_pat_SEGREDO"/)).toBeTruthy();
        expect(screen.getByText(/bearer_token_env_var = "MIKE_TOKEN"/)).toBeTruthy();

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Copiar Token" }));
        });
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith("mike_pat_SEGREDO");

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Já guardei o token" }));
        });
        // Gone from the screen for good; the list shows it by prefix only.
        expect(screen.queryByText(/mike_pat_SEGREDO/)).toBeNull();
        expect(screen.getByText("Claude Code")).toBeTruthy();
    });

    it("never loses the token silently: closing the modal asks first", async () => {
        vi.mocked(listMcpTokens).mockResolvedValue([]);
        vi.mocked(createMcpToken).mockResolvedValue({ token: "mike_pat_SEGREDO", access_token: token() });
        await renderPage();
        fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
        fireEvent.change(screen.getByPlaceholderText("Ex.: Claude Code do notebook"), { target: { value: "Codex" } });
        await act(async () => {
            fireEvent.click(screen.getAllByRole("button", { name: "Criar token" }).at(-1)!);
        });
        fireEvent.keyDown(document, { key: "Escape" });
        expect(screen.getByText("Fechar sem copiar?")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Voltar e copiar" }));
        expect(screen.getAllByText("mike_pat_SEGREDO").length).toBe(1);
        fireEvent.keyDown(document, { key: "Escape" });
        fireEvent.click(screen.getByRole("button", { name: "Fechar mesmo assim" }));
        expect(screen.queryByText(/mike_pat_SEGREDO/)).toBeNull();
    });

    it("says so when the browser will not copy", async () => {
        Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) } });
        vi.mocked(listMcpTokens).mockResolvedValue([]);
        vi.mocked(createMcpToken).mockResolvedValue({ token: "mike_pat_X", access_token: token() });
        await renderPage();
        fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
        fireEvent.change(screen.getByPlaceholderText("Ex.: Claude Code do notebook"), { target: { value: "Codex" } });
        await act(async () => {
            fireEvent.click(screen.getAllByRole("button", { name: "Criar token" }).at(-1)!);
        });
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Copiar Token" }));
        });
        expect(toast.showToast).toHaveBeenCalledWith({ tone: "error", message: "Não consegui copiar. Selecione o texto e copie à mão." });
    });

    it("starts in the space the person is working in", async () => {
        vi.mocked(listMcpTokens).mockResolvedValue([]);
        ws.workspaceId = "org-1";
        await renderPage();
        fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
        expect((screen.getByLabelText("Espaço") as HTMLSelectElement).value).toBe("org-1");
        cleanup();
        ws.workspaceId = "org-desconhecida";
        await renderPage();
        fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
        expect((screen.getByLabelText("Espaço") as HTMLSelectElement).value).toBe("personal");
    });

    it("offers the Painel only to the head of Legal", async () => {
        vi.mocked(listMcpTokens).mockResolvedValue([]);
        vi.mocked(getRequestRole).mockResolvedValue({ configured: true, role: "team", area: null, areas: [] });
        await renderPage();
        fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
        expect(screen.queryByLabelText(/Ver o Painel do Legal/)).toBeNull();
        expect(screen.getByLabelText(/Ler contratos/)).toBeTruthy();
    });

    it("asks for the second factor before creating, and creates once it is verified", async () => {
        vi.mocked(listMcpTokens).mockResolvedValue([]);
        vi.mocked(needsMfaVerification).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        vi.mocked(createMcpToken).mockResolvedValue({ token: "mike_pat_X", access_token: token() });
        await renderPage();
        fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
        fireEvent.change(screen.getByPlaceholderText("Ex.: Claude Code do notebook"), { target: { value: "Codex" } });
        await act(async () => {
            fireEvent.click(screen.getAllByRole("button", { name: "Criar token" }).at(-1)!);
        });
        expect(screen.getByRole("dialog", { name: "Código de verificação" })).toBeTruthy();
        expect(createMcpToken).not.toHaveBeenCalled();
        await act(async () => {
            mfa.onVerified!();
        });
        expect(createMcpToken).toHaveBeenCalledTimes(1);

        // The server can ask too (session older than the check).
        vi.mocked(createMcpToken).mockRejectedValueOnce(new MikeApiError({ message: "MFA verification required", status: 403, code: "mfa_verification_required" }));
        fireEvent.click(screen.getByRole("button", { name: "Já guardei o token" }));
        fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
        fireEvent.change(screen.getByPlaceholderText("Ex.: Claude Code do notebook"), { target: { value: "Outro" } });
        await act(async () => {
            fireEvent.click(screen.getAllByRole("button", { name: "Criar token" }).at(-1)!);
        });
        expect(mfa.open).toBe(true);
    });

    it("sends an account without a second factor to Segurança", async () => {
        vi.mocked(listMcpTokens).mockResolvedValue([]);
        vi.mocked(createMcpToken).mockRejectedValue(new MikeApiError({ message: "Ative a verificação…", status: 403, code: "mfa_enrollment_required" }));
        await renderPage();
        fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
        fireEvent.change(screen.getByPlaceholderText("Ex.: Claude Code do notebook"), { target: { value: "Codex" } });
        await act(async () => {
            fireEvent.click(screen.getAllByRole("button", { name: "Criar token" }).at(-1)!);
        });
        expect(screen.getByText("Ative a verificação em duas etapas")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Ir para Segurança" }));
        expect(push).toHaveBeenCalledWith("/settings/security");
        expect(errors.notifyError).not.toHaveBeenCalled();
    });

    it("will not create a token without a name or a permission", async () => {
        vi.mocked(listMcpTokens).mockResolvedValue([]);
        await renderPage();
        fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
        const submit = () => screen.getAllByRole("button", { name: "Criar token" }).at(-1)! as HTMLButtonElement;
        expect(submit().disabled).toBe(true);
        fireEvent.change(screen.getByPlaceholderText("Ex.: Claude Code do notebook"), { target: { value: "Codex" } });
        expect(submit().disabled).toBe(false);
        for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
        expect(submit().disabled).toBe(true);
        expect(screen.getByText("Escolha ao menos uma permissão.")).toBeTruthy();
    });

    it("revokes after confirming, and says the agent loses access", async () => {
        vi.mocked(listMcpTokens).mockResolvedValue([token()]);
        vi.mocked(revokeMcpToken).mockResolvedValue(token({ revoked_at: new Date().toISOString() }));
        await renderPage();
        fireEvent.click(screen.getByRole("button", { name: "Revogar Claude Code do notebook" }));
        expect(screen.getByText(/perde o acesso na próxima chamada/)).toBeTruthy();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Revogar" }));
        });
        expect(revokeMcpToken).toHaveBeenCalledWith("t1");
        expect(toast.showToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "success", message: expect.stringContaining("revogado") }));
        const item = within(screen.getByRole("list", { name: "Tokens de acesso" })).getByRole("listitem");
        expect(item.textContent).toContain("Revogado");
        expect(within(item).queryByRole("button")).toBeNull();
    });

    it("reports a failure to load or revoke in Portuguese", async () => {
        vi.mocked(listMcpTokens).mockRejectedValue(new Error("down"));
        await renderPage();
        expect(errors.notifyError).toHaveBeenCalledWith(expect.anything(), { lang: "pt", action: "carregar seus tokens" });
    });
});
