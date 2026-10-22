import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StatTiles } from "./stat-tiles";

const tiles = [
    { id: "prontos", value: 26, label: "Prontos p/ revisar" },
    { id: "avisos", value: 3, label: "Avisos em 30 dias", tone: "critico" as const, hint: "o mais próximo em 4 dias" },
];

describe("StatTiles", () => {
    it("renders numbers, labels and hints without buttons when not filterable", () => {
        render(<StatTiles tiles={tiles} />);
        expect(screen.getByText("26")).toBeInTheDocument();
        expect(screen.getByText("3")).toHaveClass("text-red-700");
        expect(screen.getByText("o mais próximo em 4 dias")).toBeInTheDocument();
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("filters on click and clears when the pressed tile is clicked again", () => {
        const onSelect = vi.fn();
        const { rerender } = render(<StatTiles tiles={tiles} onSelect={onSelect} />);
        fireEvent.click(screen.getByRole("button", { name: /Prontos/ }));
        expect(onSelect).toHaveBeenLastCalledWith("prontos");
        rerender(<StatTiles tiles={tiles} onSelect={onSelect} selected="prontos" />);
        const pressed = screen.getByRole("button", { name: /Prontos/ });
        expect(pressed).toHaveAttribute("aria-pressed", "true");
        fireEvent.click(pressed);
        expect(onSelect).toHaveBeenLastCalledWith(null);
    });

    it("shows a skeleton while loading", () => {
        const { container } = render(<StatTiles tiles={tiles} onSelect={vi.fn()} loading />);
        expect(screen.queryByText("26")).toBeNull();
        expect(container.querySelectorAll(".animate-pulse")).toHaveLength(4);
    });
});
