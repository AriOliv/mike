import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
    createRequest: vi.fn(),
    getRequestRole: vi.fn(),
    uploadStandaloneDocument: vi.fn(),
}));
vi.mock("@/app/lib/mikeApi", () => api);
vi.mock("@/app/lib/userFacingError", () => ({ notifyError: vi.fn() }));

import { RequestForm } from "./RequestForm";

const areas = ["Comercial", "Produto", "Outra"];

beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.createRequest.mockResolvedValue({ request: { id: "r1" }, deduplicated: false });
});

function fill() {
    fireEvent.click(screen.getByRole("button", { name: /NDA/ }));
    fireEvent.change(screen.getByPlaceholderText(/Empresa ou pessoa/), { target: { value: "Polaris" } });
}

describe("RequestForm", () => {
    it("asks the area the first time and sends it", async () => {
        api.getRequestRole.mockResolvedValue({ configured: true, role: "requester", area: null, areas });
        const onCreated = vi.fn();
        render(<RequestForm open onClose={vi.fn()} onCreated={onCreated} />);
        expect(await screen.findByText("De qual área você é?")).toBeInTheDocument();
        fill();
        fireEvent.submit(document.getElementById("request-form")!);
        expect(await screen.findByRole("alert")).toHaveTextContent("Diga de qual área você é.");
        fireEvent.click(screen.getByRole("button", { name: "Comercial" }));
        fireEvent.submit(document.getElementById("request-form")!);
        await waitFor(() =>
            expect(api.createRequest).toHaveBeenCalledWith(
                expect.objectContaining({ kind: "nda", counterparty: "Polaris", requester_area: "Comercial" }),
            ),
        );
        expect(onCreated).toHaveBeenCalledWith({ id: "r1" });
    });

    it("does not ask when the area is known, and lets the person change it", async () => {
        api.getRequestRole.mockResolvedValue({ configured: true, role: "requester", area: "Produto", areas });
        render(<RequestForm open onClose={vi.fn()} onCreated={vi.fn()} />);
        expect(await screen.findByText("Produto")).toBeInTheDocument();
        expect(screen.queryByText("De qual área você é?")).not.toBeInTheDocument();
        fill();
        fireEvent.submit(document.getElementById("request-form")!);
        await waitFor(() => expect(api.createRequest).toHaveBeenCalled());
        expect(api.createRequest.mock.calls[0][0]).not.toHaveProperty("requester_area");

        fireEvent.click(screen.getByRole("button", { name: "trocar" }));
        expect(screen.getByText("De qual área você é?")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Produto" })).toHaveAttribute("aria-pressed", "true");
    });

    it("still works when the area cannot be loaded", async () => {
        api.getRequestRole.mockRejectedValue(new Error("offline"));
        render(<RequestForm open onClose={vi.fn()} onCreated={vi.fn()} />);
        fill();
        fireEvent.submit(document.getElementById("request-form")!);
        await waitFor(() => expect(api.createRequest).toHaveBeenCalled());
        expect(screen.queryByText("De qual área você é?")).not.toBeInTheDocument();
    });
});
