"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import {
    getObligations,
    updateObligation,
    type Obligation,
    type ObligationMark,
} from "@/app/lib/mikeApi";
import { PageHeader } from "@/app/components/shared/PageHeader";

const MARK_STYLES: Record<ObligationMark, string> = {
    critico: "bg-red-100 text-red-700",
    tarefa: "bg-gray-100 text-gray-600",
    recorrente: "bg-blue-100 text-blue-700",
};

const MARK_LABELS: Record<ObligationMark, string> = {
    critico: "critical",
    tarefa: "task",
    recorrente: "recurring",
};

// Deadlines are grouped by how soon they land, which is how a legal team
// actually triages them — not by calendar month.
const BUCKETS = [
    { key: "overdue", label: "Overdue", max: -1 },
    { key: "30", label: "Next 30 days", max: 30 },
    { key: "90", label: "31–90 days", max: 90 },
    { key: "later", label: "Later", max: Infinity },
] as const;

function daysUntil(date: string): number {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(`${date}T00:00:00`);
    return Math.round((due.getTime() - today.getTime()) / 86_400_000);
}

export default function RadarPage() {
    const router = useRouter();
    const [items, setItems] = useState<Obligation[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setItems(await getObligations());
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to load deadlines");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const grouped = useMemo(() => {
        const out: Record<string, Obligation[]> = {};
        for (const b of BUCKETS) out[b.key] = [];
        for (const item of items) {
            const d = daysUntil(item.due_date);
            const bucket =
                d < 0 ? "overdue" : d <= 30 ? "30" : d <= 90 ? "90" : "later";
            out[bucket].push(item);
        }
        return out;
    }, [items]);

    async function markDone(item: Obligation) {
        const previous = items;
        setItems((xs) => xs.filter((x) => x.id !== item.id)); // default view hides done
        try {
            await updateObligation(item.id, { done: true });
        } catch (e) {
            setItems(previous);
            setError(e instanceof Error ? e.message : "Could not update the deadline");
        }
    }

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center text-gray-400">
                <Loader2 className="h-5 w-5 animate-spin" />
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            <PageHeader>Radar</PageHeader>

            {error && (
                <div className="mx-6 mb-3 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {error}
                </div>
            )}

            <div className="flex-1 overflow-y-auto px-6 pb-8">
                {items.length === 0 && (
                    <div className="rounded-xl border border-dashed border-gray-200 px-4 py-12 text-center text-sm text-gray-400">
                        No upcoming deadlines. Obligations extracted from contracts show up here.
                    </div>
                )}

                {BUCKETS.map((bucket) => {
                    const rows = grouped[bucket.key];
                    if (!rows || rows.length === 0) return null;
                    return (
                        <section key={bucket.key} className="mb-6">
                            <h2
                                className={`mb-2 text-[11px] font-medium uppercase tracking-wider ${
                                    bucket.key === "overdue" ? "text-red-600" : "text-gray-500"
                                }`}
                            >
                                {bucket.label} · {rows.length}
                            </h2>
                            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
                                {rows.map((item, i) => (
                                    <div
                                        key={item.id}
                                        className={`flex items-start gap-3 px-4 py-3 ${
                                            i > 0 ? "border-t border-gray-100" : ""
                                        }`}
                                    >
                                        <button
                                            onClick={() => void markDone(item)}
                                            title="Mark as done"
                                            className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-gray-300 text-transparent transition hover:border-emerald-500 hover:text-emerald-600"
                                        >
                                            <Check className="h-3 w-3" />
                                        </button>

                                        <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="text-sm text-gray-800">
                                                    {item.title}
                                                </span>
                                                <span
                                                    className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${MARK_STYLES[item.mark]}`}
                                                >
                                                    {MARK_LABELS[item.mark]}
                                                </span>
                                            </div>
                                            {item.projects?.name && (
                                                <button
                                                    onClick={() =>
                                                        item.project_id &&
                                                        router.push(`/projects/${item.project_id}`)
                                                    }
                                                    className="mt-0.5 line-clamp-1 text-xs text-gray-500 hover:text-gray-700 hover:underline"
                                                >
                                                    {item.projects.counterparty || item.projects.name}
                                                </button>
                                            )}
                                            {item.source_quote && (
                                                <p className="mt-1 line-clamp-2 border-l-2 border-gray-200 pl-2 text-[11px] italic text-gray-400">
                                                    {item.source_quote}
                                                </p>
                                            )}
                                        </div>

                                        <div className="shrink-0 text-right">
                                            <div className="text-sm tabular-nums text-gray-700">
                                                {item.due_date}
                                            </div>
                                            <div
                                                className={`text-[11px] ${
                                                    daysUntil(item.due_date) < 0
                                                        ? "text-red-600"
                                                        : "text-gray-400"
                                                }`}
                                            >
                                                {daysUntil(item.due_date) < 0
                                                    ? `${Math.abs(daysUntil(item.due_date))}d overdue`
                                                    : `in ${daysUntil(item.due_date)}d`}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </section>
                    );
                })}
            </div>
        </div>
    );
}
