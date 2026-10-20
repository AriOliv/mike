import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DeadlineBadge } from "./deadline-badge";

const now = new Date(2026, 9, 20, 9, 0);

describe("DeadlineBadge", () => {
    it("counts the days and explains the arithmetic", () => {
        render(<DeadlineBadge date="2026-11-10" endDate="2026-12-10" noticeDays={30} now={now} />);
        const badge = screen.getByText("D-21").closest("span")!;
        expect(badge).toHaveAttribute("data-tone", "d30");
        expect(badge).toHaveAttribute("title", "aviso até 10/11/2026 (vencimento 10/12/2026 − 30 dias de aviso)");
        expect(badge).toHaveAccessibleName(/^D-21, aviso até/);
    });

    it("turns solid red once the date has passed", () => {
        render(<DeadlineBadge date="2026-10-01" kind="prazo" now={now} />);
        expect(screen.getByText("vencido").closest("span")).toHaveAttribute("data-tone", "vencido");
    });

    it("words an effective date", () => {
        render(<DeadlineBadge date="2027-02-02" kind="vigencia" now={now} className="ml-1" />);
        const badge = screen.getByText("D-105").closest("span")!;
        expect(badge).toHaveAttribute("title", "entra em vigor em 02/02/2027");
        expect(badge).toHaveClass("ml-1");
    });

    it("defaults to today", () => {
        const today = new Date();
        const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        render(<DeadlineBadge date={iso} />);
        expect(screen.getByText("hoje")).toBeInTheDocument();
    });
});
