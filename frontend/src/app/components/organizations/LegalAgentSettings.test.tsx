import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LegalAgentChannel, LegalAgentView } from "@/app/lib/mikeApi";

const api = vi.hoisted(() => ({
    getLegalAgent: vi.fn(),
    saveLegalAgentSettings: vi.fn(),
    saveLegalAgentChannel: vi.fn(),
    getLegalAgentChannelSetup: vi.fn(),
    setLegalAgentChannelStatus: vi.fn(),
    deleteLegalAgentChannel: vi.fn(),
}));
vi.mock("@/app/lib/mikeApi", async (actual) => ({ ...(await actual<typeof import("@/app/lib/mikeApi")>()), ...api }));
vi.mock("./OrganizationSettingsShell", () => ({ useOrganizationSettings: () => ({ orgId: "org-1" }) }));
const toasts = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("@/app/components/ui/toast", async (actual) => ({ ...(await actual<typeof import("@/app/components/ui/toast")>()), ...toasts }));
const errors = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock("@/app/lib/userFacingError", async (actual) => ({
    ...(await actual<typeof import("@/app/lib/userFacingError")>()),
    ...errors,
}));

import { LegalAgentSettings } from "./LegalAgentSettings";

const channel = (over: Partial<LegalAgentChannel> = {}): LegalAgentChannel => ({
    id: "c1",
    kind: "slack",
    status: "rascunho",
    name: "Slack da Avenia",
    config: { workspace: "Avenia", channels: ["juridico"], bot_name: "advogado-mike" },
    created_at: "2026-10-21T00:00:00Z",
    updated_at: "2026-10-21T00:00:00Z",
    ...over,
});

function view(over: Partial<LegalAgentView> = {}): LegalAgentView {
    return {
        settings: {
            enabled: false,
            display_name: "Assistente do Legal",
            persona: "Sou o assistente do Legal.",
            tone: "cordial",
            hours: { timezone: "America/Sao_Paulo", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00", outside: "avisa_e_registra" },
            permissions: [],
            escalation: { risk_levels: ["alto", "critico"], kinds: ["parecer"], low_confidence: true, escalate_to_email: "" },
            proactive: { deadline_days: [30, 15, 7], renewals: true, radar: true, digest_time: "08:00" },
            updated_at: null,
        },
        channels: [],
        can_manage: true,
        options: {
            tones: ["formal", "cordial", "direto"],
            kinds: ["contrato_novo", "revisao", "aditivo", "nda", "parecer", "outro"],
            risk_levels: ["baixo", "medio", "alto", "critico"],
            fixed_escalations: ["Assinar ou aprovar a assinatura de qualquer documento", "Aceitar um risco em nome do Legal"],
            disclaimer: "Resposta de IA, não é parecer jurídico. Para revisão do Legal, peça aqui.",
        },
        ...over,
    };
}

const setup = {
    kind: "slack" as const,
    steps: [{ title: "Criar o app", detail: "Em api.slack.com/apps…" }],
    files: [{ name: "slack_app_manifest.yaml", language: "yaml" as const, content: "_metadata: {}\n" }],
    warnings: ["App criado por manifest serve para uso interno."],
};

beforeEach(() => {
    vi.clearAllMocks();
});

describe("LegalAgentSettings", () => {
    it("lets an admin set persona, tone, hours, permissions, escalation and warnings, and saves the whole form", async () => {
        api.getLegalAgent.mockResolvedValue(view());
        api.saveLegalAgentSettings.mockImplementation(async (_org, body) => ({ ...body, updated_at: "2026-10-21T02:00:00Z" }));
        render(<LegalAgentSettings />);
        expect(await screen.findByRole("heading", { name: "Agente do Legal" })).toBeInTheDocument();
        expect(screen.getByText(/Resposta de IA, não é parecer jurídico/)).toBeInTheDocument();
        expect(screen.getByText("Aceitar um risco em nome do Legal")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("switch", { name: "Agente ligado" }));
        fireEvent.change(screen.getByDisplayValue("Assistente do Legal"), { target: { value: "Assistente do Jurídico" } });
        fireEvent.change(screen.getByDisplayValue("Sou o assistente do Legal."), { target: { value: "Outra persona" } });
        fireEvent.click(within(screen.getByRole("group", { name: "Tom" })).getByRole("button", { name: "Direto" }));
        expect(screen.getByText("Frases curtas, vai ao ponto.")).toBeInTheDocument();
        fireEvent.click(within(screen.getByRole("group", { name: "Dias de atendimento" })).getByRole("button", { name: "Sáb" }));
        fireEvent.change(screen.getByLabelText("Início"), { target: { value: "08:00" } });
        fireEvent.change(screen.getByLabelText("Fim"), { target: { value: "19:00" } });
        fireEvent.click(screen.getByRole("button", { name: "Só registra" }));
        fireEvent.click(screen.getByRole("button", { name: /Fora do horário: avisa/ }));
        fireEvent.click(screen.getByRole("button", { name: "Só registra" }));

        const area = screen.getByLabelText("Nova área");
        fireEvent.change(area, { target: { value: "Comercial" } });
        fireEvent.keyDown(area, { key: "Enter" });
        fireEvent.change(area, { target: { value: "comercial" } });
        fireEvent.click(screen.getByRole("button", { name: /Adicionar área/ }));
        fireEvent.keyDown(area, { key: "a" });
        fireEvent.change(area, { target: { value: "Produto" } });
        fireEvent.click(screen.getByRole("button", { name: /Adicionar área/ }));
        fireEvent.click(within(screen.getByRole("group", { name: "Pedidos de Comercial" })).getByRole("button", { name: "NDA" }));
        fireEvent.click(screen.getByRole("button", { name: "Remover a área Produto" }));

        fireEvent.click(within(screen.getByRole("group", { name: "Riscos que escalam" })).getByRole("button", { name: "Médio" }));
        fireEvent.click(within(screen.getByRole("group", { name: "Pedidos que escalam" })).getByRole("button", { name: "Aditivo" }));
        fireEvent.click(screen.getByRole("switch", { name: "Quando não tiver certeza da resposta" }));
        fireEvent.change(screen.getByPlaceholderText(/fila do Legal/), { target: { value: "head@avenia.io" } });

        const deadlines = screen.getByDisplayValue("30, 15, 7");
        fireEvent.change(deadlines, { target: { value: "0" } });
        expect(screen.getByText("Use números de 1 a 180, separados por vírgula.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
        fireEvent.change(deadlines, { target: { value: "7, 30" } });
        fireEvent.click(screen.getByRole("switch", { name: "Renovações automáticas" }));
        fireEvent.click(screen.getByRole("switch", { name: "Mudanças do radar regulatório" }));
        fireEvent.change(screen.getByLabelText("Resumo diário"), { target: { value: "07:30" } });

        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        await waitFor(() => expect(api.saveLegalAgentSettings).toHaveBeenCalled());
        expect(api.saveLegalAgentSettings).toHaveBeenCalledWith("org-1", {
            enabled: true,
            display_name: "Assistente do Jurídico",
            persona: "Outra persona",
            tone: "direto",
            hours: { timezone: "America/Sao_Paulo", days: [1, 2, 3, 4, 5, 6], start: "08:00", end: "19:00", outside: "so_registra" },
            permissions: [{ area: "Comercial", kinds: ["nda"] }],
            escalation: { risk_levels: ["alto", "critico", "medio"], kinds: ["parecer", "aditivo"], low_confidence: false, escalate_to_email: "head@avenia.io" },
            proactive: { deadline_days: [30, 7], renewals: false, radar: false, digest_time: "07:30" },
        });
        await waitFor(() => expect(toasts.showToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "success" })));
        expect(screen.getByDisplayValue("30, 7")).toBeInTheDocument();
    });

    it("tells a failed save and keeps the form", async () => {
        api.getLegalAgent.mockResolvedValue(view());
        api.saveLegalAgentSettings.mockRejectedValue(new Error("boom"));
        render(<LegalAgentSettings />);
        fireEvent.click(await screen.findByRole("button", { name: "Salvar" }));
        await waitFor(() => expect(errors.notifyError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ action: "salvar o agente do Legal" })));
        expect(screen.getByRole("button", { name: "Salvar" })).not.toBeDisabled();
    });

    it("shows a member what the agent does, read-only", async () => {
        api.getLegalAgent.mockResolvedValue(
            view({ can_manage: false, channels: [channel()], settings: { ...view().settings, permissions: [{ area: "Comercial", kinds: ["nda"] }] } }),
        );
        render(<LegalAgentSettings />);
        expect(await screen.findByText(/Só quem administra a organização/)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Salvar" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Conectar canal/ })).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Nova área")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Remover a área Comercial" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Ver instalação" })).not.toBeInTheDocument();
        expect(screen.getByRole("switch", { name: "Agente ligado" })).toBeDisabled();
        expect(screen.getByText("Slack da Avenia")).toBeInTheDocument();
    });

    it("offers a retry when it cannot load", async () => {
        api.getLegalAgent.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(view());
        render(<LegalAgentSettings />);
        expect(await screen.findByText("Não consegui carregar o agente do Legal")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
        expect(await screen.findByRole("heading", { name: "Agente do Legal" })).toBeInTheDocument();
    });

    it("manages channels: setup, installed, paused and removed", async () => {
        api.getLegalAgent.mockResolvedValue(view({ channels: [channel(), channel({ id: "c2", name: "Telegram", kind: "telegram", status: "configurado", created_at: "2026-10-21T01:00:00Z" })] }));
        api.getLegalAgentChannelSetup.mockResolvedValueOnce(setup).mockRejectedValueOnce(new Error("x"));
        api.setLegalAgentChannelStatus
            .mockResolvedValueOnce(channel({ status: "configurado" }))
            .mockResolvedValueOnce(channel({ id: "c2", name: "Telegram", kind: "telegram", status: "pausado", created_at: "2026-10-21T01:00:00Z" }))
            .mockRejectedValueOnce(new Error("x"));
        api.deleteLegalAgentChannel.mockResolvedValueOnce({ deleted: true }).mockRejectedValueOnce(new Error("x"));
        render(<LegalAgentSettings />);
        await screen.findByText("Slack da Avenia");
        expect(screen.getByText("Rascunho")).toBeInTheDocument();
        expect(screen.getByText("Instalado")).toBeInTheDocument();

        fireEvent.click(screen.getAllByRole("button", { name: "Ver instalação" })[0]);
        expect(await screen.findByRole("dialog", { name: "Conectar canal" })).toBeInTheDocument();
        expect(screen.getByText("Criar o app")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
        fireEvent.click(screen.getAllByRole("button", { name: "Ver instalação" })[0]);
        await waitFor(() => expect(errors.notifyError).toHaveBeenCalledTimes(1));

        fireEvent.click(screen.getByRole("button", { name: "Marcar como instalado" }));
        await waitFor(() => expect(screen.getAllByText("Instalado")).toHaveLength(2));
        fireEvent.click(screen.getAllByRole("button", { name: "Pausar" })[1]);
        await waitFor(() => expect(screen.getByText("Pausado")).toBeInTheDocument());
        fireEvent.click(screen.getAllByRole("button", { name: "Pausar" })[0]);
        await waitFor(() => expect(errors.notifyError).toHaveBeenCalledTimes(2));

        fireEvent.click(screen.getByRole("button", { name: "Remover Telegram" }));
        await waitFor(() => expect(screen.queryByText("Telegram", { selector: "p" })).not.toBeInTheDocument());
        fireEvent.click(screen.getByRole("button", { name: "Remover Slack da Avenia" }));
        await waitFor(() => expect(errors.notifyError).toHaveBeenCalledTimes(3));
    });

    it("connects a new channel through the assistant and lists it", async () => {
        api.getLegalAgent.mockResolvedValue(view());
        api.saveLegalAgentChannel.mockResolvedValue({ channel: channel(), setup });
        render(<LegalAgentSettings />);
        expect(await screen.findByText(/Nenhum canal ainda/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: /Conectar canal/ }));
        const dialog = await screen.findByRole("dialog", { name: "Conectar canal" });
        fireEvent.change(within(dialog).getByPlaceholderText("Slack do Legal"), { target: { value: "Slack da Avenia" } });
        fireEvent.change(within(dialog).getByPlaceholderText("Avenia"), { target: { value: "Avenia" } });
        await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Gerar configuração" })));
        expect(await screen.findByText("Criar o app")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
        expect(screen.getByText("Slack da Avenia")).toBeInTheDocument();
    });
});
