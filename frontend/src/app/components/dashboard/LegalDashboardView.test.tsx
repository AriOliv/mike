import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LegalDashboard } from "@/app/lib/mikeApi";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push }), usePathname: () => "/painel" }));
vi.mock("@/app/contexts/PageChromeContext", () => ({ usePageChrome: () => ({ mobileActionsContainer: null }) }));
const workspace = vi.hoisted(() => ({ workspaceId: "o1" }));
vi.mock("@/app/contexts/WorkspaceContext", () => ({ useWorkspace: () => workspace }));
const api = vi.hoisted(() => ({ getLegalDashboard: vi.fn() }));
vi.mock("@/app/lib/mikeApi", async (actual) => ({ ...(await actual<typeof import("@/app/lib/mikeApi")>()), ...api }));

import { LegalDashboardView } from "./LegalDashboardView";
import { niceMax } from "./charts";

const data: LegalDashboard = {
    period_days: 90,
    generated_at: "2026-10-20T12:00:00Z",
    volume: {
        opened: 12,
        closed: 9,
        open: 7,
        weekly: [
            { week: "2026-10-05", opened: 3, closed: 1 },
            { week: "2026-10-12", opened: 5, closed: 4 },
        ],
        by_type: [{ label: "NDA", count: 5 }],
        by_requester: [{ label: "Comercial", count: 7 }],
    },
    cycle: {
        median_days_to_close: 6.5,
        closed_measured: 9,
        stage_age: [{ lane: "revisao", open: 3, median_days: 4 }],
        per_stage_history: [{ lane: "revisao", moves: 5, median_days: 2.5 }],
        per_stage_moves: 5,
    },
    sla: { closed_with_deadline: 8, on_time: 7, rate: 87.5, open_overdue: 1 },
    notice: { due_in_30_days: 2, missed_in_period: 0 },
    ficha: { contracts: 4, fields: 60, verified: 45, rate: 75 },
    agents: {
        contracts_reviewed_by_agents: 6,
        contracts_reviewed_by_people: 2,
        playbook_runs: 5,
        terms_extracted: 8,
        regulatory_changes_triaged: 14,
        regulatory_turned_into_work: 3,
    },
    hours_saved: {
        hours: 14.5,
        formula: "6 revisões × 90 min + 8 extrações de prazos × 20 min + 14 mudanças regulatórias × 15 min",
        assumptions: { minutes_per_review: 90, minutes_per_terms: 20, minutes_per_regulatory_triage: 15 },
    },
    adoption: { people: [{ email: "duda@avenia.io", assigned_open: 2, closed: 5, reviews_run: 0 }], reviews_by_user_id: [] },
    ai_cost: { total_usd: 3.2, runs: 12, per_contract_usd: 0.4, by_agent: [{ agent: "revisor", usd: 3.2 }] },
};

beforeEach(() => {
    vi.clearAllMocks();
    api.getLegalDashboard.mockResolvedValue(data);
});

describe("LegalDashboardView", () => {
    it("reads the active workspace, the same cut as the Início", async () => {
        render(<LegalDashboardView />);
        await screen.findByText("Pedidos recebidos");
        expect(api.getLegalDashboard).toHaveBeenCalledWith(expect.objectContaining({ period: 90, workspace: "o1" }));
    });

    it("leads with the team's work, then what the agents did", async () => {
        render(<LegalDashboardView />);
        expect(await screen.findByText("Pedidos recebidos")).toBeInTheDocument();
        expect(screen.getByText("1 em aberto já passou do prazo")).toBeInTheDocument();
        expect(screen.getByText("Contratos revisados por agentes")).toBeInTheDocument();
        expect(screen.getByText(/US\$\s?3,20 no período/)).toBeInTheDocument();
        expect(screen.getByText("Agente de revisão")).toBeInTheDocument();
        expect(screen.getByText("Campos da Ficha verificados")).toBeInTheDocument();
        expect(screen.getByText("75%")).toBeInTheDocument();
        expect(screen.getAllByText(/6 revisões × 90 min/)).toHaveLength(2);
        expect(screen.getByText("duda")).toBeInTheDocument();
    });

    it("refetches for another period and with the team's own assumptions", async () => {
        render(<LegalDashboardView />);
        await screen.findByText("Pedidos recebidos");
        fireEvent.click(screen.getByRole("button", { name: "Últimos 30 dias" }));
        await waitFor(() => expect(api.getLegalDashboard).toHaveBeenLastCalledWith({ period: 30, assumptions: undefined, workspace: "o1" }));
        fireEvent.change(screen.getByLabelText(/min por revisão de contrato/), { target: { value: "60" } });
        fireEvent.click(screen.getByRole("button", { name: "Recalcular" }));
        await waitFor(() =>
            expect(api.getLegalDashboard).toHaveBeenLastCalledWith({
                period: 30,
                assumptions: { minutes_per_review: 60, minutes_per_terms: 20, minutes_per_regulatory_triage: 15 },
                workspace: "o1",
            }),
        );
    });

    it("gives every chart a table twin and a tooltip on focus", async () => {
        render(<LegalDashboardView />);
        const chart = (await screen.findByText("Pedidos por semana")).closest("figure")!;
        fireEvent.focus(within(chart).getByLabelText("Semana de 12/10: 5 entradas, 4 concluídos"));
        expect(within(chart).getByRole("status")).toHaveTextContent("Semana de 12/10");
        fireEvent.click(within(chart).getByRole("button", { name: "Ver tabela" }));
        expect(within(chart).getByRole("table")).toHaveTextContent("12/10");
    });

    it("teaches the next step on an empty base", async () => {
        api.getLegalDashboard.mockResolvedValue({
            ...data,
            volume: { ...data.volume, opened: 0, closed: 0, open: 0 },
            adoption: { people: [], reviews_by_user_id: [] },
            ai_cost: null,
        });
        render(<LegalDashboardView />);
        fireEvent.click(await screen.findByRole("button", { name: "Abrir a esteira" }));
        expect(screen.queryByText(/US\$/)).toBeNull();
        expect(nav.push).toHaveBeenCalledWith("/pipeline");
    });

    it("shows a failure with a way to retry", async () => {
        api.getLegalDashboard.mockRejectedValueOnce(new Error("boom"));
        render(<LegalDashboardView />);
        fireEvent.click(await screen.findByRole("button", { name: "Tentar de novo" }));
        expect(await screen.findByText("Pedidos recebidos")).toBeInTheDocument();
    });
});

describe("niceMax", () => {
    it("rounds the axis top to a clean number", () => {
        expect(niceMax(3)).toBe(4);
        expect(niceMax(7)).toBe(10);
        expect(niceMax(23)).toBe(25);
        expect(niceMax(140)).toBe(200);
        expect(niceMax(100)).toBe(100);
    });
});
