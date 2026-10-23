"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import {
    getObligationAlerts,
    getObligationOwners,
    getObligations,
    updateObligation,
    type Obligation,
    type ObligationAlert,
    type ObligationMark,
    type ObligationOwner,
} from "@/app/lib/mikeApi";
import { useAuth } from "@/app/contexts/AuthContext";
import { ObligationOwnerEditor } from "@/app/components/radar/ObligationOwnerEditor";
import { dueLabel } from "@/app/lib/obligations";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { RadarCalendar } from "@/app/components/radar/RadarCalendar";
import { brDate } from "@/app/lib/contractsPortfolio";

const MARK_STYLES: Record<ObligationMark, string> = {
    critico: "bg-red-100 text-red-700",
    tarefa: "bg-gray-100 text-gray-600",
    recorrente: "bg-blue-100 text-blue-700",
};

const MARK_LABELS: Record<ObligationMark, string> = {
    critico: "crítico",
    tarefa: "tarefa",
    recorrente: "recorrente",
};

// Deadlines are grouped by how soon they land, which is how a legal team
// actually triages them — not by calendar month.
const BUCKETS = [
    { key: "overdue", label: "Vencidos", max: -1 },
    { key: "30", label: "Próximos 30 dias", max: 30 },
    { key: "90", label: "31 a 90 dias", max: 90 },
    { key: "later", label: "Mais adiante", max: Infinity },
] as const;

function daysUntil(date: string): number {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(`${date}T00:00:00`);
    return Math.round((due.getTime() - today.getTime()) / 86_400_000);
}

export default function RadarPage() {
    const router = useRouter();
    const { user } = useAuth();
    const me = user?.email?.toLowerCase() ?? null;
    const [alerts, setAlerts] = useState<ObligationAlert[]>([]);
    const [people, setPeople] = useState<ObligationOwner[]>([]);
    const [items, setItems] = useState<Obligation[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [view, setView] = useState<"list" | "calendar">("list");
    const VIEW_LABELS = { list: "Lista", calendar: "Calendário" } as const;

    const load = useCallback(async () => {
        try {
            const [all, mine, team] = await Promise.all([
                getObligations(),
                getObligationAlerts().catch(() => [] as ObligationAlert[]),
                // Not everyone is on the team; they just cannot hand a deadline on.
                getObligationOwners().catch(() => [] as ObligationOwner[]),
            ]);
            setItems(all);
            setAlerts(mine);
            setPeople(team);
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Não consegui carregar os prazos.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const attention = useMemo(() => new Set(alerts.map((a) => a.id)), [alerts]);

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
        const previousAlerts = alerts;
        setItems((xs) => xs.filter((x) => x.id !== item.id)); // default view hides done
        setAlerts((xs) => xs.filter((x) => x.id !== item.id));
        try {
            await updateObligation(item.id, { done: true });
        } catch (e) {
            setItems(previous);
            setAlerts(previousAlerts);
            setError(e instanceof Error ? e.message : "Não consegui atualizar o prazo.");
        }
    }

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center text-gray-400">
                <Loader2 className="h-5 w-5 animate-spin" />
            </div>
        );
    }

    const viewToggle = (
        <div className="flex gap-1 px-6 pb-3">
            {(["list", "calendar"] as const).map((v) => (
                <button
                    key={v}
                    onClick={() => setView(v)}
                    className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                        view === v
                            ? "bg-gray-900 text-white"
                            : "border border-gray-200 text-gray-600 hover:bg-gray-50"
                    }`}
                >
                    {VIEW_LABELS[v]}
                </button>
            ))}
        </div>
    );

    if (view === "calendar") {
        return (
            <div className="flex h-full flex-col">
                <PageHeader>Prazos</PageHeader>
                {viewToggle}
                <div className="min-h-0 flex-1 overflow-y-auto">
                    <RadarCalendar />
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            <PageHeader>Prazos</PageHeader>
            {viewToggle}

            {error && (
                <div className="mx-6 mb-3 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {error}
                </div>
            )}

            <div className="flex-1 overflow-y-auto px-6 pb-8">
                {alerts.length > 0 ? (
                    <section
                        aria-label="Pedem sua atenção"
                        className={`mb-6 rounded-xl border px-4 py-3 ${
                            alerts.some((a) => a.days_left < 0) ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"
                        }`}
                    >
                        <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-gray-600">
                            Pedem sua atenção · {alerts.length}
                        </h2>
                        <ul className="space-y-1.5">
                            {alerts.map((a) => (
                                <li key={a.id} className="flex items-center gap-2 text-sm">
                                    <button
                                        onClick={() => void markDone(a)}
                                        title="Marcar como feito"
                                        className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-gray-400 bg-white text-transparent hover:border-emerald-500 hover:text-emerald-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gray-900"
                                    >
                                        <Check className="h-3 w-3" />
                                    </button>
                                    <button
                                        onClick={() => a.project_id && router.push(`/projects/${a.project_id}`)}
                                        disabled={!a.project_id}
                                        className="min-w-0 flex-1 truncate text-left text-gray-800 enabled:hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-gray-900"
                                    >
                                        {a.title}
                                        {a.projects?.counterparty || a.projects?.name ? (
                                            <span className="text-gray-500"> · {a.projects.counterparty || a.projects.name}</span>
                                        ) : null}
                                    </button>
                                    <span className={`shrink-0 text-xs ${a.days_left < 0 ? "font-medium text-red-700" : "text-gray-600"}`}>
                                        {dueLabel(a.days_left)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </section>
                ) : (
                    items.length > 0 && <p className="mb-4 text-xs text-gray-400">Nada pede sua atenção agora.</p>
                )}

                {items.length === 0 && (
                    <div className="rounded-xl border border-dashed border-gray-200 px-4 py-12 text-center text-sm text-gray-400">
                        Nenhum prazo à vista. As obrigações extraídas dos contratos aparecem aqui.
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
                                            title="Marcar como feito"
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
                                                {attention.has(item.id) && (
                                                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">
                                                        em atenção
                                                    </span>
                                                )}
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
                                            <ObligationOwnerEditor
                                                item={item}
                                                me={me}
                                                people={people}
                                                onSaved={(next) => {
                                                    setItems((xs) => xs.map((x) => (x.id === next.id ? { ...x, ...next } : x)));
                                                    void getObligationAlerts().then(setAlerts, () => undefined);
                                                }}
                                            />
                                            {item.source_quote && (
                                                <p className="mt-1 line-clamp-2 border-l-2 border-gray-200 pl-2 text-[11px] italic text-gray-400">
                                                    {item.source_quote}
                                                </p>
                                            )}
                                        </div>

                                        <div className="shrink-0 text-right">
                                            <div className="text-sm tabular-nums text-gray-700">
                                                {brDate(item.due_date)}
                                            </div>
                                            <div
                                                className={`text-[11px] ${
                                                    daysUntil(item.due_date) < 0
                                                        ? "text-red-600"
                                                        : "text-gray-400"
                                                }`}
                                            >
                                                {dueLabel(daysUntil(item.due_date))}
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
