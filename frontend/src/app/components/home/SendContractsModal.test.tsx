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
        expect(toasts.showToast).toHaveBeenCalledWith(
            expect.objectContaining({ message: "Recebi 1 de 2 contratos. Os outros não puderam ser enviados." }),
        );
    });

    it("reuses an existing folder, and reports a failure without closing", async () => {
        api.listWatchedFolders.mockResolvedValue([{ id: "f9", name: "Fornecedores", contracts: 3 }]);
        api.listPlaybooks.mockRejectedValue(new Error("x"));
        api.uploadProjectDocuments.mockResolvedValue([{ status: "completed" }]);
        const onSent = vi.fn();
        render(<SendContractsModal onClose={vi.fn()} onSent={onSent} />);
        expect(await screen.findByText("Fornecedores")).toBeInTheDocument();
        fireEvent.drop(screen.getByRole("button", { name: /Arraste PDFs/ }), {
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

    it("reports a failure and lets the person try again", async () => {
        api.listWatchedFolders.mockResolvedValue([{ id: "f9", name: "Fornecedores" }]);
        api.listPlaybooks.mockResolvedValue([]);
        api.createProject.mockRejectedValueOnce(new Error("down"));
        const onSent = vi.fn();
        render(<SendContractsModal onClose={vi.fn()} onSent={onSent} />);
        expect(await screen.findByText("Fornecedores")).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Escolher contratos"), { target: { files: [pdf("A.pdf")] } });
        fireEvent.click(screen.getByRole("button", { name: "Enviar e revisar" }));
        await waitFor(() => expect(errors.notifyError).toHaveBeenCalled());
        expect(onSent).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Enviar e revisar" })).toBeEnabled();
    });
});
