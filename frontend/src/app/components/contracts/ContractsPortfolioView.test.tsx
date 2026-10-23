import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContractsPortfolioView } from "./ContractsPortfolioView";
import type { PortfolioLoad, PortfolioRow } from "@/app/lib/contractsPortfolio";

vi.mock("@/app/components/shared/PageHeader", () => ({
    PageHeader: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
}));

const row = (over: Partial<PortfolioRow>): PortfolioRow => ({
    project_id: "p",
    name: "Contrato",
    counterparty: null,
    contract_type: null,
    lane: null,
    term_end: null,
    notice_days: null,
    notice_deadline: null,
    filled: 0,
    verified: 0,
    total: 24,
    risk: null,
    ...over,
});

const today = new Date(2026, 9, 20);

describe("ContractsPortfolioView", () => {
    it("teaches the next step while the portfolio is not available", async () => {
        render(<ContractsPortfolioView load={async () => ({ status: "unavailable" })} today={today} />);
        expect(await screen.findByText("A carteira está chegando")).toBeVisible();
        expect(screen.getByRole("link", { name: "Ir para o Início" })).toHaveAttribute("href", "/inicio");
    });

    it("lists contracts with the soonest notice first and the days left", async () => {
        const load = async (): Promise<PortfolioLoad> => ({
            status: "ok",
            rows: [
                row({ project_id: "b", name: "Locação SP", notice_deadline: "2026-12-01", filled: 20 }),
                row({
                    project_id: "a",
                    name: "MSA Trópico",
                    counterparty: "Trópico Payments S.A.",
                    term_end: "2027-01-10",
                    notice_deadline: "2026-10-21",
                    filled: 14,
                }),
            ],
        });
        render(<ContractsPortfolioView load={load} today={today} />);
        const links = await screen.findAllByRole("link");
        expect(links.map((l) => l.textContent)).toEqual(["MSA Trópico", "Locação SP"]);
        expect(links[0]).toHaveAttribute("href", "/projects/a/review");
        expect(screen.getByText("falta 1 dia")).toBeVisible();
        expect(screen.getByText("Contraparte não informada")).toBeVisible();
        expect(screen.getByText("14 de 24 preenchidos")).toBeVisible();
    });

    it("shows the contract type as a label, not the stored key", async () => {
        render(
            <ContractsPortfolioView
                load={async () => ({
                    status: "ok",
                    rows: [row({ name: "Prestação — Beta", contract_type: "prestacao_servicos" })],
                })}
                today={today}
            />,
        );
        expect(await screen.findByText("Prestação de serviços")).toBeVisible();
        expect(screen.queryByText("prestacao_servicos")).not.toBeInTheDocument();
    });

    it("re-sorts by name", async () => {
        const user = userEvent.setup();
        const load = async (): Promise<PortfolioLoad> => ({
            status: "ok",
            rows: [
                row({ project_id: "z", name: "Zeta", notice_deadline: "2026-10-25" }),
                row({ project_id: "a", name: "Alfa", notice_deadline: "2026-12-25" }),
            ],
        });
        render(<ContractsPortfolioView load={load} today={today} />);
        await screen.findByText("Zeta");
        await user.click(screen.getByRole("button", { name: "Nome" }));
        expect(screen.getAllByRole("link").map((l) => l.textContent)).toEqual(["Alfa", "Zeta"]);
    });

    it("says when the notice window has passed and on its last day", async () => {
        const load = async (): Promise<PortfolioLoad> => ({
            status: "ok",
            rows: [
                row({ project_id: "a", name: "Antigo", notice_deadline: "2026-10-01" }),
                row({ project_id: "b", name: "Hoje", notice_deadline: "2026-10-20" }),
                row({ project_id: "c", name: "Longe", notice_deadline: "2026-11-30" }),
            ],
        });
        render(<ContractsPortfolioView load={load} today={today} />);
        expect(await screen.findByText("janela de aviso passou")).toBeVisible();
        expect(screen.getByText("último dia")).toBeVisible();
        expect(screen.getByText("faltam 41 dias")).toBeVisible();
    });

    it("shows an empty state with an action when there is no contract", async () => {
        render(<ContractsPortfolioView load={async () => ({ status: "ok", rows: [] })} today={today} />);
        expect(await screen.findByText("Nenhum contrato ainda")).toBeVisible();
        expect(screen.getByRole("link", { name: "Enviar contratos" })).toBeVisible();
    });

    it("offers Tentar de novo when loading fails, in Portuguese", async () => {
        const user = userEvent.setup();
        const load = vi
            .fn<() => Promise<PortfolioLoad>>()
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValueOnce({ status: "ok", rows: [row({ project_id: "a", name: "Alfa" })] });
        render(<ContractsPortfolioView load={load} today={today} />);
        expect(await screen.findByText("Não consegui carregar os contratos")).toBeVisible();
        await user.click(screen.getByRole("button", { name: "Tentar de novo" }));
        expect(await screen.findByText("Alfa")).toBeVisible();
    });
});
