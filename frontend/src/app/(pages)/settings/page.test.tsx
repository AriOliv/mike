import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MikeApiError } from "@/app/lib/mikeApi";
import SettingsPage from "./page";
import { deleteAccount } from "@/app/lib/mikeApi";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";

const state = vi.hoisted(() => ({
    push: vi.fn(),
    signOut: vi.fn(),
    deleteAccount: vi.fn(),
    updateEmail: vi.fn(),
    updateDisplayName: vi.fn(),
    updateOrganisation: vi.fn(),
    passwordSet: false,
    profile: {
        displayName: "Alex",
        organisation: "Example LLP",
    },
    user: {
        id: "user-1",
        email: "alex@example.com",
        pendingEmail: null,
        createdWithGoogle: true,
    },
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: state.push }),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        user: state.user,
        signOut: state.signOut,
        updateEmail: state.updateEmail,
    }),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: {
            ...state.profile,
            passwordSet: state.passwordSet,
            tier: "Free",
        },
        updateDisplayName: state.updateDisplayName,
        updateOrganisation: state.updateOrganisation,
    }),
}));

// The real module is spread back in because userFacingApiError resolves
// MikeApiError from it; a bare object mock leaves that `instanceof` check
// comparing against undefined.
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    deleteAccount: state.deleteAccount,
    isMfaRequiredError: vi.fn(() => false),
}));

vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
    MfaVerificationPopup: () => null,
    needsMfaVerification: vi.fn(async () => false),
}));

describe("SettingsPage Google email changes", () => {
    beforeEach(() => {
        state.push.mockReset();
        state.signOut.mockReset();
        state.deleteAccount.mockReset();
        state.deleteAccount.mockResolvedValue(undefined);
        state.updateEmail.mockReset();
        state.updateDisplayName.mockReset();
        state.updateDisplayName.mockResolvedValue(true);
        state.updateOrganisation.mockReset();
        state.updateOrganisation.mockResolvedValue(true);
        state.deleteAccount.mockReset();
        state.deleteAccount.mockResolvedValue(undefined);
        state.updateEmail.mockResolvedValue({
            ...state.user,
            email: "alex@example.com",
            pendingEmail: "new@example.com",
        });
        state.passwordSet = false;
        state.profile = {
            displayName: "Alex",
            organisation: "Example LLP",
        };
    });

    it("keeps onboarding organisation out of account settings and places the photo below the name", () => {
        render(<SettingsPage />);
        expect(screen.queryByLabelText("Organisation")).not.toBeInTheDocument();
        expect(screen.queryByDisplayValue("Example LLP")).not.toBeInTheDocument();
        const name = screen.getByLabelText("Nome de exibição");
        const photo = screen.getByText("Foto de perfil");
        expect(name.compareDocumentPosition(photo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // The backend's default plan name is English; the screen shows it in PT.
        expect(screen.getByText("Gratuito")).toBeInTheDocument();
        expect(state.updateOrganisation).not.toHaveBeenCalled();
    });

    it("directs Google-created accounts without a password to Security", async () => {
        const user = userEvent.setup();
        render(<SettingsPage />);

        const email = screen.getByPlaceholderText("Digite seu e-mail");
        expect(email).toBeDisabled();
        await user.click(
            screen.getByRole("button", { name: "Alterar" }),
        );

        const dialog = screen.getByRole("dialog", { name: "Trocar e-mail" });
        expect(dialog).toHaveTextContent(
            "Sua conta foi criada com o Google. Para trocar o e-mail, primeiro crie uma senha em Configurações > Segurança > Senha.",
        );
        expect(state.updateEmail).not.toHaveBeenCalled();

        await user.click(
            screen.getByRole("button", { name: "Ir para Segurança" }),
        );
        expect(state.push).toHaveBeenCalledWith("/settings/security");
    });

    it("allows the email change after a password has been added", async () => {
        state.passwordSet = true;
        const user = userEvent.setup();
        render(<SettingsPage />);

        const email = screen.getByPlaceholderText("Digite seu e-mail");
        await user.clear(email);
        await user.type(email, "new@example.com");
        const emailSection = screen.getByRole("heading", { name: "E-mail" })
            .parentElement!;
        await user.click(
            emailSection.querySelector<HTMLButtonElement>("button")!,
        );

        await waitFor(() =>
            expect(state.updateEmail).toHaveBeenCalledWith("new@example.com"),
        );
        expect(
            screen.queryByRole("dialog", { name: "Trocar e-mail" }),
        ).not.toBeInTheDocument();
    });

    it("auto-saves the name when it loses focus", async () => {
        const user = userEvent.setup();
        render(<SettingsPage />);

        const name = screen.getByPlaceholderText("Digite seu nome");
        await user.clear(name);
        await user.type(name, "Alex Chen");
        await user.tab();
        await waitFor(() =>
            expect(state.updateDisplayName).toHaveBeenCalledWith("Alex Chen"),
        );

        expect(state.updateOrganisation).not.toHaveBeenCalled();
    });

    it("reports a failed name save only through the notice", async () => {
        // updateDisplayName raises the notice itself; the field must not
        // repeat the failure inline.
        state.updateDisplayName.mockResolvedValue(false);
        const user = userEvent.setup();
        render(<SettingsPage />);

        const name = screen.getByPlaceholderText("Digite seu nome");
        await user.clear(name);
        await user.type(name, "Alex Chen");
        await user.tab();
        await waitFor(() =>
            expect(state.updateDisplayName).toHaveBeenCalledWith("Alex Chen"),
        );
        expect(screen.queryByText(/not saved/i)).not.toBeInTheDocument();
    });

    it("keeps the session and shows the reason when deletion is refused", async () => {
        const user = userEvent.setup();
        const detail =
            "You are the only owner of Elite Law LLP. Make another member an owner, or delete the organization, before deleting your account.";
        state.deleteAccount.mockRejectedValue(
            new MikeApiError({
                status: 409,
                code: "org_successor_required",
                message: detail,
            }),
        );
        render(<><SettingsPage /><ToastViewportUI /></>);

        await user.click(
            screen.getByRole("button", { name: "Excluir conta" }),
        );
        await user.click(screen.getByRole("button", { name: "Excluir" }));

        // The 409 detail names the blocking organization; a generic "Failed to
        // delete account" would leave the user with no way to unblock it.
        expect(await screen.findByText(detail)).toBeInTheDocument();
        expect(
            screen.getByText("Não consegui excluir sua conta"),
        ).toBeInTheDocument();
        expect(state.signOut).not.toHaveBeenCalled();
        expect(state.push).not.toHaveBeenCalled();
    });

    it("allows an existing display name to be cleared", async () => {
        const user = userEvent.setup();
        render(<SettingsPage />);

        const name = screen.getByPlaceholderText("Digite seu nome");
        await user.clear(name);
        await user.tab();

        await waitFor(() =>
            expect(state.updateDisplayName).toHaveBeenCalledWith(""),
        );
        expect(screen.queryByText("Name is required.")).not.toBeInTheDocument();
    });

    async function submitEmailChange(rejection: unknown) {
        state.passwordSet = true;
        state.updateEmail.mockRejectedValue(rejection);
        const user = userEvent.setup();
        render(<SettingsPage />);

        const email = screen.getByPlaceholderText("Digite seu e-mail");
        await user.clear(email);
        await user.type(email, "new@example.com");
        const emailSection = screen.getByRole("heading", { name: "E-mail" })
            .parentElement!;
        await user.click(
            emailSection.querySelector<HTMLButtonElement>("button")!,
        );
    }

    it("recognises a taken address by its code, not by its wording", async () => {
        // GoTrue reworded this message once already; the code is the contract.
        await submitEmailChange(
            Object.assign(new Error("Email address already in use"), {
                status: 422,
                code: "email_exists",
            }),
        );

        expect(
            await screen.findByText("Já existe uma conta com este e-mail."),
        ).toBeInTheDocument();
    });

    it("says the connection failed rather than blaming the address", async () => {
        await submitEmailChange(new TypeError("Failed to fetch"));

        expect(
            await screen.findByText(
                "Não consegui falar com o servidor. Confira a conexão e tente de novo.",
            ),
        ).toBeInTheDocument();
    });

    it("reports a refused account deletion in a toast, not an alert", async () => {
        const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        clearToasts();
        vi.mocked(deleteAccount).mockRejectedValue(
            Object.assign(new Error("boom"), { status: 500 }),
        );
        const user = userEvent.setup();
        render(
            <>
                <SettingsPage />
                <ToastViewportUI />
            </>,
        );

        await user.click(
            screen.getByRole("button", { name: "Excluir conta" }),
        );
        await user.click(screen.getByRole("button", { name: "Excluir" }));

        const toast = await screen.findByRole("alert");
        expect(toast).toHaveTextContent("Não consegui excluir sua conta");
        expect(toast).toHaveTextContent(
            "Algo deu errado do nosso lado. Tente de novo.",
        );
        expect(alertSpy).not.toHaveBeenCalled();
        expect(state.push).not.toHaveBeenCalled();
        clearToasts();
    });

    it("re-asks for confirmation when Retry follows a failed deletion", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        clearToasts();
        vi.mocked(deleteAccount).mockRejectedValue(
            Object.assign(new Error("boom"), { status: 500 }),
        );
        const user = userEvent.setup();
        render(
            <>
                <SettingsPage />
                <ToastViewportUI />
            </>,
        );

        await user.click(
            screen.getByRole("button", { name: "Excluir conta" }),
        );
        await user.click(screen.getByRole("button", { name: "Excluir" }));
        expect(deleteAccount).toHaveBeenCalledTimes(1);

        await user.click(await screen.findByRole("button", { name: "Tentar de novo" }));

        // Retry re-opens the confirmation instead of deleting outright.
        expect(deleteAccount).toHaveBeenCalledTimes(1);
        expect(await screen.findByText("Excluir conta?")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Excluir" }));
        expect(deleteAccount).toHaveBeenCalledTimes(2);
        clearToasts();
    });
});
