import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentSuggestion } from "./AgentSuggestion";

function setup(overrides: Partial<Parameters<typeof AgentSuggestion>[0]> = {}) {
    const handlers = { onAccept: vi.fn(), onEdit: vi.fn(), onReject: vi.fn(), onReopen: vi.fn() };
    render(
        <AgentSuggestion
            agent="Agente de revisão"
            meta="há 2 min · 3 fontes"
            title="Cl. 9 Vigência"
            preview="pelo prazo de 2 anos"
            editableText="pelo prazo de 2 anos"
            details={<p>Raciocínio do agente.</p>}
            {...handlers}
            {...overrides}
        />,
    );
    return handlers;
}

describe("AgentSuggestion", () => {
    it("names the agent and offers the three decisions", () => {
        setup();
        expect(screen.getByText("Agente de revisão")).toBeInTheDocument();
        expect(screen.getByRole("article", { name: "Cl. 9 Vigência" })).toHaveAttribute("aria-keyshortcuts", "a e r");
        for (const name of [/Aceitar/, /Editar/, /Rejeitar/]) expect(screen.getByRole("button", { name })).toBeEnabled();
    });

    it("accepts in one click", () => {
        const { onAccept } = setup();
        fireEvent.click(screen.getByRole("button", { name: /Aceitar/ }));
        expect(onAccept).toHaveBeenCalledTimes(1);
    });

    it("edits the wording in place and saves it", () => {
        const { onEdit } = setup();
        fireEvent.click(screen.getByRole("button", { name: /Editar/ }));
        const box = screen.getByLabelText("Sua redação");
        fireEvent.change(box, { target: { value: "  pelo prazo de 3 anos  " } });
        fireEvent.click(screen.getByRole("button", { name: "Salvar edição" }));
        expect(onEdit).toHaveBeenCalledWith("pelo prazo de 3 anos");
    });

    it("cancels an edit with Escape or the button, and refuses an empty one", () => {
        const { onEdit } = setup();
        fireEvent.click(screen.getByRole("button", { name: /Editar/ }));
        fireEvent.keyDown(screen.getByLabelText("Sua redação"), { key: "Escape" });
        expect(screen.queryByLabelText("Sua redação")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: /Editar/ }));
        fireEvent.change(screen.getByLabelText("Sua redação"), { target: { value: " " } });
        expect(screen.getByRole("button", { name: "Salvar edição" })).toBeDisabled();
        fireEvent.keyDown(screen.getByLabelText("Sua redação"), { key: "Enter", metaKey: true });
        expect(onEdit).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
        expect(screen.queryByLabelText("Sua redação")).toBeNull();
    });

    it("saves an edit with Ctrl+Enter", () => {
        const { onEdit } = setup();
        fireEvent.click(screen.getByRole("button", { name: /Editar/ }));
        fireEvent.keyDown(screen.getByLabelText("Sua redação"), { key: "Enter", ctrlKey: true });
        expect(onEdit).toHaveBeenCalledWith("pelo prazo de 2 anos");
    });

    it("rejects with an optional one-line reason", () => {
        const { onReject } = setup();
        fireEvent.click(screen.getByRole("button", { name: /Rejeitar/ }));
        const input = screen.getByLabelText("Por quê? (opcional)");
        fireEvent.change(input, { target: { value: " a contraparte não aceita " } });
        fireEvent.keyDown(input, { key: "Enter" });
        expect(onReject).toHaveBeenCalledWith("a contraparte não aceita");
    });

    it("closes the reason with Escape and confirms with the button", () => {
        const { onReject } = setup();
        fireEvent.click(screen.getByRole("button", { name: /Rejeitar/ }));
        fireEvent.keyDown(screen.getByLabelText("Por quê? (opcional)"), { key: "Escape" });
        expect(screen.queryByLabelText("Por quê? (opcional)")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: /Rejeitar/ }));
        fireEvent.click(screen.getByRole("button", { name: "Rejeitar" }));
        expect(onReject).toHaveBeenCalledWith("");
    });

    it("answers a, e and r on the focused card, but not while typing or with a modifier", () => {
        const { onAccept } = setup({ focused: true });
        const card = screen.getByRole("article", { name: "Cl. 9 Vigência" });
        expect(card).toHaveFocus();
        fireEvent.keyDown(card, { key: "a", metaKey: true });
        expect(onAccept).not.toHaveBeenCalled();
        fireEvent.keyDown(card, { key: "a" });
        expect(onAccept).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(card, { key: "e" });
        const box = screen.getByLabelText("Sua redação");
        fireEvent.keyDown(box, { key: "r" });
        expect(screen.queryByLabelText("Por quê? (opcional)")).toBeNull();
        fireEvent.keyDown(box, { key: "Escape" });
        fireEvent.keyDown(card, { key: "r" });
        expect(screen.getByLabelText("Por quê? (opcional)")).toBeInTheDocument();
        fireEvent.keyDown(card, { key: "x" });
    });

    it("is read-only without the right to decide, and has no Editar without text", () => {
        const { onAccept } = setup({ canDecide: false });
        expect(screen.queryByRole("button", { name: /Aceitar/ })).toBeNull();
        fireEvent.keyDown(screen.getByRole("article"), { key: "a" });
        expect(onAccept).not.toHaveBeenCalled();
    });

    it("hides Editar when there is nothing to edit and shows a spinner while busy", () => {
        setup({ editableText: undefined, busy: true });
        expect(screen.queryByRole("button", { name: /Editar/ })).toBeNull();
        expect(screen.getByRole("button", { name: /Aceitar/ })).toBeDisabled();
    });

    it("shows the reasoning on request", () => {
        setup();
        const toggle = screen.getByRole("button", { name: /ver raciocínio/ });
        expect(toggle).toHaveAttribute("aria-expanded", "false");
        fireEvent.click(toggle);
        expect(screen.getByText("Raciocínio do agente.")).toBeInTheDocument();
    });

    it("folds a decided suggestion to one line that reopens it", () => {
        const { onReopen } = setup({
            decision: { kind: "rejeitado", by: "Duda", at: "2026-10-20T21:02:00.000Z", reason: "fora do escopo" },
        });
        const line = screen.getByRole("button", { name: "Reabrir: Rejeitado" });
        expect(line).toHaveTextContent("Rejeitado por Duda · 18:02");
        expect(screen.getByText("“fora do escopo”")).toBeInTheDocument();
        fireEvent.click(line);
        expect(onReopen).toHaveBeenCalled();
    });

    it("shows an accepted decision without a time when the date is unreadable", () => {
        setup({ decision: { kind: "aceito", by: "Duda", at: "ontem" }, onReopen: undefined });
        const line = screen.getByRole("button", { name: "Reabrir: Aceito" });
        expect(line).toBeDisabled();
        expect(line).toHaveTextContent(/Aceito por Duda$/);
    });
});

describe("AgentSuggestion editor slot", () => {
    it("shows the caller's form in place of the preview, and closes it on cancel", () => {
        const onEditingChange = vi.fn();
        render(
            <AgentSuggestion
                agent="Agente de intake"
                title="Triagem"
                preview="NDA · Polaris"
                editor={<select aria-label="Tipo"><option>NDA</option></select>}
                onEditingChange={onEditingChange}
                onAccept={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: /Editar/ }));
        expect(onEditingChange).toHaveBeenLastCalledWith(true);
        expect(screen.getByRole("combobox", { name: "Tipo" })).toBeInTheDocument();
        expect(screen.queryByText("NDA · Polaris")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
        expect(onEditingChange).toHaveBeenLastCalledWith(false);
        expect(screen.getByText("NDA · Polaris")).toBeInTheDocument();
    });

    it("lets the caller close the editor after saving", () => {
        const { rerender } = render(
            <AgentSuggestion agent="A" title="T" editor={<p>form</p>} editing onAccept={vi.fn()} />,
        );
        expect(screen.getByText("form")).toBeInTheDocument();
        rerender(<AgentSuggestion agent="A" title="T" editor={<p>form</p>} editing={false} onAccept={vi.fn()} />);
        expect(screen.queryByText("form")).toBeNull();
    });

    it("never answers a shortcut from a select or an editable region inside the card", () => {
        const onAccept = vi.fn();
        render(
            <AgentSuggestion agent="A" title="T" onAccept={onAccept}>
                <select aria-label="Responsável"><option>Duda</option></select>
                <div data-testid="rich" contentEditable suppressContentEditableWarning>texto</div>
            </AgentSuggestion>,
        );
        fireEvent.keyDown(screen.getByRole("combobox", { name: "Responsável" }), { key: "a" });
        const rich = screen.getByTestId("rich");
        Object.defineProperty(rich, "isContentEditable", { value: true });
        fireEvent.keyDown(rich, { key: "a" });
        expect(onAccept).not.toHaveBeenCalled();
    });
});
