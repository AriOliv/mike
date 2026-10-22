import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NoticeDeadlineBadge, daysUntil } from "./NoticeDeadlineBadge";

const NOW = new Date(2026, 9, 20);

describe("NoticeDeadlineBadge", () => {
    it.each([
        ["2026-10-19", "vencido", "vencido"],
        ["2026-10-20", "hoje", "d7"],
        ["2026-10-25", "D-5", "d7"],
        ["2026-11-19", "D-30", "d30"],
        ["2026-12-10", "D-51", "d60"],
        ["2027-01-10", "D-82", "d90"],
        ["2027-06-01", "D-224", "longe"],
    ])("%s reads %s in tone %s", (date, label, tone) => {
        const { container } = render(<NoticeDeadlineBadge date={date} now={NOW} />);
        expect(screen.getByText(label)).toBeInTheDocument();
        expect(container.firstElementChild).toHaveAttribute("data-tone", tone);
    });

    it("shows the arithmetic in the tooltip when it knows the end date and notice", () => {
        render(<NoticeDeadlineBadge date="2026-11-01" endDate="2027-01-01" noticeDays={61} now={NOW} />);
        expect(screen.getByTitle("Aviso até 01/11/2026 (vencimento 01/01/2027 − 61 dias de aviso)")).toBeInTheDocument();
    });

    it("defaults to today", () => {
        expect(typeof daysUntil("2030-01-01")).toBe("number");
    });
});
