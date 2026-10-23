import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Obligation, ObligationAlert } from "@/app/lib/mikeApi";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("@/app/components/ui/toast", () => ({ showToast: vi.fn() }));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "u", email: "Ana@Example.com" } }),
}));
vi.mock("@/app/components/shared/PageHeader", () => ({
    PageHeader: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
}));
const api = vi.hoisted(() => ({
    getObligations: vi.fn(),
    getObligationAlerts: vi.fn(),
    getObligationOwners: vi.fn(),
    updateObligation: vi.fn(),
}));
vi.mock("@/app/lib/mikeApi", async (actual) => ({
    ...(await actual<typeof import("@/app/lib/mikeApi")>()),
    ...api,
}));

import RadarPage from "./page";

const day = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const ob = (over: Partial<Obligation> = {}): Obligation => ({
    id: "o1",
    project_id: null,
    title: "Aviso de não renovação",
    mark: "critico",
    due_date: day(10),
    done: false,
    note: null,
    source_quote: null,
    owner_email: null,
    alert_days: 30,
    ...over,
});
const alertOf = (over: Partial<ObligationAlert> = {}): ObligationAlert => ({ ...ob(), days_left: 10, ...over });

beforeEach(() => {
    api.getObligations.mockReset();
    api.getObligationAlerts.mockReset();
    api.getObligationOwners.mockReset().mockResolvedValue([{ user_id: "b", email: "bia@x.io", name: "Bia" }]);
    api.updateObligation.mockReset();
    nav.push.mockReset();
});

describe("Radar page", () => {
    it("puts the deadlines that ask for attention on top, with how soon", async () => {
        api.getObligations.mockResolvedValue([ob()]);
        api.getObligationAlerts.mockResolvedValue([alertOf({ days_left: -3 }), alertOf({ id: "o2", title: "Renovar", days_left: 0 })]);
        render(<RadarPage />);
        const block = await screen.findByRole("region", { name: "Pedem sua atenção" });
        expect(within(block).getByText("Pedem sua atenção · 2")).toBeTruthy();
        expect(within(block).getByText("venceu há 3 dias")).toBeTruthy();
        expect(within(block).getByText("vence hoje")).toBeTruthy();
    });

    it("says once that nothing asks for attention, instead of hiding the feature", async () => {
        api.getObligations.mockResolvedValue([ob()]);
        api.getObligationAlerts.mockResolvedValue([]);
        render(<RadarPage />);
        await screen.findByText("Aviso de não renovação");
        expect(screen.queryByRole("region", { name: "Pedem sua atenção" })).toBeNull();
        expect(screen.getByText("Nada pede sua atenção agora.")).toBeTruthy();
    });

    it("turns the block red only when something is overdue", async () => {
        api.getObligations.mockResolvedValue([ob()]);
        api.getObligationAlerts.mockResolvedValue([alertOf({ days_left: 3 })]);
        const { unmount } = render(<RadarPage />);
        expect((await screen.findByRole("region", { name: "Pedem sua atenção" })).className).toContain("bg-amber-50");
        unmount();
        api.getObligationAlerts.mockResolvedValue([alertOf({ days_left: -1 })]);
        render(<RadarPage />);
        expect((await screen.findByRole("region", { name: "Pedem sua atenção" })).className).toContain("bg-red-50");
    });

    it("opens the contract from an attention row", async () => {
        api.getObligations.mockResolvedValue([ob({ project_id: "p1" })]);
        api.getObligationAlerts.mockResolvedValue([alertOf({ project_id: "p1", projects: { name: "Contrato X", counterparty: "Acme", lane: null } })]);
        render(<RadarPage />);
        const block = await screen.findByRole("region", { name: "Pedem sua atenção" });
        fireEvent.click(within(block).getByRole("button", { name: /Aviso de não renovação/ }));
        expect(nav.push).toHaveBeenCalledWith("/projects/p1");
    });

    it("does not link an attention row that has no contract", async () => {
        api.getObligations.mockResolvedValue([ob()]);
        api.getObligationAlerts.mockResolvedValue([alertOf()]);
        render(<RadarPage />);
        const block = await screen.findByRole("region", { name: "Pedem sua atenção" });
        expect((within(block).getByRole("button", { name: /Aviso de não renovação/ }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("marks, in the list, the deadlines that are also in the attention block", async () => {
        api.getObligations.mockResolvedValue([ob(), ob({ id: "o2", title: "Outro" })]);
        api.getObligationAlerts.mockResolvedValue([alertOf()]);
        render(<RadarPage />);
        await screen.findByText("em atenção");
        expect(screen.getAllByText("em atenção")).toHaveLength(1);
    });

    it("ticks a deadline off from the attention block", async () => {
        api.getObligations.mockResolvedValue([ob()]);
        api.getObligationAlerts.mockResolvedValue([alertOf()]);
        api.updateObligation.mockResolvedValue(ob({ done: true }));
        render(<RadarPage />);
        const block = await screen.findByRole("region", { name: "Pedem sua atenção" });
        fireEvent.click(within(block).getByTitle("Marcar como feito"));
        await waitFor(() => expect(api.updateObligation).toHaveBeenCalledWith("o1", { done: true }));
    });

    it("words the days in one vocabulary on the list and in the block", async () => {
        api.getObligations.mockResolvedValue([ob({ due_date: day(-2) })]);
        api.getObligationAlerts.mockResolvedValue([alertOf({ days_left: -2 })]);
        render(<RadarPage />);
        await screen.findByRole("region", { name: "Pedem sua atenção" });
        expect(screen.getAllByText("venceu há 2 dias")).toHaveLength(2);
    });

    it("still works for someone off the team, who just has no one to hand a deadline to", async () => {
        api.getObligationOwners.mockRejectedValueOnce(new Error("403"));
        api.getObligations.mockResolvedValue([ob()]);
        api.getObligationAlerts.mockResolvedValue([]);
        render(<RadarPage />);
        expect(await screen.findByText("Aviso de não renovação")).toBeTruthy();
    });

    it("still lists the deadlines when the alerts cannot be loaded", async () => {
        api.getObligations.mockResolvedValue([ob()]);
        api.getObligationAlerts.mockRejectedValueOnce(new Error("down"));
        render(<RadarPage />);
        expect(await screen.findByText("Aviso de não renovação")).toBeTruthy();
    });

    it("shows each deadline's owner, calling the signed-in person 'Você'", async () => {
        api.getObligations.mockResolvedValue([
            ob({ owner_email: "ana@example.com" }),
            ob({ id: "o2", title: "Outro", owner_email: null }),
            ob({ id: "o3", title: "Terceiro", owner_email: "bia@x.io" }),
        ]);
        api.getObligationAlerts.mockResolvedValue([]);
        render(<RadarPage />);
        expect(await screen.findByRole("button", { name: "Você · avisa 30 dias antes" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Sem responsável · avisa 30 dias antes" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Bia · avisa 30 dias antes" })).toBeTruthy();
    });

    it("drops a deadline from the list and the attention block when ticked off", async () => {
        api.getObligations.mockResolvedValue([ob()]);
        api.getObligationAlerts.mockResolvedValue([alertOf()]);
        api.updateObligation.mockResolvedValue(ob({ done: true }));
        render(<RadarPage />);
        await screen.findByRole("region", { name: "Pedem sua atenção" });
        fireEvent.click(screen.getAllByTitle("Marcar como feito")[1]);
        await waitFor(() => expect(screen.queryByRole("region", { name: "Pedem sua atenção" })).toBeNull());
        expect(api.updateObligation).toHaveBeenCalledWith("o1", { done: true });
    });

    it("restores the list and shows the error when the tick fails", async () => {
        api.getObligations.mockResolvedValue([ob()]);
        api.getObligationAlerts.mockResolvedValue([]);
        api.updateObligation.mockRejectedValueOnce(new Error("offline"));
        render(<RadarPage />);
        await screen.findByText("Aviso de não renovação");
        fireEvent.click(screen.getByTitle("Marcar como feito"));
        expect(await screen.findByText("offline")).toBeTruthy();
        expect(screen.getByText("Aviso de não renovação")).toBeTruthy();
    });

    it("reloads the alerts after an owner or lead time changes", async () => {
        api.getObligations.mockResolvedValue([ob()]);
        api.getObligationAlerts.mockResolvedValue([]);
        api.updateObligation.mockResolvedValue(ob({ owner_email: "bia@x.io", alert_days: 5 }));
        render(<RadarPage />);
        fireEvent.click(await screen.findByRole("button", { name: "Sem responsável · avisa 30 dias antes" }));
        fireEvent.change(await screen.findByLabelText("Responsável"), { target: { value: "bia@x.io" } });
        fireEvent.change(screen.getByLabelText("Avisar antes"), { target: { value: "outro" } });
        fireEvent.change(screen.getByLabelText("Dias"), { target: { value: "5" } });
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        await screen.findByRole("button", { name: "Bia · avisa 5 dias antes" });
        expect(api.getObligationAlerts).toHaveBeenCalledTimes(2);
    });

    it("explains an empty radar", async () => {
        api.getObligations.mockResolvedValue([]);
        api.getObligationAlerts.mockResolvedValue([]);
        render(<RadarPage />);
        expect(await screen.findByText(/Nenhum prazo à vista/)).toBeTruthy();
    });

    it("groups the deadlines by how soon they land, with the marks in Portuguese", async () => {
        api.getObligations.mockResolvedValue([
            ob({ id: "a", title: "Prazo a", due_date: day(-2) }),
            ob({ id: "b", title: "Prazo b", due_date: day(0), mark: "tarefa" }),
            ob({ id: "c", title: "Prazo c", due_date: day(7), mark: "recorrente" }),
            ob({ id: "d", title: "Prazo d", due_date: day(45) }),
            ob({ id: "e", title: "Prazo e", due_date: day(200) }),
        ]);
        api.getObligationAlerts.mockResolvedValue([]);
        render(<RadarPage />);
        expect(await screen.findByRole("heading", { name: "Prazos" })).toBeInTheDocument();
        expect(screen.getByText(/^Vencidos · 1$/)).toBeInTheDocument();
        expect(screen.getByText(/^Próximos 30 dias · 2$/)).toBeInTheDocument();
        expect(screen.getByText(/^31 a 90 dias · 1$/)).toBeInTheDocument();
        expect(screen.getByText(/^Mais adiante · 1$/)).toBeInTheDocument();
        // The date reads dd/mm/aaaa like the rest of the app, not the stored ISO.
        const iso = day(-2);
        const [y, m, d] = iso.split("-");
        expect(screen.getByText(`${d}/${m}/${y}`)).toBeInTheDocument();
        expect(screen.queryByText(iso)).not.toBeInTheDocument();
        expect(screen.getAllByText("crítico").length).toBeGreaterThan(0);
        expect(screen.getByText("tarefa")).toBeInTheDocument();
        expect(screen.getByText("recorrente")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Lista" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Calendário" })).toBeInTheDocument();
    });

    it("switches to the calendar with Portuguese weekday labels", async () => {
        api.getObligations.mockResolvedValue([]);
        api.getObligationAlerts.mockResolvedValue([]);
        render(<RadarPage />);
        fireEvent.click(await screen.findByRole("button", { name: "Calendário" }));
        expect(await screen.findByText("sáb")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Hoje" })).toBeInTheDocument();
        expect(screen.getByLabelText("Mês anterior")).toBeInTheDocument();
    });
});
