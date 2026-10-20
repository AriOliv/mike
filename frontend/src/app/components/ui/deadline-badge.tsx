"use client";

import { CalendarClock } from "lucide-react";
import { cn } from "@/app/lib/utils";
import {
    daysUntil,
    deadlineLabel,
    deadlineTone,
    deadlineTooltip,
    type DeadlineTone,
} from "@/app/lib/regulatoryRadar";

const TONE: Record<DeadlineTone, string> = {
    longe: "bg-gray-100 text-gray-500",
    d90: "bg-gray-100 text-gray-600",
    d60: "bg-amber-50 text-amber-700",
    d30: "bg-amber-100 text-amber-800",
    d7: "bg-red-50 text-red-700",
    vencido: "bg-red-600 text-white",
};

export type DeadlineBadgeProps = {
    /** YYYY-MM-DD: the last day to give notice, the day a rule takes effect, a due date. */
    date: string;
    /** What the date is; picks the tooltip wording. */
    kind?: "aviso" | "vigencia" | "prazo";
    /** For a notice deadline: the contract's end date and notice days, shown as the arithmetic. */
    endDate?: string | null;
    noticeDays?: number | null;
    /** Defaults to now; injectable so stories and tests are stable. */
    now?: Date;
    className?: string;
};

/**
 * How many days are left: D-90 grey, D-60 light amber, D-30 amber, D-7 red,
 * past due solid red. The tooltip carries the arithmetic so nobody has to
 * trust the number blindly.
 */
export function DeadlineBadge({ date, kind = "aviso", endDate, noticeDays, now, className }: DeadlineBadgeProps) {
    const days = daysUntil(date, now);
    const tone = deadlineTone(days);
    const tip = deadlineTooltip({ date, kind, endDate, noticeDays });
    return (
        <span
            data-tone={tone}
            title={tip}
            aria-label={`${deadlineLabel(days)}, ${tip}`}
            className={cn(
                "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.5 font-mono text-[11px] tabular-nums",
                TONE[tone],
                className,
            )}
        >
            <CalendarClock aria-hidden="true" className="h-3 w-3" />
            {deadlineLabel(days)}
        </span>
    );
}
