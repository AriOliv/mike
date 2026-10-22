import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MikeApiError, decideMcpAuthorization, getMcpAuthorization } from "@/app/lib/mikeApi";
import { needsMfaVerification } from "@/app/components/popups/MfaVerificationPopup";

vi.mock("@/app/lib/mikeApi", async (orig) => ({
    ...(await orig<typeof import("@/app/lib/mikeApi")>()),
    getMcpAuthorization: vi.fn(),
    decideMcpAuthorization: vi.fn(),
}));
const mfa = vi.hoisted(() => ({ onVerified: null as null | (() => void) }));
vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
    MfaVerificationPopup: (p: { open: boolean; onVerified: () => void }) => {
        mfa.onVerified = p.onVerified;
        return p.open ? <div role="dialog" aria-label="Código de verificação" /> : null;
    },
    needsMfaVerification: vi.fn(),
}));
const params = vi.hoisted(() => ({ pedido: "00000000-0000-4000-8000-000000000001" as string | null }));
vi.mock("next/navigation", () => ({ useSearchParams: () => ({ get: () => params.pedido }) }));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
    useWorkspace: () => ({ workspaceId: "org-1", organizations: [{ id: "org-1", name: "Legal Avenia", role: "member", kind: "team" }] }),
}));
vi.mock("@/app/components/shared/PageHeader", () => ({ PageHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header> }));

import { McpConsent, navigation } from "./McpConsent";

const request = {
    id: "00000000-0000-4000-8000-000000000001",
    client: { client_id: "mike_cli_x", client_name: "Claude", redirect_host: "claude.ai" },
    scopes: ["contratos:read", "prazos:read"] as const,
    expires_at: "2026-10-22T13:00:00Z",
};

async function renderConsent() {
    await act(async () => {
        render(<McpConsent />);
    });
}

beforeEach(() => {
    params.pedido = request.id;
    vi.mocked(getMcpAuthorization).mockReset().mockResolvedValue({ ...request, scopes: [...request.scopes] });
    vi.mocked(decideMcpAuthorization).mockReset().mockResolvedValue({ redirect: "https://claude.ai/api/mcp/auth_callback?code=mike_oac_x" });
    vi.mocked(needsMfaVerification).mockReset().mockResolvedValue(false);
    navigation.go = vi.fn();
});
afterEach(cleanup);

describe("Conectar um aplicativo", () => {
    it("says who asks, for what, and where the answer goes", async () => {
        await renderConsent();
        expect(screen.getByRole("heading", { name: "Claude quer acessar o Mike em seu nome" })).toBeTruthy();
        expect(screen.getByText("claude.ai")).toBeTruthy();
        const perms = screen.getByRole("list", { name: "Permissões pedidas" });
        expect(perms.textContent).toContain("Ler contratos");
        expect(perms.textContent).toContain("Ver prazos");
        expect((screen.getByLabelText("Espaço") as HTMLSelectElement).value).toBe("org-1");
    });

    it("allows in the chosen space and goes back to the app", async () => {
        await renderConsent();
        fireEvent.change(screen.getByLabelText("Espaço"), { target: { value: "personal" } });
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Permitir acesso" }));
        });
        expect(decideMcpAuthorization).toHaveBeenCalledWith({ pedido: request.id, aprovar: true, espaco: "personal" });
        expect(navigation.go).toHaveBeenCalledWith("https://claude.ai/api/mcp/auth_callback?code=mike_oac_x");
        expect(screen.getByText("Aplicativo conectado")).toBeTruthy();
    });

    it("refuses and tells the app", async () => {
        vi.mocked(decideMcpAuthorization).mockResolvedValue({ redirect: "https://claude.ai/cb?error=access_denied" });
        await renderConsent();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Recusar" }));
        });
        expect(decideMcpAuthorization).toHaveBeenCalledWith({ pedido: request.id, aprovar: false, espaco: undefined });
        expect(navigation.go).toHaveBeenCalledWith("https://claude.ai/cb?error=access_denied");
        expect(screen.getByText("Pedido recusado")).toBeTruthy();
    });

    it("asks for the second factor before allowing, and allows once verified", async () => {
        vi.mocked(needsMfaVerification).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        await renderConsent();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Permitir acesso" }));
        });
        expect(screen.getByRole("dialog", { name: "Código de verificação" })).toBeTruthy();
        expect(decideMcpAuthorization).not.toHaveBeenCalled();
        await act(async () => {
            mfa.onVerified!();
        });
        expect(decideMcpAuthorization).toHaveBeenCalledTimes(1);

        vi.mocked(decideMcpAuthorization).mockReset().mockRejectedValue(new MikeApiError({ message: "MFA", status: 403, code: "mfa_verification_required" }));
        cleanup();
        await renderConsent();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Permitir acesso" }));
        });
        expect(screen.getByRole("dialog", { name: "Código de verificação" })).toBeTruthy();
    });

    it("explains an expired or incomplete request in Portuguese", async () => {
        vi.mocked(getMcpAuthorization).mockRejectedValue(new MikeApiError({ message: "Pedido de acesso não encontrado ou expirado.", status: 404 }));
        await renderConsent();
        expect(screen.getByText("Não deu para conectar")).toBeTruthy();
        cleanup();
        params.pedido = null;
        await renderConsent();
        expect(screen.getByText(/Este pedido está incompleto/)).toBeTruthy();
        expect(getMcpAuthorization).toHaveBeenCalledTimes(1);
    });
});
