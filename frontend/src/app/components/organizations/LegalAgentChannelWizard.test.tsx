import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LegalAgentChannel } from "@/app/lib/mikeApi";

const api = vi.hoisted(() => ({ saveLegalAgentChannel: vi.fn() }));
vi.mock("@/app/lib/mikeApi", async (actual) => ({ ...(await actual<typeof import("@/app/lib/mikeApi")>()), ...api }));

import { LegalAgentChannelWizard } from "./LegalAgentChannelWizard";

const saved: LegalAgentChannel = {
    id: "c1",
    kind: "telegram",
    status: "rascunho",
    name: "Bot do Legal",
    platform_team_id: null,
    config: { bot_username: "acme_juridico_bot", mode: "webhook" },
    created_at: "2026-10-21T00:00:00Z",
    updated_at: "2026-10-21T00:00:00Z",
};
const setup = {
    kind: "telegram" as const,
    steps: [{ title: "Criar o bot", detail: "No Telegram, abra o @BotFather." }],
    files: [
        { name: "setWebhook.http", language: "http" as const, content: "POST https://api.telegram.org/bot<TOKEN>/setWebhook" },
        { name: "config.yaml (trecho)", language: "yaml" as const, content: "mcp_servers: {}" },
    ],
    warnings: ["Telegram só para demonstração e piloto."],
};

const writeText = vi.fn();
beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

describe("LegalAgentChannelWizard", () => {
    it("asks only for safe details, then shows the steps and files to copy", async () => {
        const onSaved = vi.fn();
        api.saveLegalAgentChannel.mockResolvedValue({ channel: saved, setup });
        writeText.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
        render(<LegalAgentChannelWizard orgId="org-1" channel={null} onClose={vi.fn()} onSaved={onSaved} />);
        expect(screen.getByText("Tokens e segredos ficam no cofre do deploy, nunca no Mike.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Gerar configuração" })).toBeDisabled();

        fireEvent.click(screen.getByRole("button", { name: "WhatsApp" }));
        expect(screen.getByText(/4 últimos dígitos/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Telegram" }));
        expect(screen.getByText(/Só para demonstração e piloto/)).toBeInTheDocument();
        fireEvent.change(screen.getByPlaceholderText("Telegram do Legal"), { target: { value: " Bot do Legal " } });
        fireEvent.change(screen.getByPlaceholderText("acme_juridico_bot"), { target: { value: "acme_juridico_bot" } });
        expect(screen.getByText("ID do bot no Telegram")).toBeInTheDocument();
        fireEvent.change(screen.getByPlaceholderText("7654321"), { target: { value: " 7654321 " } });
        const mode = screen.getByRole("group", { name: "Como recebe mensagens" });
        fireEvent.click(within(mode).getByRole("button", { name: "Webhook" }));
        fireEvent.click(within(mode).getByRole("button", { name: /Busca mensagens/ }));
        fireEvent.click(within(mode).getByRole("button", { name: "Webhook" }));
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Gerar configuração" })));

        expect(api.saveLegalAgentChannel).toHaveBeenCalledWith("org-1", {
            id: undefined,
            kind: "telegram",
            name: "Bot do Legal",
            config: { bot_username: "acme_juridico_bot", mode: "webhook" },
            platform_team_id: "7654321",
        });
        expect(onSaved).toHaveBeenCalledWith(saved);
        expect(await screen.findByText("Criar o bot")).toBeInTheDocument();
        expect(screen.getByText("Telegram só para demonstração e piloto.")).toBeInTheDocument();

        const file = screen.getByRole("region", { name: "setWebhook.http" });
        await act(async () => fireEvent.click(within(file).getByRole("button", { name: /Copiar/ })));
        expect(writeText).toHaveBeenCalledWith(setup.files[0].content);
        expect(within(file).getByRole("button", { name: /Copiado/ })).toBeInTheDocument();
        const snippet = screen.getByRole("region", { name: "config.yaml (trecho)" });
        await act(async () => fireEvent.click(within(snippet).getByRole("button", { name: /Copiar/ })));
        expect(screen.getByRole("alert")).toHaveTextContent("Não consegui copiar");

        fireEvent.click(screen.getByRole("button", { name: "Editar dados" }));
        expect(screen.getByDisplayValue("acme_juridico_bot")).toBeInTheDocument();
    });

    it("edits an existing channel without changing its kind, and says why a save failed", async () => {
        api.saveLegalAgentChannel.mockRejectedValue(Object.assign(new Error("x"), { status: 400, detail: "Não cole tokens nem segredos aqui." }));
        render(
            <LegalAgentChannelWizard
                orgId="org-1"
                channel={{ ...saved, kind: "slack", name: "Slack", config: { workspace: "Avenia", channels: ["juridico"] } }}
                onClose={vi.fn()}
                onSaved={vi.fn()}
            />,
        );
        expect(screen.getByRole("button", { name: "WhatsApp" })).toBeDisabled();
        expect(screen.getByDisplayValue("juridico")).toBeInTheDocument();
        expect(screen.getByText("Vazio: só mensagens diretas.")).toBeInTheDocument();
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Gerar configuração" })));
        await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
        expect(api.saveLegalAgentChannel).toHaveBeenCalledWith("org-1", expect.objectContaining({ id: "c1", kind: "slack" }));
    });

    it("opens straight on the files of a saved channel", () => {
        const onClose = vi.fn();
        render(<LegalAgentChannelWizard orgId="org-1" channel={saved} initialSetup={setup} onClose={onClose} onSaved={vi.fn()} />);
        expect(screen.getByText("Criar o bot")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
        expect(onClose).toHaveBeenCalled();
    });
});
