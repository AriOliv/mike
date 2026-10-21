import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listProjectsPage } from "@/app/lib/mikeApi";
import { loadNavRole } from "@/app/lib/navRole";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";
import { AppSidebar } from "./AppSidebar";

const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
    usePathname: () => "/assistant",
}));

vi.mock("next/image", () => ({
    default: () => <span aria-hidden="true" />,
}));

vi.mock("@/app/lib/mikeApi", () => ({
    listProjectsPage: vi.fn(),
}));

vi.mock("@/app/lib/navRole", () => ({
    loadNavRole: vi.fn(async () => null),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        user: { id: "sidebar-user", email: "alice@example.com" },
        signOut,
    }),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: { displayName: "Alice", tier: "Free" },
    }),
}));

vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        chats: [],
        loadingMoreChats: false,
        loadMoreChats: vi.fn(),
        setCurrentChatId: vi.fn(),
    }),
}));

vi.mock("@/app/components/chat/mike-icon", () => ({
    MikeIcon: () => <span aria-hidden="true" />,
}));

function renderSidebar() {
    return render(
        <>
            <AppSidebar isOpen onToggle={vi.fn()} />
            <ToastViewportUI />
        </>,
    );
}

describe("AppSidebar failures", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearToasts();
        vi.mocked(listProjectsPage).mockResolvedValue([]);
        signOut.mockResolvedValue(undefined);
    });

    afterEach(() => {
        clearToasts();
    });

    // The old catch emptied the section, so a failed request looked exactly
    // like an account with no projects.
    it("tells the user when recent projects cannot be loaded", async () => {
        vi.mocked(listProjectsPage).mockRejectedValue(new Error("boom"));

        renderSidebar();

        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                "Não consegui carregar seus projetos recentes",
            ),
        );
    });

    it("retries the recent projects load from the toast", async () => {
        const user = userEvent.setup();
        vi.mocked(listProjectsPage).mockRejectedValueOnce(
            new Error("boom"),
        );

        renderSidebar();

        await waitFor(() => screen.getByRole("alert"));
        await user.click(screen.getByRole("button", { name: "Tentar de novo" }));

        await waitFor(() =>
            expect(listProjectsPage).toHaveBeenCalledTimes(2),
        );
    });

    // A failed sign-out leaves the session live; signing out again is safe,
    // so the notice offers Retry rather than only "try again".
    it("reports a failed sign-out with a Retry", async () => {
        const user = userEvent.setup();
        signOut.mockRejectedValue(new TypeError("Failed to fetch"));

        renderSidebar();

        await user.click(screen.getByText("Alice").closest("button")!);
        await user.click(screen.getByRole("menuitem", { name: "Sign out" }));

        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                "Não consegui sair",
            ),
        );
        expect(
            screen.getByRole("button", { name: "Tentar de novo" }),
        ).toBeInTheDocument();
    });
});

describe("AppSidebar menu by role", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(listProjectsPage).mockResolvedValue([]);
    });

    it("shows the Legal team the whole menu", async () => {
        vi.mocked(loadNavRole).mockResolvedValue("team");
        renderSidebar();
        await waitFor(() => expect(loadNavRole).toHaveBeenCalled());
        expect(screen.getByText("Esteira")).toBeInTheDocument();
        expect(screen.getByText("Mais")).toBeInTheDocument();
        expect(screen.getByText("Projetos recentes")).toBeInTheDocument();
    });

    it("hides the team's workstation from someone who only asks the Legal team", async () => {
        vi.mocked(loadNavRole).mockResolvedValue("requester");
        renderSidebar();
        await waitFor(() => expect(screen.queryByText("Esteira")).not.toBeInTheDocument());
        expect(screen.queryByText("Mais")).not.toBeInTheDocument();
        expect(screen.queryByText("Projetos recentes")).not.toBeInTheDocument();
        expect(screen.queryByText("Histórico")).not.toBeInTheDocument();
    });
});
