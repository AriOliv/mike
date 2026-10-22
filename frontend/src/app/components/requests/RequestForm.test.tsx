import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
    createRequest: vi.fn(),
    getRequestRole: vi.fn(),
    uploadStandaloneDocument: vi.fn(),
}));
const errors = vi.hoisted(() => ({ notifyError: vi.fn() }));

vi.mock("@/app/lib/mikeApi", async (original) => ({
    ...(await original<typeof import("@/app/lib/mikeApi")>()),
    ...api,
}));
vi.mock("@/app/lib/userFacingError", () => ({ notifyError: errors.notifyError }));

import { MikeApiError } from "@/app/lib/mikeApi";
import { RequestForm } from "./RequestForm";

const areas = ["Comercial", "Produto", "Outra"];

beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    errors.notifyError.mockReset();
    api.createRequest.mockResolvedValue({ request: { id: "r1" }, deduplicated: false });
});

const go = (name: RegExp | string) => fireEvent.click(screen.getByRole("button", { name }));

/** Part 1: the kind. Then Continuar to part 2 and Continuar/Pular to part 3. */
function pickKind() {
    fireEvent.click(screen.getByRole("button", { name: /NDA/ }));
}
function toPart3() {
    go("Continuar");
    go(/Continuar|Pular/);
}
function fillContext() {
    fireEvent.change(screen.getByPlaceholderText(/O que vai acontecer/), { target: { value: "Conversa comercial" } });
}
function submit() {
    fireEvent.submit(document.getElementById("request-form")!);
}

describe("RequestForm in three parts", () => {
    it("shows one part at a time, with the progress", async () => {
        api.getRequestRole.mockResolvedValue({ configured: true, role: "requester", area: "Produto", areas });
        render(<RequestForm open onClose={vi.fn()} onCreated={vi.fn()} />);
        expect(await screen.findByText("Parte 1 de 3")).toBeInTheDocument();
        expect(screen.getByText(/· O que você precisa$/)).toBeInTheDocument();
        pickKind();
        go("Continuar");
        expect(screen.getByText("Parte 2 de 3")).toBeInTheDocument();
        go("Pular");
        expect(screen.getByText("Parte 3 de 3")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Enviar pedido" })).toBeInTheDocument();
        go("Voltar");
        expect(screen.getByText("Parte 2 de 3")).toBeInTheDocument();
    });

    it("will not leave part 1 without a kind, or without an area when one is asked", async () => {
        api.getRequestRole.mockResolvedValue({ configured: true, role: "requester", area: null, areas });
        render(<RequestForm open onClose={vi.fn()} onCreated={vi.fn()} />);
        expect(await screen.findByText("De qual área você é?")).toBeInTheDocument();
        go("Continuar");
        expect(await screen.findByRole("alert")).toHaveTextContent("Escolha o que você precisa.");
        pickKind();
        go("Continuar");
        expect(await screen.findByRole("alert")).toHaveTextContent("Diga de qual área você é.");
        go("Comercial");
        go("Continuar");
        expect(screen.getByText("Parte 2 de 3")).toBeInTheDocument();
    });

    it("asks the area the first time and sends it", async () => {
        api.getRequestRole.mockResolvedValue({ configured: true, role: "requester", area: null, areas });
        const onCreated = vi.fn();
        render(<RequestForm open onClose={vi.fn()} onCreated={onCreated} />);
        await screen.findByText("De qual área você é?");
        pickKind();
        go("Comercial");
        toPart3();
        fillContext();
        submit();
        await waitFor(() =>
            expect(api.createRequest).toHaveBeenCalledWith(expect.objectContaining({ kind: "nda", requester_area: "Comercial" })),
        );
        expect(onCreated).toHaveBeenCalledWith({ id: "r1" });
    });

    it("does not ask when the area is known, and lets the person change it", async () => {
        api.getRequestRole.mockResolvedValue({ configured: true, role: "requester", area: "Produto", areas });
        render(<RequestForm open onClose={vi.fn()} onCreated={vi.fn()} />);
        expect(await screen.findByText("Produto")).toBeInTheDocument();
        expect(screen.queryByText("De qual área você é?")).not.toBeInTheDocument();
        pickKind();
        toPart3();
        fillContext();
        submit();
        await waitFor(() => expect(api.createRequest).toHaveBeenCalled());
        expect(api.createRequest.mock.calls[0][0]).not.toHaveProperty("requester_area");
    });

    it("lets the person change a known area", async () => {
        api.getRequestRole.mockResolvedValue({ configured: true, role: "requester", area: "Produto", areas });
        render(<RequestForm open onClose={vi.fn()} onCreated={vi.fn()} />);
        await screen.findByText("Produto");
        go("trocar");
        expect(screen.getByText("De qual área você é?")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Produto" })).toHaveAttribute("aria-pressed", "true");
    });

    it("still works when the area cannot be loaded", async () => {
        api.getRequestRole.mockRejectedValue(new Error("offline"));
        render(<RequestForm open onClose={vi.fn()} onCreated={vi.fn()} />);
        pickKind();
        toPart3();
        fillContext();
        submit();
        await waitFor(() => expect(api.createRequest).toHaveBeenCalled());
        expect(screen.queryByText("De qual área você é?")).not.toBeInTheDocument();
    });

    it("sends nothing from part 2 when it is skipped", async () => {
        api.getRequestRole.mockResolvedValue({ configured: true, role: "requester", area: "Produto", areas });
        render(<RequestForm open onClose={vi.fn()} onCreated={vi.fn()} />);
        await screen.findByText("Produto");
        pickKind();
        toPart3();
        fillContext();
        submit();
        await waitFor(() => expect(api.createRequest).toHaveBeenCalled());
        const sent = api.createRequest.mock.calls[0][0];
        expect(sent).not.toHaveProperty("counterparty_email");
        expect(sent).not.toHaveProperty("term_start");
        expect(sent).not.toHaveProperty("term_months");
    });
});

describe("RequestForm, part 2: the contract", () => {
    async function openPart2() {
        api.getRequestRole.mockResolvedValue({ configured: true, role: "requester", area: "Produto", areas });
        render(<RequestForm open onClose={vi.fn()} onCreated={vi.fn()} />);
        await screen.findByText("Produto");
        pickKind();
        go("Continuar");
    }

    it("says the e-mail is only kept, before anything is typed", async () => {
        await openPart2();
        expect(screen.getByText("Só guardamos este e-mail para uso futuro. Não enviamos nada a essa pessoa.")).toBeInTheDocument();
        expect(screen.getByPlaceholderText("nome@empresa.com")).toBeInTheDocument();
    });

    it("writes the end of the term as soon as it has the start and the months, and not before", async () => {
        await openPart2();
        expect(screen.queryByText(/Termina em/)).not.toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Início da vigência"), { target: { value: "2026-11-12" } });
        expect(screen.queryByText(/Termina em/)).not.toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Prazo (em meses)"), { target: { value: "12" } });
        expect(screen.getByText("Termina em 12/11/2027 (início + 12 meses)")).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Início da vigência"), { target: { value: "2026-01-31" } });
        fireEvent.change(screen.getByLabelText("Prazo (em meses)"), { target: { value: "1" } });
        expect(screen.getByText("Termina em 28/02/2026 (início + 1 mês)")).toBeInTheDocument();
    });

    it("warns about an old start, and does not block", async () => {
        await openPart2();
        fireEvent.change(screen.getByLabelText("Início da vigência"), { target: { value: "2015-03-01" } });
        expect(screen.getByText(/mais de 5 anos atrás/)).toBeInTheDocument();
        go(/Continuar/);
        expect(screen.getByText("Parte 3 de 3")).toBeInTheDocument();
    });

    it("shows the months error under the field and stops on it", async () => {
        await openPart2();
        fireEvent.change(screen.getByLabelText("Prazo (em meses)"), { target: { value: "0" } });
        expect(screen.getAllByText("Use um prazo de 1 mês ou mais.").length).toBeGreaterThan(0);
        go("Continuar");
        expect(screen.getByText("Parte 2 de 3")).toBeInTheDocument();
    });

    it("checks the e-mail when the person leaves the field, and an empty one never errors", async () => {
        await openPart2();
        const email = screen.getByPlaceholderText("nome@empresa.com");
        fireEvent.blur(email);
        expect(screen.queryByText(/não parece certo/)).not.toBeInTheDocument();
        fireEvent.change(email, { target: { value: "sem-arroba" } });
        fireEvent.blur(email);
        expect(screen.getAllByText("Esse e-mail não parece certo. Confira e tente de novo.").length).toBeGreaterThan(0);
        go("Continuar");
        expect(screen.getByText("Parte 2 de 3")).toBeInTheDocument();
        fireEvent.change(email, { target: { value: "ana@polaris.com" } });
        expect(screen.queryByText(/não parece certo/)).not.toBeInTheDocument();
    });

    it("sends the e-mail, the start and the months when filled", async () => {
        await openPart2();
        fireEvent.change(screen.getByPlaceholderText("nome@empresa.com"), { target: { value: " ana@polaris.com " } });
        fireEvent.change(screen.getByLabelText("Início da vigência"), { target: { value: "2026-11-12" } });
        fireEvent.change(screen.getByLabelText("Prazo (em meses)"), { target: { value: "12" } });
        go("Continuar");
        fillContext();
        submit();
        await waitFor(() =>
            expect(api.createRequest).toHaveBeenCalledWith(
                expect.objectContaining({ counterparty_email: "ana@polaris.com", term_start: "2026-11-12", term_months: 12 }),
            ),
        );
    });

    it("paints a server error on its own field and takes the person back to part 2", async () => {
        api.createRequest.mockRejectedValue(
            new MikeApiError({ status: 422, message: "Escolha uma data de início válida.", field: "term_start" }),
        );
        await openPart2();
        go("Pular");
        fillContext();
        submit();
        expect(await screen.findByText("Parte 2 de 3")).toBeInTheDocument();
        expect(screen.getByRole("alert")).toHaveTextContent("Escolha uma data de início válida.");
        expect(errors.notifyError).not.toHaveBeenCalled();
    });

    it("keeps the notice for a failure that names no field", async () => {
        api.createRequest.mockRejectedValue(new MikeApiError({ status: 500, message: "falha" }));
        await openPart2();
        go("Pular");
        fillContext();
        submit();
        await waitFor(() => expect(errors.notifyError).toHaveBeenCalled());
        expect(screen.getByText("Parte 3 de 3")).toBeInTheDocument();
    });

    it("takes the person back to part 1 when Enter sends without a kind", async () => {
        api.getRequestRole.mockResolvedValue({ configured: true, role: "requester", area: "Produto", areas });
        render(<RequestForm open onClose={vi.fn()} onCreated={vi.fn()} />);
        await screen.findByText("Produto");
        submit();
        expect(await screen.findByRole("alert")).toHaveTextContent("Escolha o que você precisa.");
        expect(screen.getByText("Parte 1 de 3")).toBeInTheDocument();
    });
});
