"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { getObligations, type Obligation, type ObligationMark } from "@/app/lib/mikeApi";

const MARK_DOT: Record<ObligationMark, string> = {
    critico: "bg-red-500",
    recorrente: "bg-blue-500",
    tarefa: "bg-gray-400",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Date-only string -> local Date, avoiding the UTC shift that would move a
 *  deadline to the previous day for anyone west of Greenwich. */
function parseDate(value: string): Date {
    return new Date(`${value}T00:00:00`);
}

function iso(date: Date): string {
    const month = `${date.getMonth() + 1}`.padStart(2, "0");
    const day = `${date.getDate()}`.padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
}

function startOfMonth(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

export function RadarCalendar() {
    const router = useRouter();
    const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
    const [items, setItems] = useState<Obligation[]>([]);
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState<string | null>(null);

    // The grid always shows whole weeks, so it can spill into the neighbouring
    // months — fetch that range too or those cells would look empty.
    const gridStart = useMemo(() => {
        const first = startOfMonth(cursor);
        const d = new Date(first);
        d.setDate(first.getDate() - first.getDay());
        return d;
    }, [cursor]);

    const gridDays = useMemo(() => {
        const last = endOfMonth(cursor);
        const total = Math.ceil((last.getDate() + startOfMonth(cursor).getDay()) / 7) * 7;
        return Array.from({ length: total }, (_, i) => {
            const d = new Date(gridStart);
            d.setDate(gridStart.getDate() + i);
            return d;
        });
    }, [cursor, gridStart]);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const last = gridDays[gridDays.length - 1] ?? endOfMonth(cursor);
            setItems(
                await getObligations({
                    from: iso(gridStart),
                    to: iso(last),
                    includeDone: true,
                }),
            );
        } finally {
            setLoading(false);
        }
    }, [cursor, gridStart, gridDays]);

    useEffect(() => {
        void load();
    }, [load]);

    const byDay = useMemo(() => {
        const map = new Map<string, Obligation[]>();
        for (const item of items) {
            const list = map.get(item.due_date) ?? [];
            list.push(item);
            map.set(item.due_date, list);
        }
        return map;
    }, [items]);

    const today = iso(new Date());
    const monthLabel = cursor.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    const selectedItems = selected ? (byDay.get(selected) ?? []) : [];

    function shiftMonth(delta: number) {
        setSelected(null);
        setCursor((c) => new Date(c.getFullYear(), c.getMonth() + delta, 1));
    }

    return (
        <div className="px-6 pb-8">
            <div className="mb-3 flex items-center gap-3">
                <button
                    onClick={() => shiftMonth(-1)}
                    aria-label="Previous month"
                    className="rounded-md border border-gray-200 p-1 text-gray-500 hover:bg-gray-50"
                >
                    <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="min-w-[160px] text-sm font-medium text-gray-800">
                    {monthLabel}
                </span>
                <button
                    onClick={() => shiftMonth(1)}
                    aria-label="Next month"
                    className="rounded-md border border-gray-200 p-1 text-gray-500 hover:bg-gray-50"
                >
                    <ChevronRight className="h-4 w-4" />
                </button>
                <button
                    onClick={() => {
                        setSelected(null);
                        setCursor(startOfMonth(new Date()));
                    }}
                    className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
                >
                    Today
                </button>
                {loading && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
            </div>

            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
                <div className="grid grid-cols-7 border-b border-gray-100">
                    {WEEKDAYS.map((d) => (
                        <div
                            key={d}
                            className="px-2 py-1.5 text-center text-[10px] uppercase tracking-wider text-gray-400"
                        >
                            {d}
                        </div>
                    ))}
                </div>
                <div className="grid grid-cols-7">
                    {gridDays.map((day) => {
                        const key = iso(day);
                        const dayItems = byDay.get(key) ?? [];
                        const inMonth = day.getMonth() === cursor.getMonth();
                        const isToday = key === today;
                        return (
                            <button
                                key={key}
                                onClick={() => setSelected(dayItems.length ? key : null)}
                                className={`min-h-[86px] border-b border-r border-gray-100 p-1.5 text-left align-top transition-colors ${
                                    inMonth ? "bg-white" : "bg-gray-50/50"
                                } ${dayItems.length ? "hover:bg-gray-50" : ""} ${
                                    selected === key ? "ring-1 ring-inset ring-gray-400" : ""
                                }`}
                            >
                                <span
                                    className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${
                                        isToday
                                            ? "bg-gray-900 text-white"
                                            : inMonth
                                              ? "text-gray-700"
                                              : "text-gray-300"
                                    }`}
                                >
                                    {day.getDate()}
                                </span>
                                <div className="mt-1 space-y-0.5">
                                    {dayItems.slice(0, 2).map((item) => (
                                        <div key={item.id} className="flex items-start gap-1">
                                            <span
                                                className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${MARK_DOT[item.mark]}`}
                                            />
                                            <span
                                                className={`line-clamp-2 text-[10px] leading-tight ${
                                                    item.done ? "text-gray-300 line-through" : "text-gray-600"
                                                }`}
                                            >
                                                {item.title}
                                            </span>
                                        </div>
                                    ))}
                                    {dayItems.length > 2 && (
                                        <span className="text-[10px] text-gray-400">
                                            +{dayItems.length - 2} more
                                        </span>
                                    )}
                                </div>
                            </button>
                        );
                    })}
                </div>
            </div>

            {selectedItems.length > 0 && (
                <div className="mt-4 rounded-xl border border-gray-200 bg-white">
                    <div className="border-b border-gray-100 px-4 py-2 text-[11px] uppercase tracking-wider text-gray-500">
                        {parseDate(selected!).toLocaleDateString("en-US", {
                            weekday: "long",
                            day: "numeric",
                            month: "long",
                        })}
                    </div>
                    {selectedItems.map((item, i) => (
                        <div
                            key={item.id}
                            className={`px-4 py-3 ${i > 0 ? "border-t border-gray-100" : ""}`}
                        >
                            <div className="flex items-center gap-2">
                                <span className={`h-1.5 w-1.5 rounded-full ${MARK_DOT[item.mark]}`} />
                                <span className="text-sm text-gray-800">{item.title}</span>
                            </div>
                            {item.projects?.name && (
                                <button
                                    onClick={() =>
                                        item.project_id && router.push(`/projects/${item.project_id}`)
                                    }
                                    className="mt-0.5 pl-3.5 text-xs text-gray-500 hover:text-gray-700 hover:underline"
                                >
                                    {item.projects.counterparty || item.projects.name}
                                </button>
                            )}
                            {item.source_quote && (
                                <p className="mt-1 pl-3.5 text-[11px] italic text-gray-400">
                                    {item.source_quote}
                                </p>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
