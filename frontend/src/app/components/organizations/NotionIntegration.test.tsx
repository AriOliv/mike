import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotionBoardSchema, NotionConnection } from "@/app/lib/mikeApi";

const api = vi.hoisted(() => ({
    getNotionConnection: vi.fn(),
    connectNotion: vi.fn(),
    disconnectNotion: vi.fn(),
    listNotionDatabases: vi.fn(),
    describeNotionBoard: vi.fn(),
    saveNotionMapping: vi.fn(),
    previewNotionImport: vi.fn(),
    applyNotionImport: vi.fn(),
    getNotionSyncStatus: vi.fn(),
    setNotionSyncEnabled: vi.fn(),
    syncNotionNow: vi.fn(),
}));
vi.mock("@/app/lib/mikeApi", async (actual) => ({ ...(await actual<typeof import("@/app/lib/mikeApi")>()), ...api }));
vi.mock("./OrganizationSettingsShell", () => ({ useOrganizationSettings: () => ({ orgId: "org-1" }) }));
const toasts = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("@/app/components/ui/toast", async (actual) => ({ ...(await actual<typeof import("@/app/components/ui/toast")>()), ...toasts }));
const errors = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock("@/app/lib/userFacingError", async (actual) => ({ ...(await actual<typeof import("@/app/lib/userFacingError")>()), ...errors }));

import { NotionIntegration } from "./NotionIntegration";

const TOKEN = "ntn_" + "a".repeat(40);
const fields = [
    { field: "name", label: "Nome do contrato", types: ["title"], owner: "legal" as const },
    { field: "lane", label: "Etapa", types: ["select", "status"], owner: "legal" as const },
    { field: "risk_level", label: "Risco", types: ["select"], owner: "mike" as const },
];
const conn = (over: Partial<NotionConnection> = {}): NotionConnection => ({
    connected: false,
    token_last4: null,
    database_id: null,
    data_source_id: null,
    database_title: null,
    field_map: {},
    stage_map: {},
    sync_enabled: false,
    poll_minutes: 10,
    last_sync_at: null,
    last_sync_error: null,
    can_manage: true,
    fields,
    ...over,
});
const board: NotionBoardSchema = {
    database_id: "db1",
    title: "Esteira (fictícia)",
    properties: [
        { name: "Contrato", type: "title" },
        { name: "Etapa", type: "select", options: ["Revisão", "Processos"] },
        { name: "Fase", type: "select", options: ["Nova"] },
        { name: "Risco", type: "select", options: ["OK"] },
    ],
    stage_options: ["Revisão", "Processos"],
    suggested_field_map: { Contrato: "name", Etapa: "lane", Risco: "risk_level" },
    suggested_stage_map: { Revisão: { lane: "revisao", tag: null }, Processos: { lane: "triagem", tag: "Processos" } },
};

beforeEach(() => {
    vi.clearAllMocks();
    api.getNotionSyncStatus.mockResolvedValue({ sync_enabled: false, last_sync_at: null, last_sync_error: null, pending: 0, failed: 0, linked_cards: 0 });
});

describe("NotionIntegration", () => {
    it("connects with a token, never shows it again, and disconnects", async () => {
        api.getNotionConnection.mockResolvedValue(conn());
        api.connectNotion.mockResolvedValue(conn({ connected: true, token_last4: "aaaa" }));
        api.disconnectNotion.mockResolvedValue(conn());
        render(<NotionIntegration />);
        const input = await screen.findByPlaceholderText("ntn_…");
        expect(input).toHaveAttribute("type", "password");
        expect(screen.getByRole("button", { name: "Conectar" })).toBeDisabled();
        fireEvent.change(input, { target: { value: TOKEN } });
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Conectar" })));
        expect(api.connectNotion).toHaveBeenCalledWith("org-1", TOKEN);
        expect(await screen.findByText(/terminado em aaaa/)).toBeInTheDocument();
        expect(screen.queryByDisplayValue(TOKEN)).not.toBeInTheDocument();
        expect(toasts.showToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "success" }));
        await act(async () => fireEvent.click(screen.getByRole("button", { name: /Desconectar/ })));
        expect(await screen.findByPlaceholderText("ntn_…")).toBeInTheDocument();
    });

    it("picks a base, suggests the mapping, lets me fix it and saves", async () => {
        api.getNotionConnection.mockResolvedValue(conn({ connected: true, token_last4: "aaaa" }));
        api.listNotionDatabases.mockResolvedValue([{ id: "db1", data_source_id: "db1", title: "Esteira (fictícia)" }]);
        api.describeNotionBoard.mockResolvedValue(board);
        api.saveNotionMapping.mockResolvedValue(conn({ connected: true, database_title: "Esteira (fictícia)" }));
        render(<NotionIntegration />);
        { const el = await screen.findByRole("button", { name: "Escolher base" }); await act(async () => fireEvent.click(el)); }
        await act(async () => fireEvent.click(within(screen.getByRole("list", { name: "Bases do Notion" })).getByRole("button", { name: /Esteira/ })));
        expect(await screen.findByRole("heading", { name: "Mapeamento: Esteira (fictícia)" })).toBeInTheDocument();
        expect(screen.getByLabelText("Propriedade para Nome do contrato")).toHaveValue("Contrato");
        expect(screen.getByText("Etiqueta: Processos")).toBeInTheDocument();
        expect(screen.getByText("o Mike calcula; o Mike manda")).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText("Etapa do Mike para Processos"), { target: { value: "negociacao" } });
        fireEvent.change(screen.getByLabelText("Propriedade para Risco"), { target: { value: "" } });
        fireEvent.change(screen.getByLabelText("Minutos entre sincronias"), { target: { value: "15" } });
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Salvar mapeamento" })));
        expect(api.saveNotionMapping).toHaveBeenCalledWith("org-1", {
            database_id: "db1",
            field_map: { Contrato: "name", Etapa: "lane" },
            stage_map: { Revisão: { lane: "revisao", tag: null }, Processos: { lane: "negociacao", tag: "Processos" } },
            poll_minutes: 15,
        });
        expect(toasts.showToast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("importação") }));
    });

    it("follows the stage property I pick and blocks saving until every stage has a lane", async () => {
        api.getNotionConnection.mockResolvedValue(conn({ connected: true }));
        api.listNotionDatabases.mockResolvedValue([{ id: "db1", data_source_id: "db1", title: "Esteira (fictícia)" }]);
        api.describeNotionBoard.mockResolvedValue(board);
        render(<NotionIntegration />);
        { const el = await screen.findByRole("button", { name: "Escolher base" }); await act(async () => fireEvent.click(el)); }
        await act(async () => fireEvent.click(screen.getByRole("button", { name: /Esteira/ })));
        fireEvent.change(await screen.findByLabelText("Propriedade para Etapa"), { target: { value: "Fase" } });
        expect(screen.getByText("Escolha a etapa do Mike para Nova.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Salvar mapeamento" })).toBeDisabled();
        fireEvent.change(screen.getByLabelText("Etapa do Mike para Nova"), { target: { value: "entrada" } });
        expect(screen.getByRole("button", { name: "Salvar mapeamento" })).not.toBeDisabled();
        fireEvent.change(screen.getByLabelText("Propriedade para Etapa"), { target: { value: "" } });
        expect(screen.queryByText("Etapas")).not.toBeInTheDocument();
        expect(screen.getByText("Escolha a propriedade com a etapa.")).toBeInTheDocument();
    });

    it("reopens with the saved mapping of the same base", async () => {
        api.getNotionConnection.mockResolvedValue(
            conn({
                connected: true,
                database_id: "db1",
                database_title: "Esteira (fictícia)",
                field_map: { Contrato: "name", Etapa: "lane" },
                stage_map: { Revisão: { lane: "revisao", tag: null }, Processos: { lane: "arquivado", tag: "Processos" } },
                poll_minutes: 30,
            }),
        );
        api.listNotionDatabases.mockResolvedValue([{ id: "db1", data_source_id: "db1", title: "Esteira (fictícia)" }]);
        api.describeNotionBoard.mockResolvedValue(board);
        render(<NotionIntegration />);
        { const el = await screen.findByRole("button", { name: "Trocar base" }); await act(async () => fireEvent.click(el)); }
        await act(async () => fireEvent.click(screen.getByRole("button", { name: /Esteira/ })));
        expect(await screen.findByLabelText("Etapa do Mike para Processos")).toHaveValue("arquivado");
        expect(screen.getByLabelText("Propriedade para Risco")).toHaveValue("");
        expect(screen.getByLabelText("Minutos entre sincronias")).toHaveValue(30);
    });

    it("explains an empty list of bases and failed actions", async () => {
        api.getNotionConnection.mockResolvedValue(conn({ connected: true }));
        api.listNotionDatabases.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("x"));
        render(<NotionIntegration />);
        { const el = await screen.findByRole("button", { name: "Escolher base" }); await act(async () => fireEvent.click(el)); }
        expect(screen.getByText(/A integração ainda não vê nenhuma base/)).toBeInTheDocument();
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Escolher base" })));
        await waitFor(() => expect(errors.notifyError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ action: "listar as bases do Notion" })));
    });

    it("keeps a failed connect, read or save on screen", async () => {
        api.getNotionConnection.mockResolvedValue(conn({ connected: true }));
        api.listNotionDatabases.mockResolvedValue([{ id: "db1", data_source_id: "db1", title: "Esteira (fictícia)" }]);
        api.describeNotionBoard.mockRejectedValueOnce(new Error("x")).mockResolvedValue(board);
        api.saveNotionMapping.mockRejectedValue(new Error("x"));
        api.disconnectNotion.mockRejectedValue(new Error("x"));
        render(<NotionIntegration />);
        { const el = await screen.findByRole("button", { name: "Escolher base" }); await act(async () => fireEvent.click(el)); }
        await act(async () => fireEvent.click(screen.getByRole("button", { name: /Esteira/ })));
        expect(screen.queryByRole("heading", { name: /Mapeamento/ })).not.toBeInTheDocument();
        await act(async () => fireEvent.click(screen.getByRole("button", { name: /Esteira/ })));
        { const el = await screen.findByRole("button", { name: "Salvar mapeamento" }); await act(async () => fireEvent.click(el)); }
        await act(async () => fireEvent.click(screen.getByRole("button", { name: /Desconectar/ })));
        expect(errors.notifyError.mock.calls.map((c) => c[1].action)).toEqual(["ler a base do Notion", "salvar o mapeamento", "desconectar o Notion"]);
        expect(screen.getByRole("heading", { name: /Mapeamento/ })).toBeInTheDocument();
    });

    it("shows a member the state, read-only, and a failed connect", async () => {
        api.getNotionConnection.mockResolvedValueOnce(conn({ can_manage: false })).mockResolvedValueOnce(conn({ can_manage: false, connected: true, token_last4: "zzzz" }));
        const { unmount } = render(<NotionIntegration />);
        expect(await screen.findByText("O Notion ainda não está conectado nesta organização.")).toBeInTheDocument();
        expect(screen.getByText(/Só quem administra/)).toBeInTheDocument();
        unmount();
        render(<NotionIntegration />);
        expect(await screen.findByText(/terminado em zzzz/)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Desconectar/ })).not.toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "Base" })).not.toBeInTheDocument();
    });

    it("offers a retry when it cannot load, and survives a failed connect", async () => {
        api.getNotionConnection.mockRejectedValueOnce(new Error("x")).mockResolvedValue(conn());
        api.connectNotion.mockRejectedValue(new Error("x"));
        render(<NotionIntegration />);
        expect(await screen.findByText("Não consegui carregar a integração")).toBeInTheDocument();
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" })));
        fireEvent.change(await screen.findByPlaceholderText("ntn_…"), { target: { value: TOKEN } });
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Conectar" })));
        expect(errors.notifyError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ action: "conectar o Notion" }));
        expect(screen.getByDisplayValue(TOKEN)).toBeInTheDocument();
    });

    it("simulates the import, shows duplicates and warnings, then imports", async () => {
        const plan = {
            total: 6,
            counts: { linked: 1, project: 1, duplicate: 1, new: 2, skipped: 1 },
            items: [
                { page_id: "p1", name: "Contrato A", counterparty: null, lane: "revisao" as const, tag: null, match: "project" as const, project_id: "x", warnings: ["O link aponta para localhost."] },
                { page_id: "p2", name: "Contrato B", counterparty: null, lane: null, tag: null, match: "new" as const, project_id: null, warnings: [] },
            ],
            skipped: [{ page_id: "p3", reason: "A página não tem nome de contrato." }],
        };
        api.getNotionConnection.mockResolvedValue(conn({ connected: true, database_id: "db1", database_title: "Esteira (fictícia)", field_map: { Contrato: "name", Etapa: "lane" } }));
        api.previewNotionImport.mockResolvedValueOnce(plan).mockResolvedValueOnce({ ...plan, counts: { linked: 5, project: 0, duplicate: 0, new: 0, skipped: 1 } });
        api.applyNotionImport.mockResolvedValueOnce({ created: 2, linked: 2, skipped: 1, failed: 0 });
        render(<NotionIntegration />);
        const simulate = await screen.findByRole("button", { name: "Simular importação" });
        expect(screen.queryByRole("button", { name: "Importar agora" })).not.toBeInTheDocument();
        await act(async () => fireEvent.click(simulate));
        const summary = screen.getByRole("list", { name: "Resumo da simulação" });
        expect(within(summary).getByText("2 novos")).toBeInTheDocument();
        expect(within(summary).getByText("1 duplicados")).toBeInTheDocument();
        expect(within(summary).getByText("1 ficam de fora")).toBeInTheDocument();
        expect(within(screen.getByRole("list", { name: "Avisos da importação" })).getByText("O link aponta para localhost.")).toBeInTheDocument();
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Importar agora" })));
        expect(api.applyNotionImport).toHaveBeenCalledWith("org-1");
        expect(toasts.showToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "success", message: "Importação feita: 2 novos, 2 ligados a cards existentes." }));
        // Nothing left to import after it.
        expect(screen.getByRole("button", { name: "Importar agora" })).toBeDisabled();
    });

    it("tells a partial import and keeps going when the re-read fails", async () => {
        api.getNotionConnection.mockResolvedValue(conn({ connected: true, database_id: "db1", field_map: { Contrato: "name", Etapa: "lane" } }));
        const plan = { total: 1, counts: { linked: 0, project: 0, duplicate: 0, new: 1, skipped: 0 }, items: [], skipped: [] };
        api.previewNotionImport.mockResolvedValueOnce(plan).mockRejectedValueOnce(new Error("x")).mockRejectedValueOnce(new Error("y"));
        api.applyNotionImport.mockResolvedValueOnce({ created: 0, linked: 0, skipped: 0, failed: 1 }).mockRejectedValueOnce(new Error("x"));
        render(<NotionIntegration />);
        const simulate = await screen.findByRole("button", { name: "Simular importação" });
        await act(async () => fireEvent.click(simulate));
        expect(screen.queryByRole("list", { name: "Avisos da importação" })).not.toBeInTheDocument();
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Importar agora" })));
        expect(toasts.showToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "error", message: expect.stringContaining("1 com erro") }));
        expect(screen.queryByRole("list", { name: "Resumo da simulação" })).not.toBeInTheDocument();
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Simular importação" })));
        expect(errors.notifyError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ action: "simular a importação" }));
    });

    it("hides the import until the mapping is saved", async () => {
        api.getNotionConnection.mockResolvedValue(conn({ connected: true, database_id: "db1", field_map: { Contrato: "name" } }));
        render(<NotionIntegration />);
        await screen.findByRole("heading", { name: "Base" });
        expect(screen.queryByRole("button", { name: "Simular importação" })).not.toBeInTheDocument();
    });

    const mapped = () => conn({ connected: true, database_id: "db1", field_map: { Contrato: "name", Etapa: "lane" } });

    it("turns the sync on only after confirming, shows its state and syncs now", async () => {
        api.getNotionConnection.mockResolvedValue(mapped());
        api.getNotionSyncStatus
            .mockResolvedValueOnce({ sync_enabled: false, last_sync_at: null, last_sync_error: null, pending: 0, failed: 0, linked_cards: 12 })
            .mockResolvedValue({ sync_enabled: true, last_sync_at: new Date().toISOString(), last_sync_error: "O Notion pediu uma pausa.", pending: 3, failed: 1, linked_cards: 12 });
        api.setNotionSyncEnabled.mockResolvedValue({ sync_enabled: true });
        api.syncNotionNow.mockResolvedValue({ queued: true });
        render(<NotionIntegration />);
        const toggle = await screen.findByRole("switch", { name: "Sincronia com o Notion" });
        expect(screen.getByText("Última sincronia: ainda não sincronizou")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Sincronizar agora" })).toBeDisabled();
        fireEvent.click(toggle);
        expect(api.setNotionSyncEnabled).not.toHaveBeenCalled();
        fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
        expect(api.setNotionSyncEnabled).not.toHaveBeenCalled();
        fireEvent.click(toggle);
        await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Ligar" })));
        expect(api.setNotionSyncEnabled).toHaveBeenCalledWith("org-1", true);
        expect(await screen.findByText(/3 esperando para ir ao Notion · 1 com erro/)).toBeInTheDocument();
        expect(screen.getByRole("alert")).toHaveTextContent("O Notion pediu uma pausa.");
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sincronizar agora" })));
        expect(api.syncNotionNow).toHaveBeenCalledWith("org-1");
        expect(toasts.showToast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("Sincronia na fila") }));
    });

    it("turns the sync off without asking and keeps the old state when a read fails", async () => {
        api.getNotionConnection.mockResolvedValue(mapped());
        api.getNotionSyncStatus.mockResolvedValueOnce({ sync_enabled: true, last_sync_at: null, last_sync_error: null, pending: 0, failed: 0, linked_cards: 1 }).mockRejectedValue(new Error("x"));
        api.setNotionSyncEnabled.mockResolvedValueOnce({ sync_enabled: false }).mockRejectedValueOnce(new Error("x"));
        api.syncNotionNow.mockRejectedValue(new Error("x"));
        render(<NotionIntegration />);
        const toggle = await screen.findByRole("switch", { name: "Sincronia com o Notion" });
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sincronizar agora" })));
        expect(errors.notifyError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ action: "sincronizar agora" }));
        await act(async () => fireEvent.click(toggle));
        expect(api.setNotionSyncEnabled).toHaveBeenCalledWith("org-1", false);
        expect(screen.getByText(/1 cards ligados/)).toBeInTheDocument();
        await act(async () => fireEvent.click(toggle));
        expect(errors.notifyError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ action: "desligar a sincronia" }));
    });

    it("shows a member the state without the controls, and survives a failed first read", async () => {
        api.getNotionConnection.mockResolvedValue({ ...mapped(), can_manage: false });
        render(<NotionIntegration />);
        expect(await screen.findByRole("switch", { name: "Sincronia com o Notion" })).toBeDisabled();
        expect(screen.queryByRole("button", { name: "Sincronizar agora" })).not.toBeInTheDocument();
    });

    it("hides the sync block when its state cannot be read", async () => {
        api.getNotionConnection.mockResolvedValue(mapped());
        api.getNotionSyncStatus.mockRejectedValue(new Error("x"));
        render(<NotionIntegration />);
        await screen.findByRole("button", { name: "Simular importação" });
        expect(screen.queryByRole("switch", { name: "Sincronia com o Notion" })).not.toBeInTheDocument();
    });
});
