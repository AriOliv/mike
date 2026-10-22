import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Obligation } from "@/app/lib/mikeApi";

const api = vi.hoisted(() => ({ updateObligation: vi.fn() }));
vi.mock("@/app/lib/mikeApi", async (actual) => ({
    ...(await actual<typeof import("@/app/lib/mikeApi")>()),
    ...api,
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
};

beforeEach(() => api.updateObligation.mockReset());

describe("ObligationOwnerEditor", () => {
    it("shows who owns it and how early it warns", () => {
        render(<ObligationOwnerEditor item={item} onSaved={() => undefined} />);
        expect(screen.getByRole("button", { name: "Sem responsável · avisa 30 dias antes" })).toBeTruthy();
    });

    it("saves the owner and the lead time, then closes", async () => {
        api.updateObligation.mockResolvedValue({ ...item, owner_email: "bia@x.io", alert_days: 7 });
        const onSaved = vi.fn();
        render(<ObligationOwnerEditor item={item} onSaved={onSaved} />);
        fireEvent.click(screen.getByRole("button"));
        fireEvent.change(screen.getByLabelText("Responsável (e-mail)"), { target: { value: " bia@x.io " } });
        fireEvent.change(screen.getByLabelText("Avisar antes (dias)"), { target: { value: "7" } });
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(api.updateObligation).toHaveBeenCalledWith("o1", { owner_email: "bia@x.io", alert_days: 7 });
        expect(onSaved.mock.calls[0][0]).toMatchObject({ owner_email: "bia@x.io", alert_days: 7 });
        expect(screen.queryByRole("button", { name: "Salvar" })).toBeNull();
    });

    it("clears the owner when the field is empty", async () => {
        api.updateObligation.mockResolvedValue(item);
        render(<ObligationOwnerEditor item={{ ...item, owner_email: "bia@x.io" }} onSaved={() => undefined} />);
        fireEvent.click(screen.getByRole("button"));
        fireEvent.change(screen.getByLabelText("Responsável (e-mail)"), { target: { value: "" } });
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        await waitFor(() => expect(api.updateObligation).toHaveBeenCalled());
        expect(api.updateObligation).toHaveBeenCalledWith("o1", { owner_email: null, alert_days: 30 });
    });

    it("refuses a bad lead time without calling the API", () => {
        render(<ObligationOwnerEditor item={item} onSaved={() => undefined} />);
        fireEvent.click(screen.getByRole("button"));
        fireEvent.change(screen.getByLabelText("Avisar antes (dias)"), { target: { value: "999" } });
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        expect(screen.getByText("Use um número de dias entre 0 e 365.")).toBeTruthy();
        expect(api.updateObligation).not.toHaveBeenCalled();
    });

    it("shows the server's message when saving fails, and Cancel closes", async () => {
        api.updateObligation.mockRejectedValueOnce(new Error("Informe o e-mail de quem cuida do prazo."));
        render(<ObligationOwnerEditor item={item} onSaved={() => undefined} />);
        fireEvent.click(screen.getByRole("button"));
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        expect(await screen.findByText("Informe o e-mail de quem cuida do prazo.")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
        expect(screen.queryByRole("button", { name: "Salvar" })).toBeNull();
    });

    it("falls back to a generic message for a non-Error failure", async () => {
        api.updateObligation.mockRejectedValueOnce("x");
        render(<ObligationOwnerEditor item={item} onSaved={() => undefined} />);
        fireEvent.click(screen.getByRole("button"));
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        expect(await screen.findByText("Não foi possível salvar.")).toBeTruthy();
    });
});
