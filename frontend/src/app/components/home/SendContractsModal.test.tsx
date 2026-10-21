import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/contexts/WorkspaceContext", () => ({
    useWorkspace: () => ({ activeOrganization: { id: "o1" } }),
}));
const api = vi.hoisted(() => ({
    listWatchedFolders: vi.fn(),
    listPlaybooks: vi.fn(),
    createWatchedFolder: vi.fn(),
    createProject: vi.fn(),
    watchProject: vi.fn(),
    uploadProjectDocuments: vi.fn(),
    requestContractReview: vi.fn(),
    deleteProject: vi.fn(),
}));
vi.mock("@/app/lib/mikeApi", () => api);
const toasts = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("@/app/components/ui/toast", () => toasts);
const errors = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock("@/app/lib/userFacingError", () => errors);

import { SendContractsModal, cardName } from "./SendContractsModal";

const pdf = (name: string) => new File(["%PDF"], name, { type: "application/pdf" });

beforeEach(() => {
    vi.clearAllMocks();
    api.createProject.mockImplementation(async (name: string) => ({ id: `p-${name}` }));
    api.watchProject.mockResolvedValue(undefined);
    api.requestContractReview.mockResolvedValue({ review_id: "r", queued: true });
    api.deleteProject.mockResolvedValue(undefined);
});

describe("cardName", () => {
    it("drops the extension, keeping a name with no extension", () => {
        expect(cardName("Contrato Polaris (assinado).pdf")).toBe("Contrato Polaris (assinado)");
        expect(cardName(".pdf")).toBe(".pdf");
    });
});

describe("SendContractsModal", () => {
    it("creates a watched folder with the chosen playbook, then one reviewed card per file", async () => {
        api.listWatchedFolders.mockResolvedValue([]);
        api.listPlaybooks.mockResolvedValue([{ id: "pb1", name: "NDA Avenia" }]);
        api.createWatchedFolder.mockResolvedValue({ id: "f1" });
        api.uploadProjectDocuments
            .mockResolvedValueOnce([{ status: "completed" }])
            .mockResolvedValueOnce([{ status: "error" }]);
        const onSent = vi.fn();
        render(<SendContractsModal onClose={vi.fn()} onSent={onSent} />);
        await waitFor(() => expect(api.listPlaybooks).toHaveBeenCalledWith("o1"));
        fireEvent.change(screen.getByLabelText("Escolher contratos"), {
            target: { files: [pdf("NDA Polaris.pdf"), pdf("MSA.pdf")] },
        });
        fireEvent.click(await screen.findByRole("button", { name: "Enviar e revisar 2" }));
        await waitFor(() => expect(onSent).toHaveBeenCalled());
        expect(api.createWatchedFolder).toHaveBeenCalledWith({
            name: "Contratos recebidos",
            source: "upload",
            playbook_id: "pb1",
            org_id: "o1",
        });
        expect(api.createProject).toHaveBeenCalledWith("NDA Polaris", undefined, undefined, "o1");
        expect(api.watchProject).toHaveBeenCalledWith("f1", "p-NDA Polaris");
        expect(api.requestContractReview).toHaveBeenCalledTimes(1);
        // The card of the file that failed does not stay behind, empty.
        expect(api.deleteProject).toHaveBeenCalledWith("p-MSA");
        expect(api.watchProject).not.toHaveBeenCalledWith("f1", "p-MSA");
        expect(toasts.showToast).toHaveBeenCalledWith(
            expect.objectContaining({
                title: "Recebi 1 de 2 contratos",
                message: "Não foram: MSA.pdf. Tente esses de novo.",
            }),
        );
    });

    it("reuses an existing folder, and reports a failure without closing", async () => {
        api.listWatchedFolders.mockResolvedValue([{ id: "f9", name: "Fornecedores", contracts: 3 }]);
        api.listPlaybooks.mockRejectedValue(new Error("x"));
        api.uploadProjectDocuments.mockResolvedValue([{ status: "completed" }]);
        const onSent = vi.fn();
        render(<SendContractsModal onClose={vi.fn()} onSent={onSent} />);
        expect(await screen.findByText("Fornecedores")).toBeInTheDocument();
        fireEvent.drop(screen.getByRole("button", { name: /Arraste os contratos/ }), {
            dataTransfer: { files: [pdf("A.pdf")] },
        });
        fireEvent.click(await screen.findByRole("button", { name: "Enviar e revisar" }));
        await waitFor(() => expect(onSent).toHaveBeenCalled());
        expect(api.createWatchedFolder).not.toHaveBeenCalled();
        expect(api.watchProject).toHaveBeenCalledWith("f9", "p-A");
        expect(toasts.showToast).toHaveBeenCalledWith(
            expect.objectContaining({ message: "Recebi 1 contrato. Estou revisando." }),
        );
    });

    it("keeps the files that failed for another try when none went through", async () => {
        api.listWatchedFolders.mockResolvedValue([{ id: "f9", name: "Fornecedores" }]);
        api.listPlaybooks.mockResolvedValue([]);
        api.createProject.mockRejectedValueOnce(new Error("down"));
        const onSent = vi.fn();
        render(<SendContractsModal onClose={vi.fn()} onSent={onSent} />);
        expect(await screen.findByText("Fornecedores")).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Escolher contratos"), { target: { files: [pdf("A.pdf")] } });
        fireEvent.click(screen.getByRole("button", { name: "Enviar e revisar" }));
        await waitFor(() =>
            expect(toasts.showToast).toHaveBeenCalledWith(
                expect.objectContaining({ tone: "error", title: "Não consegui enviar os contratos" }),
            ),
        );
        expect(api.deleteProject).not.toHaveBeenCalled();
        expect(onSent).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Enviar e revisar" })).toBeEnabled();
    });

    it("says in Portuguese when the folder cannot be created, and filters dropped files", async () => {
        api.listWatchedFolders.mockResolvedValue([]);
        api.listPlaybooks.mockResolvedValue([]);
        api.createWatchedFolder.mockRejectedValue(new Error("x"));
        render(<SendContractsModal onClose={vi.fn()} onSent={vi.fn()} />);
        await waitFor(() => expect(api.listWatchedFolders).toHaveBeenCalled());
        fireEvent.drop(screen.getByRole("button", { name: /Arraste os contratos/ }), {
            dataTransfer: { files: [pdf("A.pdf"), new File(["x"], "foto.png")] },
        });
        expect(await screen.findByText("Fora do envio: foto.png: só PDF ou DOCX")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Enviar e revisar" }));
        await waitFor(() =>
            expect(errors.notifyError).toHaveBeenCalledWith(expect.anything(), {
                lang: "pt",
                action: "criar a pasta monitorada",
            }),
        );
        expect(api.createProject).not.toHaveBeenCalled();
    });
});
