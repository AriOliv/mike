import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { STATUS_LABEL, StatusChip, type ChipStatus } from "./status-chip";

describe("StatusChip", () => {
    it("renders every state with its word and an icon", () => {
        for (const status of Object.keys(STATUS_LABEL) as ChipStatus[]) {
            const { container, unmount } = render(<StatusChip status={status} />);
            const chip = container.querySelector(`[data-status="${status}"]`);
            expect(chip).toHaveTextContent(STATUS_LABEL[status]);
            expect(chip?.querySelector("svg")).not.toBeNull();
            unmount();
        }
    });

    it("shows the agent's current step instead of the standard word", () => {
        render(<StatusChip status="rodando" label="Lendo o contrato…" size="md" />);
        expect(screen.getByText("Lendo o contrato…")).toHaveClass("h-6");
    });
});
