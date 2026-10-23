import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestTerms } from "@/app/lib/mikeApi";

const api = vi.hoisted(() => ({ getRequestTerms: vi.fn(), saveRequestTerms: vi.fn() }));
const errors = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock("@/app/lib/mikeApi", async (original) => ({
    ...(await original<typeof import("@/app/lib/mikeApi")>()),
    ...api,
}));
vi.mock("@/app/lib/userFacingError", async (original) => ({
    ...(await original<typeof import("@/app/lib/userFacingError")>()),
    notifyError: errors.notifyError,
}));

import { MikeApiError } from "@/app/lib/mikeApi";
import { RequestTermsSection } from "./RequestTermsSection";

function terms(over: Partial<RequestTerms> = {}): RequestTerms {
    return {
        counterparty: null,
        counterparty_email: null,
        term_start: null,
        term_months: null,
        term_end: null,
        inferred: {},
        can_answer: true,
        ...over,
    };
}

beforeEach(() => {
    api.getRequestTerms.mockReset();
    api.saveRequestTerms.mockReset();
    errors.notifyError.mockReset();
});

describe("RequestTermsSection", () => {
    it("shows what is known, what is missing, and the end worked out from the start and the term", async () => {
        api.getRequestTerms.mockResolvedValue(
            terms({ counterparty: "Polaris", term_start: "2026-11-12", term_months: 12, term_end: "2027-11-11" }),
        );
        render(<RequestTermsSection requestId="r1" />);
        expect(await screen.findByText("Polaris")).toBeInTheDocument();
        expect(screen.getByText("12/11/2026")).toBeInTheDocument();
        expect(screen.getByText("12 meses")).toBeInTheDocument();
        expect(screen.getByText("Não informado")).toBeInTheDocument();
        expect(screen.getByText("11/11/2027")).toBeInTheDocument();
        expect(screen.getByText(/início \+ 12 meses − 1 dia/)).toBeInTheDocument();
    });

    it("shows no end until both the start and the term are known", async () => {
        api.getRequestTerms.mockResolvedValue(terms({ term_start: "2026-11-12" }));
        render(<RequestTermsSection requestId="r1" />);
        await screen.findByText("12/11/2026");
        expect(screen.queryByText(/Termina em/)).not.toBeInTheDocument();
    });

    it("offers what the agent read with the contract's own words as proof, and nothing is a fact yet", async () => {
        api.getRequestTerms.mockResolvedValue(
            terms({ inferred: { term_months: { value: "24", quote: "pelo prazo de 24 (vinte e quatro) meses" } } }),
        );
        render(<RequestTermsSection requestId="r1" />);
        expect(await screen.findByText("IA")).toBeInTheDocument();
        expect(screen.getByText(/Li no contrato:/)).toHaveTextContent("24 meses");
        expect(screen.getByText("pelo prazo de 24 (vinte e quatro) meses")).toBeInTheDocument();
        // The field itself still says nothing was confirmed: the term is not filled in.
        const term = screen.getByText("Prazo").closest("div")!.parentElement!;
        expect(within(term).getByText("Não informado")).toBeInTheDocument();
    });

    it("confirms a suggestion by asking for just that field, and shows the result", async () => {
        api.getRequestTerms.mockResolvedValue(
            terms({ inferred: { term_months: { value: "24", quote: "prazo de 24 meses" } } }),
        );
        api.saveRequestTerms.mockResolvedValue(terms({ term_months: 24 }));
        render(<RequestTermsSection requestId="r1" />);
        fireEvent.click(await screen.findByRole("button", { name: "Confirmar" }));
        await waitFor(() => expect(api.saveRequestTerms).toHaveBeenCalledWith("r1", { confirm: ["term_months"] }));
        expect(await screen.findByText("24 meses")).toBeInTheDocument();
        expect(screen.queryByText("IA")).not.toBeInTheDocument();
    });

    it("shows the typed value and the suggestion when both arrive, and Confirmar swaps the value for what was read", async () => {
        // A rare race on the server: the person typed while the agent was still reading.
        api.getRequestTerms.mockResolvedValue(
            terms({ term_months: 12, term_end: null, inferred: { term_months: { value: "24", quote: "pelo prazo de 24 meses" } } }),
        );
        api.saveRequestTerms.mockResolvedValue(terms({ term_months: 24 }));
        render(<RequestTermsSection requestId="r1" />);
        // The typed value stands, and the suggestion is offered next to it, not over it.
        expect(await screen.findByText("12 meses", { selector: "p.text-gray-900" })).toBeInTheDocument();
        expect(screen.getByText(/Li no contrato:/)).toHaveTextContent("24 meses");
        fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
        await waitFor(() => expect(api.saveRequestTerms).toHaveBeenCalledWith("r1", { confirm: ["term_months"] }));
        expect(await screen.findByText("24 meses", { selector: "p.text-gray-900" })).toBeInTheDocument();
        expect(screen.queryByText(/Li no contrato:/)).not.toBeInTheDocument();
    });

    it("corrects a suggestion by typing the real value", async () => {
        api.getRequestTerms.mockResolvedValue(terms({ inferred: { counterparty: { value: "Polaris S.A.", quote: "Polaris S.A., CNPJ…" } } }));
        api.saveRequestTerms.mockResolvedValue(terms({ counterparty: "Polaris Tecnologia" }));
        render(<RequestTermsSection requestId="r1" />);
        fireEvent.click(await screen.findByRole("button", { name: "Corrigir" }));
        const input = screen.getByRole("textbox", { name: "Com quem" });
        expect(input).toHaveValue("");
        fireEvent.change(input, { target: { value: "Polaris Tecnologia" } });
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        await waitFor(() => expect(api.saveRequestTerms).toHaveBeenCalledWith("r1", { counterparty: "Polaris Tecnologia" }));
        expect(await screen.findByText("Polaris Tecnologia")).toBeInTheDocument();
    });

    it("checks the months before sending, in the server's words", async () => {
        api.getRequestTerms.mockResolvedValue(terms());
        render(<RequestTermsSection requestId="r1" />);
        fireEvent.click(await screen.findByRole("button", { name: "Editar: Prazo" }));
        fireEvent.change(screen.getByRole("textbox", { name: "Prazo" }), { target: { value: "0" } });
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Use um prazo de 1 mês ou mais.");
        expect(api.saveRequestTerms).not.toHaveBeenCalled();
    });

    it("paints a server 422 under the field it names, with no toast", async () => {
        api.getRequestTerms.mockResolvedValue(terms());
        api.saveRequestTerms.mockRejectedValue(
            new MikeApiError({ status: 422, message: "Escolha uma data de início válida.", field: "term_start" }),
        );
        render(<RequestTermsSection requestId="r1" />);
        fireEvent.click(await screen.findByRole("button", { name: "Editar: Início da vigência" }));
        fireEvent.change(screen.getByLabelText("Início da vigência"), { target: { value: "2026-11-12" } });
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Escolha uma data de início válida.");
        expect(errors.notifyError).not.toHaveBeenCalled();
    });

    it("uses a notice for a failure that names no field", async () => {
        api.getRequestTerms.mockResolvedValue(terms());
        api.saveRequestTerms.mockRejectedValue(new MikeApiError({ status: 500, message: "falha" }));
        render(<RequestTermsSection requestId="r1" />);
        fireEvent.click(await screen.findByRole("button", { name: "Editar: Com quem" }));
        fireEvent.change(screen.getByRole("textbox", { name: "Com quem" }), { target: { value: "Polaris" } });
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        await waitFor(() => expect(errors.notifyError).toHaveBeenCalled());
    });

    it("is read-only when the request is closed or the person may not answer", async () => {
        api.getRequestTerms.mockResolvedValue(
            terms({ can_answer: false, counterparty: "Polaris", inferred: { term_months: { value: "12", quote: "12 meses" } } }),
        );
        render(<RequestTermsSection requestId="r1" />);
        await screen.findByText("Polaris");
        expect(screen.queryByRole("button", { name: /Editar|Informar|Confirmar|Corrigir/ })).not.toBeInTheDocument();
        // The suggestion is still shown, as information.
        expect(screen.getByText("12 meses", { selector: "blockquote" })).toBeInTheDocument();
    });

    it("says the other party's e-mail is only kept", async () => {
        api.getRequestTerms.mockResolvedValue(terms({ counterparty_email: "ana@polaris.com" }));
        render(<RequestTermsSection requestId="r1" />);
        const email = (await screen.findByText("ana@polaris.com")).closest("div")!;
        expect(within(email).getByText(/Só guardamos este e-mail para uso futuro/)).toBeInTheDocument();
    });

    it("shows nothing when the terms cannot be loaded", async () => {
        api.getRequestTerms.mockRejectedValue(new Error("x"));
        const { container } = render(<RequestTermsSection requestId="r1" />);
        await waitFor(() => expect(api.getRequestTerms).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
    });
});
