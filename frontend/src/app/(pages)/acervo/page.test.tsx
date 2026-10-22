import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MikeApiError, type AcervoAnswer } from "@/app/lib/mikeApi";

const api = vi.hoisted(() => ({ askAcervo: vi.fn(), getPipeline: vi.fn() }));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    ...api,
}));
const errors = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock("@/app/lib/userFacingError", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/userFacingError")>()),
    notifyError: errors.notifyError,
}));
const reporting = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock("@/app/lib/errorReporting", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/errorReporting")>()),
    reportError: reporting.reportError,
}));
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import PerguntarPage from "./page";

const QUOTE = "A mudança de controle dependerá de prévia autorização.";

const answer = (overrides: Partial<AcervoAnswer> = {}): AcervoAnswer => ({
    answer: "Só o MSA Acme exige autorização [1]. Prevê multa [2].",
    found: true,
    sources: [
        {
            n: 1,
            project_id: "p1",
            document_id: "d1",
            contract: "MSA Acme",
            ref: "cl. 11.2",
            quote: QUOTE,
            verified: true,
            start_char: 10,
            end_char: 60,
        },
        {
            n: 2,
            project_id: "p1",
            document_id: null,
            contract: "MSA Acme",
            ref: null,
            quote: "multa de 20%",
            verified: false,
            start_char: null,
            end_char: null,
        },
    ],
    searched: 1,
    total: 2,
    aggregate: true,
    matches: [
        { project_id: "p1", contract: "MSA Acme", counterparty: "Acme", contract_type: "MSA", hit: true, quote: QUOTE, verified: true, basis: "lido" },
        { project_id: "p2", contract: "NDA Beta", counterparty: null, contract_type: "NDA", hit: false, quote: null, verified: false, basis: "pendente" },
    ],
    coverage: {
        total_versions: 2,
        indexed_versions: 1,
        pending_versions: 1,
        failed_versions: 0,
        versions_needing_ocr: 0,
        contracts_pending: 1,
        contracts_not_searched: 0,
    },
    terms: ["mudança de controle"],
    law_available: false,
    law_sources: [],
    ...overrides,
});

beforeEach(() => {
    vi.clearAllMocks();
    api.getPipeline.mockResolvedValue({
        lanes: [],
        by_lane: {},
        cards: [{ contract_type: "NDA" }, { contract_type: "MSA" }, { contract_type: null }],
    });
});

describe("Perguntar", () => {
    it("teaches with examples and asks one on click", async () => {
        api.askAcervo.mockResolvedValue(answer());
        render(<PerguntarPage />);
        // The page title and the submit button.
        expect(screen.getAllByText("Perguntar")).toHaveLength(2);
        await userEvent.click(screen.getByRole("button", { name: "Quais contratos têm renovação automática?" }));
        expect(api.askAcervo).toHaveBeenCalledWith("Quais contratos têm renovação automática?", {
            scope: "todos",
            includeLaw: undefined,
        });
    });

    it("renders cited answer, verified state, quote links and the per-contract table", async () => {
        api.askAcervo.mockResolvedValue(answer());
        render(<PerguntarPage />);
        await userEvent.type(screen.getByLabelText(/Pergunte sobre os contratos/), "mudança de controle{Enter}");

        const pill = await screen.findByRole("button", { name: "Ver fonte 1" });
        await userEvent.click(pill);
        expect(pill.getAttribute("aria-pressed")).toBe("true");

        const sources = screen.getByRole("region", { name: /Fontes/ });
        expect(within(sources).getByText("verificada")).toBeTruthy();
        expect(within(sources).getByText("não verificada")).toBeTruthy();
        const links = within(sources).getAllByRole("link");
        expect(links[0].getAttribute("href")).toBe(`/projects/p1/review?quote=${encodeURIComponent(QUOTE)}`);
        // An unverified quote opens the contract without claiming a highlight.
        expect(links[1].getAttribute("href")).toBe("/projects/p1/review");

        expect(screen.getByRole("heading", { name: "1 de 2 contratos" })).toBeTruthy();
        expect(screen.getByText("Ainda indexando")).toBeTruthy();
        // No grid shortcut until it can carry the question along.
        expect(screen.queryByText(/Abrir como grade/)).toBeNull();
        expect(screen.getByText(/1 contrato ainda está sendo indexado/)).toBeTruthy();
    });

    it("says exactly 'Não encontrei na base.' when nothing was verified", async () => {
        api.askAcervo.mockResolvedValue(answer({ found: false, aggregate: false }));
        render(<PerguntarPage />);
        await userEvent.type(screen.getByLabelText(/Pergunte sobre os contratos/), "foro{Enter}");
        expect(await screen.findByText("Não encontrei na base.")).toBeTruthy();
        expect(screen.queryByRole("button", { name: /Ver fonte/ })).toBeNull();
        // Already the whole corpus: there is no wider scope to offer.
        expect(screen.queryByRole("button", { name: "Buscar em todo o acervo" })).toBeNull();
    });

    it("offers the whole corpus when a narrowed question found nothing", async () => {
        api.askAcervo.mockResolvedValue(answer({ found: false, aggregate: false }));
        render(<PerguntarPage />);
        await userEvent.click(screen.getByRole("button", { name: "Esta contraparte" }));
        await userEvent.type(screen.getByLabelText("Contraparte"), "Acme");
        await userEvent.type(screen.getByLabelText(/Pergunte sobre os contratos/), "foro{Enter}");
        await userEvent.click(await screen.findByRole("button", { name: "Buscar em todo o acervo" }));
        expect(api.askAcervo).toHaveBeenLastCalledWith("foro", { scope: "todos", includeLaw: undefined });
        expect(screen.getByRole("button", { name: "Todo o acervo" }).getAttribute("aria-pressed")).toBe("true");
    });

    it("exposes the chosen scope with aria-pressed", async () => {
        render(<PerguntarPage />);
        const all = screen.getByRole("button", { name: "Todo o acervo" });
        const party = screen.getByRole("button", { name: "Esta contraparte" });
        const law = screen.getByRole("button", { name: /Incluir legislação/ });
        expect(all.getAttribute("aria-pressed")).toBe("true");
        expect(party.getAttribute("aria-pressed")).toBe("false");
        expect(law.getAttribute("aria-pressed")).toBe("false");
        await userEvent.click(party);
        await userEvent.click(law);
        expect(all.getAttribute("aria-pressed")).toBe("false");
        expect(party.getAttribute("aria-pressed")).toBe("true");
        expect(law.getAttribute("aria-pressed")).toBe("true");
        await userEvent.click(await screen.findByRole("button", { name: "Este tipo" }));
        expect(screen.getByRole("button", { name: "Este tipo" }).getAttribute("aria-pressed")).toBe("true");
    });

    it("sends the chosen scope and the legislation flag, and shows when law has no source", async () => {
        api.askAcervo.mockResolvedValue(answer({ found: false }));
        render(<PerguntarPage />);
        await userEvent.click(screen.getByRole("button", { name: "Esta contraparte" }));
        const ask = screen.getByRole("button", { name: "Perguntar" }) as HTMLButtonElement;
        await userEvent.type(screen.getByLabelText(/Pergunte sobre os contratos/), "foro");
        // A counterparty scope needs a name.
        expect(ask.disabled).toBe(true);
        await userEvent.type(screen.getByLabelText("Contraparte"), "Acme");
        await userEvent.click(screen.getByRole("button", { name: /Incluir legislação/ }));
        await userEvent.click(ask);
        expect(api.askAcervo).toHaveBeenLastCalledWith("foro", {
            scope: { counterparty: "Acme" },
            includeLaw: true,
        });
        expect(await screen.findByText("Legislação: em breve (sem fonte configurada)")).toBeTruthy();

        await userEvent.click(await screen.findByRole("button", { name: "Este tipo" }));
        await userEvent.selectOptions(screen.getByLabelText("Tipo de contrato"), "NDA");
        await userEvent.click(ask);
        await waitFor(() =>
            expect(api.askAcervo).toHaveBeenLastCalledWith("foro", { scope: { contract_type: "NDA" }, includeLaw: true }),
        );
    });

    it("shows a Portuguese failure once, inline, never the raw error, and retries the same question", async () => {
        const fault = new Error("relation dossiers does not exist");
        api.askAcervo.mockRejectedValueOnce(fault).mockResolvedValueOnce(answer());
        render(<PerguntarPage />);
        await userEvent.click(screen.getByRole("button", { name: "Esta contraparte" }));
        await userEvent.type(screen.getByLabelText("Contraparte"), "Acme");
        await userEvent.type(screen.getByLabelText(/Pergunte sobre os contratos/), "foro{Enter}");
        expect(await screen.findByText("Não consegui responder à pergunta")).toBeTruthy();
        expect(screen.getByText("Não consegui responder agora. Tente de novo em instantes.")).toBeTruthy();
        expect(screen.queryByText(/relation dossiers/)).toBeNull();
        // One place only: no toast on top of the inline state.
        expect(errors.notifyError).not.toHaveBeenCalled();
        expect(reporting.reportError).toHaveBeenCalledWith(fault, {
            tags: { component: "acervo", action: "responder à pergunta" },
        });

        // The question box changed since; the retry repeats what was asked.
        await userEvent.type(screen.getByLabelText(/Pergunte sobre os contratos/), " eleito");
        await userEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
        expect(api.askAcervo).toHaveBeenLastCalledWith("foro", {
            scope: { counterparty: "Acme" },
            includeLaw: undefined,
        });
        expect(await screen.findByRole("heading", { name: "1 de 2 contratos" })).toBeTruthy();
        expect(screen.queryByText("Não consegui responder à pergunta")).toBeNull();
    });

    it("offers the honest way forward when retrying would not help", async () => {
        render(<PerguntarPage />);
        const box = screen.getByLabelText(/Pergunte sobre os contratos/);

        api.askAcervo.mockRejectedValueOnce(
            new MikeApiError({ message: "model", status: 400, code: "model_required" }),
        );
        await userEvent.type(box, "foro{Enter}");
        await userEvent.click(await screen.findByRole("button", { name: "Abrir Configurações" }));
        expect(router.push).toHaveBeenLastCalledWith("/settings/models");

        api.askAcervo.mockRejectedValueOnce(new MikeApiError({ message: "expired", status: 401 }));
        await userEvent.type(box, "{Enter}");
        await userEvent.click(await screen.findByRole("button", { name: "Entrar de novo" }));
        expect(router.push).toHaveBeenLastCalledWith("/login?next=%2Facervo");

        api.askAcervo.mockRejectedValueOnce(new MikeApiError({ message: "bad", status: 422 }));
        await userEvent.type(box, "{Enter}");
        await userEvent.click(await screen.findByRole("button", { name: "Reescrever a pergunta" }));
        expect(screen.queryByRole("button", { name: "Reescrever a pergunta" })).toBeNull();
        expect(document.activeElement).toBe(box);

        // A 4xx is an answer, not a fault: nothing goes to Sentry.
        expect(reporting.reportError).not.toHaveBeenCalled();
        expect(errors.notifyError).not.toHaveBeenCalled();
    });
});
