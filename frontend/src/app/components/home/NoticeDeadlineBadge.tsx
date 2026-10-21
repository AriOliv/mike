"use client";

// TODO(#10): replace with the shared DeadlineBadge
// (`@/app/components/ui/deadline-badge`) once PR #10 is in this branch's base:
// same props, so the swap is the import. It is not cherry-picked here because
// its helpers import the regulatory radar's API types, which come with #10's
// screens.

import { CalendarClock } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { brDate } from "@/app/lib/home";

type Tone = "vencido" | "d7" | "d30" | "d60" | "d90" | "longe";

const TONE: Record<Tone, string> = {
    longe: "bg-gray-100 text-gray-500",
    d90: "bg-gray-100 text-gray-600",
    d60: "bg-amber-50 text-amber-700",
    d30: "bg-amber-100 text-amber-800",
    d7: "bg-red-50 text-red-700",
    vencido: "bg-red-600 text-white",
};

/** Whole days from today (local) to a YYYY-MM-DD date; negative once past. */
export function daysUntil(isoDate: string, now: Date = new Date()): number {
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
    return Math.round((Date.UTC(y, m - 1, d) - today) / 86_400_000);
}

function toneOf(days: number): Tone {
    if (days < 0) return "vencido";
    if (days <= 7) return "d7";
    if (days <= 30) return "d30";
    if (days <= 60) return "d60";
    if (days <= 90) return "d90";
    return "longe";
}

/** D-90 grey, D-60 light amber, D-30 amber, D-7 red, past due solid red; the tooltip shows the arithmetic. */
export function NoticeDeadlineBadge({
    date,
    endDate,
    noticeDays,
    now,
    className,
}: {
    date: string;
    endDate?: string | null;
    noticeDays?: number | null;
    now?: Date;
    className?: string;
}) {
    const days = daysUntil(date, now);
    const label = days < 0 ? "vencido" : days === 0 ? "hoje" : `D-${days}`;
    const tip =
        endDate && noticeDays != null
            ? `Aviso até ${brDate(date)} (vencimento ${brDate(endDate)} − ${noticeDays} dias de aviso)`
            : `Aviso até ${brDate(date)}`;
    return (
        <span
            data-tone={toneOf(days)}
            title={tip}
            aria-label={`${label}, ${tip}`}
            className={cn(
                "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.5 font-mono text-[11px] tabular-nums",
                TONE[toneOf(days)],
                className,
            )}
        >
            <CalendarClock aria-hidden="true" className="h-3 w-3" />
            {label}
        </span>
    );
}
