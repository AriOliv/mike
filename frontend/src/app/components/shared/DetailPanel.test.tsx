import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DetailPanel } from "./DetailPanel";

describe("DetailPanel", () => {
    it("shows title, fields, summary, aside and activity, and takes focus", () => {
        render(
            <DetailPanel
                title="NDA Polaris.docx"
                subtitle="Polaris Tecnologia"
                fields={[
                    { label: "Contraparte", value: "Polaris" },
                    { label: "Aviso", value: "D-21", emphasis: true },
                ]}
                actions={<button type="button">Abrir</button>}
                summary="3 desvios"
                aside={<span>semáforo</span>}
                activity={<span>feed</span>}
                onClose={vi.fn()}
            />,
        );
        expect(screen.getByRole("heading", { name: "NDA Polaris.docx" })).toBeInTheDocument();
        expect(screen.getByText("D-21")).toHaveClass("font-medium");
        expect(screen.getByText("Resumo")).toBeInTheDocument();
        expect(screen.getByText("semáforo")).toBeInTheDocument();
        expect(screen.getByText("Atividade")).toBeInTheDocument();
        expect(screen.getByRole("complementary")).toHaveFocus();
    });

    it("closes on the button and on Escape, and omits empty sections", () => {
        const onClose = vi.fn();
        render(<DetailPanel title="X" fields={[]} onClose={onClose} />);
        expect(screen.queryByText("Resumo")).toBeNull();
        expect(screen.queryByText("Atividade")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
        fireEvent.keyDown(window, { key: "Escape" });
        fireEvent.keyDown(window, { key: "a" });
        expect(onClose).toHaveBeenCalledTimes(2);
    });
});
