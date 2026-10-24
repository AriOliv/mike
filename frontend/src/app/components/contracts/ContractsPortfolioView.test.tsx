import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContractsPortfolioView } from "./ContractsPortfolioView";
import { downloadBlob } from "@/app/lib/downloadDocument";
import type { PortfolioLoad, PortfolioRow } from "@/app/lib/contractsPortfolio";

vi.mock("@/app/components/shared/PageHeader", () => ({
    PageHeader: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
}));

vi.mock("@/app/lib/downloadDocument", () => ({ downloadBlob: vi.fn() }));

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
    assignee: null,
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

    describe("tabs, filters and export", () => {
        const load = async (): Promise<PortfolioLoad> => ({
            status: "ok",
            rows: [
                row({ project_id: "a", name: "Vigente Alfa", lane: "arquivado", term_end: "2027-01-01", assignee: "Duda", notice_deadline: "2026-12-01" }),
                row({ project_id: "b", name: "Vencido Beta", lane: "arquivado", term_end: "2026-01-01", assignee: "Bia" }),
                row({ project_id: "c", name: "Assinando Gama", lane: "assinatura", assignee: null }),
                row({ project_id: "d", name: "Andando Delta", lane: "revisao", assignee: "Duda" }),
            ],
        });
        const names = () => screen.getAllByRole("link").map((l) => l.textContent);

        it("counts each situation on its tab and filters by it", async () => {
            const user = userEvent.setup();
            render(<ContractsPortfolioView load={load} today={today} />);
            await screen.findByText("Vigente Alfa");
            for (const label of ["Todos · 4", "Em andamento · 1", "Em assinatura · 1", "Vigentes · 1", "Vencidos · 1"])
                expect(screen.getByRole("button", { name: label })).toBeVisible();
            await user.click(screen.getByRole("button", { name: "Vencidos · 1" }));
            expect(names()).toEqual(["Vencido Beta"]);
            await user.click(screen.getByRole("button", { name: "Em assinatura · 1" }));
            expect(names()).toEqual(["Assinando Gama"]);
        });

        it("shows the stage and the owner on every row", async () => {
            render(<ContractsPortfolioView load={load} today={today} />);
            await screen.findByText("Vigente Alfa");
            expect(screen.getByText("Análise")).toBeVisible();
            expect(screen.getAllByText("Duda")).toHaveLength(3);
            expect(screen.getByText("Sem responsável", { selector: "span" })).toBeVisible();
        });

        it("narrows by owner and by search, and says so when nothing is left", async () => {
            const user = userEvent.setup();
            render(<ContractsPortfolioView load={load} today={today} />);
            await screen.findByText("Vigente Alfa");
            await user.selectOptions(screen.getByLabelText("Responsável"), "Duda");
            expect(names()).toEqual(["Vigente Alfa", "Andando Delta"]);
            await user.type(screen.getByLabelText("Buscar contrato"), "delta");
            expect(names()).toEqual(["Andando Delta"]);
            await user.selectOptions(screen.getByLabelText("Responsável"), "__sem__");
            expect(await screen.findByText("Nenhum contrato nesse filtro")).toBeVisible();
            await user.click(screen.getByRole("button", { name: "Limpar filtros" }));
            expect(names()).toHaveLength(4);
        });

        it("exports exactly what the filters leave", async () => {
            const user = userEvent.setup();
            vi.mocked(downloadBlob).mockClear();
            render(<ContractsPortfolioView load={load} today={today} />);
            await screen.findByText("Vigente Alfa");
            await user.click(screen.getByRole("button", { name: "Em andamento · 1" }));
            await user.click(screen.getByRole("button", { name: /Exportar \(1\)/ }));
            expect(downloadBlob).toHaveBeenCalledTimes(1);
            const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0];
            expect(filename).toBe("contratos.csv");
            const text = await new Response(blob).text();
            expect(text).toContain("Andando Delta");
            expect(text).not.toContain("Vigente Alfa");
        });

        it("offers no filters before there is a list", async () => {
            render(<ContractsPortfolioView load={async () => ({ status: "ok", rows: [] })} today={today} />);
            await screen.findByText("Nenhum contrato ainda");
            expect(screen.queryByLabelText("Buscar contrato")).not.toBeInTheDocument();
        });
    });
});
