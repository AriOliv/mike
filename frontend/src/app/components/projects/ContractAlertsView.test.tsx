import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContractAlert, LinkedAmendment } from "@/app/lib/mikeApi";

vi.mock("@/app/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "u", email: "Ana@Avenia.io" } }) }));
const api = vi.hoisted(() => ({
    getContractAlerts: vi.fn(),
    getContractAmendments: vi.fn(),
    getObligationOwners: vi.fn(),
    updateObligation: vi.fn(),
    downloadObligationIcs: vi.fn(),
}));
vi.mock("@/app/lib/mikeApi", async (actual) => ({ ...(await actual<typeof import("@/app/lib/mikeApi")>()), ...api }));
const download = vi.hoisted(() => ({ downloadBlob: vi.fn() }));
vi.mock("@/app/lib/downloadDocument", () => download);
vi.mock("@/app/components/ui/toast", () => ({ showToast: vi.fn() }));
const errors = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock("@/app/lib/userFacingError", async (actual) => ({ ...(await actual<typeof import("@/app/lib/userFacingError")>()), ...errors }));

import { ContractAlertsView } from "./ContractAlertsView";

const alert = (over: Partial<ContractAlert> = {}): ContractAlert => ({
    id: "o1",
    project_id: "p1",
    title: "Prazo limite para avisar não renovação (30 dias de aviso prévio)",
    mark: "critico",
    due_date: "2026-12-31",
    done: false,
    note: null,
    source_quote: "Cláusula 9",
    owner_email: null,
    alert_days: 30,
    kind: "aviso_previo",
    status: "aberto",
    days_left: 12,
    ...over,
});
const team = [{ user_id: "b", email: "bia@avenia.io", name: "Bia" }];

beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.getObligationOwners.mockResolvedValue(team);
    api.getContractAmendments.mockResolvedValue([]);
    download.downloadBlob.mockReset();
    errors.notifyError.mockReset();
});

const amendment = (over: Partial<LinkedAmendment> = {}): LinkedAmendment => ({
    id: "req-1",
    code: "LEG-0042",
    title: "Aditivo de prazo",
    status: "entregue",
    delivered_at: "2026-11-03T12:00:00Z",
    term_end: "2028-01-05",
    ...over,
});

describe("amendments tied to the contract", () => {
    it("lists each one with a link to its request, where it stands and the term it sets", async () => {
        api.getContractAlerts.mockResolvedValue([alert()]);
        api.getContractAmendments.mockResolvedValue([amendment(), amendment({ id: "req-2", code: "LEG-0050", title: "Aditivo de valor", status: "em_andamento", delivered_at: null, term_end: null })]);
        render(<ContractAlertsView projectId="p1" />);
        const section = await screen.findByRole("region", { name: "Aditivos deste contrato" });
        expect(within(section).getByRole("link", { name: "LEG-0042 · Aditivo de prazo" }).getAttribute("href")).toBe("/pedidos/req-1");
        expect(within(section).getByText("Entregue em 03/11/2026 · define o fim da vigência em 05/01/2028")).toBeTruthy();
        expect(within(section).getByRole("link", { name: "LEG-0050 · Aditivo de valor" }).getAttribute("href")).toBe("/pedidos/req-2");
        expect(within(section).getByText("Em análise")).toBeTruthy();
        expect(api.getContractAmendments).toHaveBeenCalledWith("p1");
    });

    it("shows no section when there are none", async () => {
        api.getContractAlerts.mockResolvedValue([alert()]);
        render(<ContractAlertsView projectId="p1" />);
        await screen.findByText("Aviso prévio");
        expect(screen.queryByRole("region", { name: "Aditivos deste contrato" })).toBeNull();
    });

    it("shows them even when the contract has no deadline yet", async () => {
        api.getContractAlerts.mockResolvedValue([]);
        api.getContractAmendments.mockResolvedValue([amendment({ status: "novo", delivered_at: null, term_end: null })]);
        render(<ContractAlertsView projectId="p1" />);
        expect(await screen.findByRole("region", { name: "Aditivos deste contrato" })).toBeTruthy();
        expect(screen.getByText(/ainda não tem alertas/)).toBeTruthy();
    });

    it("still lists the deadlines when the amendments cannot be loaded", async () => {
        api.getContractAlerts.mockResolvedValue([alert()]);
        api.getContractAmendments.mockRejectedValueOnce(new Error("down"));
        render(<ContractAlertsView projectId="p1" />);
        expect(await screen.findByText("Aviso prévio")).toBeTruthy();
        expect(screen.queryByRole("region", { name: "Aditivos deste contrato" })).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
    });
});

describe("ContractAlertsView", () => {
    it("lists the contract's deadlines with what each is, how soon, and its quote", async () => {
        api.getContractAlerts.mockResolvedValue([alert(), alert({ id: "o2", kind: "vigencia", title: "Fim da vigência", due_date: "2027-01-31", days_left: 43, source_quote: null })]);
        render(<ContractAlertsView projectId="p1" />);
        expect(await screen.findByText("Aviso prévio")).toBeTruthy();
        expect(screen.getByText("Fim da vigência", { selector: "span.rounded" })).toBeTruthy();
        expect(screen.getByText("2026-12-31 · vence em 12 dias")).toBeTruthy();
        expect(screen.getByText("Cláusula 9")).toBeTruthy();
        expect(api.getContractAlerts).toHaveBeenCalledWith("p1");
    });

    it("puts open deadlines before closed ones", async () => {
        api.getContractAlerts.mockResolvedValue([
            alert({ id: "done", status: "feito", title: "Já feito", due_date: "2026-10-01" }),
            alert({ id: "open", title: "Em aberto", due_date: "2026-12-01" }),
        ]);
        render(<ContractAlertsView projectId="p1" />);
        await screen.findByText("Em aberto");
        const rows = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
        expect(rows[0]).toContain("Em aberto");
        expect(rows[1]).toContain("Já feito");
    });

    it("shows red only on an open deadline that is overdue", async () => {
        api.getContractAlerts.mockResolvedValue([
            alert({ id: "late", days_left: -3, due_date: "2026-10-01" }),
            alert({ id: "closed-late", status: "feito", days_left: -9, due_date: "2026-09-01" }),
        ]);
        render(<ContractAlertsView projectId="p1" />);
        const late = await screen.findByText(/2026-10-01 · venceu há 3 dias/);
        expect(late.className).toContain("text-red-700");
        const closed = screen.getByText("2026-09-01");
        expect(closed.className).not.toContain("text-red-700");
    });

    it("explains an empty contract", async () => {
        api.getContractAlerts.mockResolvedValue([]);
        render(<ContractAlertsView projectId="p1" />);
        expect(await screen.findByText(/Este contrato ainda não tem alertas/)).toBeTruthy();
    });

    it("says why when it cannot load", async () => {
        api.getContractAlerts.mockRejectedValueOnce(new Error("offline"));
        render(<ContractAlertsView projectId="p1" />);
        const notice = await screen.findByRole("alert");
        expect((notice.textContent ?? "").trim().length).toBeGreaterThan(0);
        expect(screen.queryByRole("list")).toBeNull();
    });

    it("still lists the deadlines for someone off the team", async () => {
        api.getObligationOwners.mockRejectedValueOnce(new Error("403"));
        api.getContractAlerts.mockResolvedValue([alert()]);
        render(<ContractAlertsView projectId="p1" />);
        expect(await screen.findByText("Aviso prévio")).toBeTruthy();
    });

    it("closes a deadline with Dar baixa and reloads", async () => {
        api.getContractAlerts.mockResolvedValue([alert()]);
        api.updateObligation.mockResolvedValue(alert({ status: "feito" }));
        render(<ContractAlertsView projectId="p1" />);
        fireEvent.click(await screen.findByRole("button", { name: /Dar baixa/ }));
        await waitFor(() => expect(api.updateObligation).toHaveBeenCalledWith("o1", { status: "feito" }));
        await waitFor(() => expect(api.getContractAlerts).toHaveBeenCalledTimes(2));
    });

    it("dismisses a deadline", async () => {
        api.getContractAlerts.mockResolvedValue([alert()]);
        api.updateObligation.mockResolvedValue(alert({ status: "dispensado" }));
        render(<ContractAlertsView projectId="p1" />);
        fireEvent.click(await screen.findByRole("button", { name: /Dispensar/ }));
        await waitFor(() => expect(api.updateObligation).toHaveBeenCalledWith("o1", { status: "dispensado" }));
    });

    it("reopens a closed deadline instead of offering to close it again", async () => {
        api.getContractAlerts.mockResolvedValue([alert({ status: "dispensado" })]);
        api.updateObligation.mockResolvedValue(alert());
        render(<ContractAlertsView projectId="p1" />);
        expect(await screen.findByRole("button", { name: /Reabrir/ })).toBeTruthy();
        expect(screen.queryByRole("button", { name: /Dar baixa/ })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: /Reabrir/ }));
        await waitFor(() => expect(api.updateObligation).toHaveBeenCalledWith("o1", { status: "aberto" }));
    });

    it("reports a failed update in Portuguese and keeps the list", async () => {
        api.getContractAlerts.mockResolvedValue([alert()]);
        api.updateObligation.mockRejectedValueOnce(new Error("down"));
        render(<ContractAlertsView projectId="p1" />);
        fireEvent.click(await screen.findByRole("button", { name: /Dar baixa/ }));
        await waitFor(() => expect(errors.notifyError).toHaveBeenCalledWith(expect.any(Error), { lang: "pt", action: "atualizar o alerta" }));
        expect(screen.getByText("Aviso prévio")).toBeTruthy();
    });

    it("creates the event as a downloaded calendar file", async () => {
        const blob = new Blob(["BEGIN:VCALENDAR"]);
        api.getContractAlerts.mockResolvedValue([alert()]);
        api.downloadObligationIcs.mockResolvedValue({ blob, filename: "prazo-2026-12-31.ics" });
        render(<ContractAlertsView projectId="p1" />);
        fireEvent.click(await screen.findByRole("button", { name: /Criar evento/ }));
        await waitFor(() => expect(download.downloadBlob).toHaveBeenCalledWith(blob, "prazo-2026-12-31.ics"));
        expect(api.downloadObligationIcs).toHaveBeenCalledWith("o1");
    });

    it("reports a failed event in Portuguese", async () => {
        api.getContractAlerts.mockResolvedValue([alert()]);
        api.downloadObligationIcs.mockRejectedValueOnce(new Error("404"));
        render(<ContractAlertsView projectId="p1" />);
        fireEvent.click(await screen.findByRole("button", { name: /Criar evento/ }));
        await waitFor(() => expect(errors.notifyError).toHaveBeenCalledWith(expect.any(Error), { lang: "pt", action: "criar o evento" }));
        expect(download.downloadBlob).not.toHaveBeenCalled();
    });

    it("lets the owner be changed in place, from the team", async () => {
        api.getContractAlerts.mockResolvedValue([alert()]);
        api.updateObligation.mockResolvedValue(alert({ owner_email: "bia@avenia.io" }));
        render(<ContractAlertsView projectId="p1" />);
        const row = (await screen.findByText("Aviso prévio")).closest("li")!;
        fireEvent.click(within(row).getByTitle("Mudar responsável e antecedência"));
        fireEvent.change(screen.getByLabelText("Responsável"), { target: { value: "bia@avenia.io" } });
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        await waitFor(() => expect(api.updateObligation).toHaveBeenCalledWith("o1", { owner_email: "bia@avenia.io", alert_days: 30 }));
        await waitFor(() => expect(api.getContractAlerts).toHaveBeenCalledTimes(2));
    });
});
