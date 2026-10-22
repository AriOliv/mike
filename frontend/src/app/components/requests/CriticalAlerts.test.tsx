import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ listCriticalAlerts: vi.fn() }));
vi.mock("@/app/lib/mikeApi", () => api);

import { CriticalAlertBanner, CriticalAlertsStrip } from "./CriticalAlerts";

const NOW = Date.parse("2026-10-22T15:00:00Z");

beforeEach(() => api.listCriticalAlerts.mockReset());

describe("CriticalAlertsStrip", () => {
    it("lists each request with a critical risk, links to it, and says it is an AI draft", async () => {
        api.listCriticalAlerts.mockResolvedValue({
            alerts: [
                { request_id: "r1", code: "LEG-0007", title: "Nuvem Fictícia", project_id: "p1", alerted_at: "2026-10-22T13:00:00Z", critical: 2, assignee_name: "Duda" },
                { request_id: "r2", code: "LEG-0009", title: "Outro", project_id: null, alerted_at: "2026-10-22T14:00:00Z", critical: 1, assignee_name: null },
            ],
        });
        render(<CriticalAlertsStrip now={NOW} />);
        expect(await screen.findByText("2 pedidos com risco crítico")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /LEG-0007/ })).toHaveAttribute("href", "/pedidos?pedido=r1");
        expect(screen.getByText(/2 riscos críticos · com Duda/)).toBeInTheDocument();
        expect(screen.getByText(/1 risco crítico · sem responsável/)).toBeInTheDocument();
        expect(screen.getByText("Análise gerada por IA, não é parecer. Revise antes de decidir.")).toBeInTheDocument();
    });

    it("says it in the singular, and shows nothing when there is no alert or the call fails", async () => {
        api.listCriticalAlerts.mockResolvedValueOnce({
            alerts: [{ request_id: "r1", code: "LEG-0001", title: "x", project_id: null, alerted_at: "2026-10-22T13:00:00Z", critical: 0, assignee_name: null }],
        });
        const { unmount } = render(<CriticalAlertsStrip now={NOW} />);
        expect(await screen.findByText("1 pedido com risco crítico")).toBeInTheDocument();
        expect(screen.getByText(/^risco crítico · sem responsável/)).toBeInTheDocument();
        unmount();

        api.listCriticalAlerts.mockResolvedValueOnce({ alerts: [] });
        const empty = render(<CriticalAlertsStrip />);
        await waitFor(() => expect(api.listCriticalAlerts).toHaveBeenCalledTimes(2));
        expect(empty.container).toBeEmptyDOMElement();
        empty.unmount();

        api.listCriticalAlerts.mockRejectedValueOnce(new Error("403"));
        const failed = render(<CriticalAlertsStrip />);
        await waitFor(() => expect(api.listCriticalAlerts).toHaveBeenCalledTimes(3));
        expect(failed.container).toBeEmptyDOMElement();
    });
});

describe("CriticalAlertBanner", () => {
    it("says how many critical risks, that the Head was told in the app, and that it is a draft", () => {
        const { rerender } = render(<CriticalAlertBanner critical={3} />);
        expect(screen.getByRole("status")).toHaveTextContent(
            "A análise do contrato encontrou 3 riscos críticos. A liderança do Legal foi avisada no Mike. É um rascunho de IA: revise antes de decidir.",
        );
        rerender(<CriticalAlertBanner critical={1} />);
        expect(screen.getByRole("status")).toHaveTextContent("encontrou 1 risco crítico.");
    });
});
