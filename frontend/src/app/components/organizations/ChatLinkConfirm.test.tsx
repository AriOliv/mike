import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ params: new URLSearchParams("t=abc") }));
vi.mock("next/navigation", () => ({ useSearchParams: () => nav.params, usePathname: () => "/vincular-chat" }));
vi.mock("@/app/contexts/PageChromeContext", () => ({ usePageChrome: () => ({ mobileActionsContainer: null }) }));
const api = vi.hoisted(() => ({ previewChatLink: vi.fn(), confirmChatLink: vi.fn() }));
vi.mock("@/app/lib/mikeApi", async (actual) => ({ ...(await actual<typeof import("@/app/lib/mikeApi")>()), ...api }));

import { ChatLinkConfirm } from "./ChatLinkConfirm";

beforeEach(() => {
    vi.clearAllMocks();
    nav.params = new URLSearchParams("t=abc");
});

describe("ChatLinkConfirm", () => {
    it("says what will be linked and links it for the logged-in person", async () => {
        api.previewChatLink.mockResolvedValue({ platform: "slack", org_name: "Avenia", email: "duda@avenia.io" });
        api.confirmChatLink.mockResolvedValue({ link: {} });
        render(<ChatLinkConfirm />);
        expect(await screen.findByText("Ligar sua conta do Slack")).toBeInTheDocument();
        expect(screen.getByText(/Avenia vai falar com você no Slack como duda@avenia.io/)).toBeInTheDocument();
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sou eu, ligar a conta" })));
        expect(api.previewChatLink).toHaveBeenCalledWith("abc");
        expect(api.confirmChatLink).toHaveBeenCalledWith("abc");
        expect(screen.getByText("Conta ligada")).toBeInTheDocument();
        expect(screen.getByText(/como duda@avenia.io/)).toBeInTheDocument();
    });

    it("falls back to neutral words when there is no e-mail", async () => {
        api.previewChatLink.mockResolvedValue({ platform: "telegram", org_name: "Avenia", email: null });
        api.confirmChatLink.mockResolvedValue({ link: {} });
        render(<ChatLinkConfirm />);
        expect(await screen.findByText(/como sua conta do Mike/)).toBeInTheDocument();
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sou eu, ligar a conta" })));
        expect(screen.getByText(/como você/)).toBeInTheDocument();
    });

    it("explains an incomplete, expired or refused link", async () => {
        nav.params = new URLSearchParams();
        const { unmount } = render(<ChatLinkConfirm />);
        expect(screen.getByText(/Este link está incompleto/)).toBeInTheDocument();
        expect(api.previewChatLink).not.toHaveBeenCalled();
        unmount();

        nav.params = new URLSearchParams("t=abc");
        api.previewChatLink.mockRejectedValueOnce(new Error("boom"));
        render(<ChatLinkConfirm />);
        expect(await screen.findByText("Não deu para ligar a conta")).toBeInTheDocument();
    });

    it("explains a refused confirmation", async () => {
        api.previewChatLink.mockResolvedValue({ platform: "slack", org_name: "Avenia", email: "a@b.io" });
        api.confirmChatLink.mockRejectedValue(new Error("boom"));
        render(<ChatLinkConfirm />);
        const button = await screen.findByRole("button", { name: "Sou eu, ligar a conta" });
        await act(async () => fireEvent.click(button));
        await waitFor(() => expect(screen.getByText("Não deu para ligar a conta")).toBeInTheDocument());
    });
});
