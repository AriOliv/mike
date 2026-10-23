import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RadarPage from "./page";

const state = vi.hoisted(() => ({
    getObligations: vi.fn(),
    updateObligation: vi.fn(),
    push: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/app/lib/mikeApi", () => ({
    getObligations: state.getObligations,
    updateObligation: state.updateObligation,
}));
vi.mock("@/app/components/shared/PageHeader", () => ({
    PageHeader: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
}));

function dayOffset(days: number): string {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + days);
    const m = `${d.getMonth() + 1}`.padStart(2, "0");
    const day = `${d.getDate()}`.padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
}

function obligation(id: string, days: number, mark = "critico") {
    return {
        id,
        title: `Prazo ${id}`,
        mark,
        due_date: dayOffset(days),
        done: false,
        project_id: null,
        projects: null,
        source_quote: null,
    };
}

describe("RadarPage (Prazos)", () => {
    beforeEach(() => {
        state.getObligations.mockReset();
        state.updateObligation.mockReset();
    });

    it("shows the deadline groups, marks and countdowns in Portuguese", async () => {
        state.getObligations.mockResolvedValue([
            obligation("a", -2),
            obligation("b", 0, "tarefa"),
            obligation("c", 7, "recorrente"),
            obligation("d", 45),
            obligation("e", 200),
        ]);
        render(<RadarPage />);

        expect(await screen.findByRole("heading", { name: "Prazos" })).toBeInTheDocument();
        expect(screen.getByText(/^Vencidos · 1$/)).toBeInTheDocument();
        expect(screen.getByText(/^Próximos 30 dias · 2$/)).toBeInTheDocument();
        expect(screen.getByText(/^31 a 90 dias · 1$/)).toBeInTheDocument();
        expect(screen.getByText(/^Mais adiante · 1$/)).toBeInTheDocument();
        expect(screen.getByText("venceu há 2 d")).toBeInTheDocument();
        // The date reads dd/mm/aaaa like the rest of the app, not the stored ISO.
        const iso = dayOffset(-2);
        const [y, m, d] = iso.split("-");
        expect(screen.getByText(`${d}/${m}/${y}`)).toBeInTheDocument();
        expect(screen.queryByText(iso)).not.toBeInTheDocument();
        expect(screen.getByText("vence hoje")).toBeInTheDocument();
        expect(screen.getByText("em 7 d")).toBeInTheDocument();
        expect(screen.getAllByText("crítico").length).toBeGreaterThan(0);
        expect(screen.getByText("recorrente")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Lista" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Calendário" })).toBeInTheDocument();
    });

    it("explains the empty state in Portuguese", async () => {
        state.getObligations.mockResolvedValue([]);
        render(<RadarPage />);
        expect(
            await screen.findByText(/Nenhum prazo à vista/),
        ).toBeInTheDocument();
    });

    it("marks a deadline done and keeps the list in sync", async () => {
        state.getObligations.mockResolvedValue([obligation("a", 3)]);
        state.updateObligation.mockResolvedValue(undefined);
        render(<RadarPage />);
        fireEvent.click(await screen.findByTitle("Marcar como feito"));
        await waitFor(() =>
            expect(state.updateObligation).toHaveBeenCalledWith("a", { done: true }),
        );
        expect(screen.queryByText("Prazo a")).not.toBeInTheDocument();
    });

    it("reports a failed update in Portuguese and restores the row", async () => {
        state.getObligations.mockResolvedValue([obligation("a", 3)]);
        state.updateObligation.mockRejectedValue("falha");
        render(<RadarPage />);
        fireEvent.click(await screen.findByTitle("Marcar como feito"));
        expect(await screen.findByText("Não consegui atualizar o prazo.")).toBeInTheDocument();
        expect(screen.getByText("Prazo a")).toBeInTheDocument();
    });

    it("switches to the calendar with Portuguese weekday labels", async () => {
        state.getObligations.mockResolvedValue([]);
        render(<RadarPage />);
        fireEvent.click(await screen.findByRole("button", { name: "Calendário" }));
        expect(await screen.findByText("sáb")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Hoje" })).toBeInTheDocument();
        expect(screen.getByLabelText("Mês anterior")).toBeInTheDocument();
    });
});
