import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
    tallyVerdicts,
    VERDICT_URGENCY,
    VerdictCountsUI,
    VerdictLabelUI,
    verdictOf,
} from "./VerdictUI";

describe("verdictOf", () => {
    it("maps every playbook status onto one light", () => {
        expect(verdictOf("acceptable")).toBe("alinhado");
        expect(verdictOf("needs_review")).toBe("precisa_revisao");
        expect(verdictOf("unacceptable")).toBe("diverge");
        expect(verdictOf("missing_required")).toBe("diverge");
        expect(verdictOf("not_applicable")).toBe("nao_aplica");
        expect(verdictOf("outside_scope")).toBe("nao_aplica");
    });

    it("reads the most urgent verdict first", () => {
        expect(VERDICT_URGENCY[0]).toBe("diverge");
    });
});

describe("tallyVerdicts", () => {
    it("counts the three lights and leaves out what does not apply", () => {
        expect(
            tallyVerdicts([
                "acceptable",
                "acceptable",
                "needs_review",
                "unacceptable",
                "missing_required",
                "not_applicable",
                "outside_scope",
            ]),
        ).toEqual({ alinhado: 2, precisa_revisao: 1, diverge: 2 });
    });
});

describe("VerdictLabelUI", () => {
    it("names the verdict in words beside its icon", () => {
        render(<VerdictLabelUI verdict="diverge" />);
        const label = screen.getByText("Diverge");
        expect(label).toHaveAttribute("data-verdict", "diverge");
        expect(label).toHaveClass("text-red-700", "bg-red-50");
        expect(label.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    });

    it("accepts other wording for the same light", () => {
        render(<VerdictLabelUI verdict="precisa_revisao" label="Exige ação" />);
        expect(screen.getByText("Exige ação")).toHaveClass("text-amber-700");
    });
});

describe("VerdictCountsUI", () => {
    it("reads each count aloud and greys a zero instead of hiding it", () => {
        render(<VerdictCountsUI alinhado={8} precisa_revisao={1} diverge={0} />);
        expect(screen.getByRole("img", { name: "8 alinhados" })).toHaveClass("text-emerald-700");
        expect(screen.getByRole("img", { name: "1 precisa revisão" })).toHaveClass("text-amber-700");
        expect(screen.getByRole("img", { name: "0 divergem" })).toHaveClass("text-gray-400");
    });

    it("filters on a count, and clears the filter when it is pressed again", () => {
        const onSelect = vi.fn();
        const { rerender } = render(
            <VerdictCountsUI alinhado={2} precisa_revisao={1} diverge={1} onSelect={onSelect} />,
        );
        const diverge = screen.getByRole("button", { name: "1 diverge: filtrar" });
        expect(diverge).toHaveAttribute("aria-pressed", "false");
        fireEvent.click(diverge);
        expect(onSelect).toHaveBeenLastCalledWith("diverge");

        rerender(
            <VerdictCountsUI
                alinhado={2}
                precisa_revisao={1}
                diverge={1}
                onSelect={onSelect}
                selected="diverge"
            />,
        );
        const pressed = screen.getByRole("button", { name: "1 diverge: filtrar" });
        expect(pressed).toHaveAttribute("aria-pressed", "true");
        fireEvent.click(pressed);
        expect(onSelect).toHaveBeenLastCalledWith(null);
    });

    it("shows tiles with the number and the word", () => {
        render(
            <VerdictCountsUI
                variant="tiles"
                alinhado={3}
                precisa_revisao={0}
                diverge={2}
                onSelect={() => undefined}
                selected="alinhado"
            />,
        );
        const tile = screen.getByRole("button", { name: "3 alinhados: filtrar" });
        expect(tile).toHaveTextContent("3Alinhado");
        expect(tile).toHaveClass("bg-app-surface-active");
        expect(screen.getByRole("button", { name: "2 divergem: filtrar" })).toHaveClass("bg-app-surface");
    });
});
