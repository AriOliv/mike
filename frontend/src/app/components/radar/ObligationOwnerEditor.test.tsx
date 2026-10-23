import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Obligation, ObligationOwner } from "@/app/lib/mikeApi";

const api = vi.hoisted(() => ({ updateObligation: vi.fn() }));
vi.mock("@/app/lib/mikeApi", async (actual) => ({
    ...(await actual<typeof import("@/app/lib/mikeApi")>()),
    ...api,
}));
const toasts = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("@/app/components/ui/toast", () => toasts);
const errors = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock("@/app/lib/userFacingError", async (actual) => ({
    ...(await actual<typeof import("@/app/lib/userFacingError")>()),
    ...errors,
}));

import { ObligationOwnerEditor } from "./ObligationOwnerEditor";

const item: Obligation = {
    id: "o1",
    project_id: null,
    title: "Aviso",
    mark: "critico",
    due_date: "2026-12-01",
    done: false,
    note: null,
    source_quote: null,
    owner_email: null,
    alert_days: 30,
    kind: "manual",
    status: "aberto",
};
const people: ObligationOwner[] = [
    { user_id: "b", email: "bia@x.io", name: "Bia" },
    { user_id: "c", email: "caio@x.io", name: "Caio" },
];
const open = () => fireEvent.click(screen.getByRole("button"));
const renderEditor = (over: Partial<Obligation> = {}, onSaved = () => undefined) =>
    render(<ObligationOwnerEditor item={{ ...item, ...over }} people={people} onSaved={onSaved} />);

beforeEach(() => {
    api.updateObligation.mockReset();
    toasts.showToast.mockReset();
    errors.notifyError.mockReset();
});

describe("ObligationOwnerEditor", () => {
    it("shows who owns it, by name, and how early it warns", () => {
        renderEditor({ owner_email: "bia@x.io" });
        expect(screen.getByRole("button", { name: "Bia · avisa 30 dias antes" })).toBeTruthy();
    });

    it("offers 'Sem responsável' first, then the team", () => {
        renderEditor();
        open();
        const names = Array.from(screen.getByLabelText("Responsável").querySelectorAll("option")).map((o) => o.textContent);
        expect(names).toEqual(["Sem responsável", "Bia", "Caio"]);
    });

    it("keeps an owner who left the team selectable instead of dropping them", () => {
        renderEditor({ owner_email: "saiu@x.io" });
        open();
        expect((screen.getByLabelText("Responsável") as HTMLSelectElement).value).toBe("saiu@x.io");
    });

    it("saves the chosen person and lead time, then thanks with an Undo", async () => {
        api.updateObligation.mockResolvedValue({ ...item, owner_email: "bia@x.io", alert_days: 7 });
        const onSaved = vi.fn();
        renderEditor({}, onSaved);
        open();
        fireEvent.change(screen.getByLabelText("Responsável"), { target: { value: "bia@x.io" } });
        fireEvent.change(screen.getByLabelText("Avisar antes"), { target: { value: "7" } });
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(api.updateObligation).toHaveBeenCalledWith("o1", { owner_email: "bia@x.io", alert_days: 7 });
        expect(screen.queryByRole("button", { name: "Salvar" })).toBeNull();
        expect(toasts.showToast.mock.calls[0][0]).toMatchObject({ tone: "success", message: "Responsável atualizado." });
    });

    it("undoes the change from the toast, putting the old values back", async () => {
        api.updateObligation.mockResolvedValue(item);
        renderEditor({ owner_email: "bia@x.io", alert_days: 15 });
        open();
        fireEvent.change(screen.getByLabelText("Responsável"), { target: { value: "caio@x.io" } });
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        await waitFor(() => expect(toasts.showToast).toHaveBeenCalled());
        await toasts.showToast.mock.calls[0][0].actions[0].onClick();
        expect(api.updateObligation).toHaveBeenLastCalledWith("o1", { owner_email: "bia@x.io", alert_days: 15 });
    });

    it("reports a failed Undo instead of swallowing it", async () => {
        api.updateObligation.mockResolvedValueOnce(item).mockRejectedValueOnce(new Error("offline"));
        renderEditor();
        open();
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        await waitFor(() => expect(toasts.showToast).toHaveBeenCalled());
        await toasts.showToast.mock.calls[0][0].actions[0].onClick();
        expect(errors.notifyError).toHaveBeenCalledWith(expect.any(Error), { lang: "pt", action: "desfazer a mudança" });
    });

    it("says the owner was removed when 'Sem responsável' is saved", async () => {
        api.updateObligation.mockResolvedValue(item);
        renderEditor({ owner_email: "bia@x.io" });
        open();
        fireEvent.change(screen.getByLabelText("Responsável"), { target: { value: "" } });
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        await waitFor(() => expect(api.updateObligation).toHaveBeenCalledWith("o1", { owner_email: null, alert_days: 30 }));
        await waitFor(() => expect(toasts.showToast.mock.calls[0][0].message).toBe("Responsável removido."));
    });

    it("opens a number field for 'Outro…' and takes a custom lead time", async () => {
        api.updateObligation.mockResolvedValue(item);
        renderEditor();
        open();
        fireEvent.change(screen.getByLabelText("Avisar antes"), { target: { value: "outro" } });
        fireEvent.change(screen.getByLabelText("Dias"), { target: { value: "17" } });
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        await waitFor(() => expect(api.updateObligation).toHaveBeenCalledWith("o1", { owner_email: null, alert_days: 17 }));
    });

    it("starts on 'Outro…' when the saved lead time is not one of the choices", () => {
        renderEditor({ alert_days: 17 });
        open();
        expect((screen.getByLabelText("Avisar antes") as HTMLSelectElement).value).toBe("outro");
        expect((screen.getByLabelText("Dias") as HTMLInputElement).value).toBe("17");
    });

    it("refuses a bad custom lead time without calling the API", () => {
        renderEditor({ alert_days: 17 });
        open();
        fireEvent.change(screen.getByLabelText("Dias"), { target: { value: "999" } });
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        expect(screen.getByText("Use um número de dias entre 0 e 365.")).toBeTruthy();
        expect(api.updateObligation).not.toHaveBeenCalled();
    });

    it("shows the server's message when saving fails, and Cancel closes", async () => {
        api.updateObligation.mockRejectedValueOnce(new Error("Não encontrei essa pessoa no time do Legal."));
        renderEditor();
        open();
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        expect(await screen.findByText("Não encontrei essa pessoa no time do Legal.")).toBeTruthy();
        expect(toasts.showToast).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
        expect(screen.queryByRole("button", { name: "Salvar" })).toBeNull();
    });

    it("falls back to a generic message for a non-Error failure", async () => {
        api.updateObligation.mockRejectedValueOnce("x");
        renderEditor();
        open();
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        expect(await screen.findByText("Não foi possível salvar.")).toBeTruthy();
    });
});
