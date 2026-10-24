"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { listCriticalAlerts, type CriticalAlert } from "@/app/lib/mikeApi";
import { relativeTime } from "@/app/lib/activityFeed";
import { cn } from "@/app/lib/utils";

/**
 * The Head's open critical alerts: requests whose contract analysis found a
 * critical risk. Shown on the home screen; renders nothing for anyone else
 * or when there is none. The analysis is a draft for the team to review.
 */
export function CriticalAlertsStrip({ className, now }: { className?: string; now?: number }) {
    const [alerts, setAlerts] = useState<CriticalAlert[]>([]);
    useEffect(() => {
        let cancelled = false;
        listCriticalAlerts()
            .then((r) => {
                if (!cancelled) setAlerts(r.alerts);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, []);
    if (alerts.length === 0) return null;
    return (
        <section
            aria-label="Riscos críticos em pedidos"
            className={cn("rounded-xl border border-red-200 bg-red-50 p-3 dark:border-red-500/30 dark:bg-red-500/10", className)}
        >
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-red-800 dark:text-red-200">
                <ShieldAlert aria-hidden="true" className="h-4 w-4" />
                {alerts.length === 1 ? "1 pedido com risco crítico" : `${alerts.length} pedidos com risco crítico`}
            </h2>
            <ul className="mt-2 space-y-1">
                {alerts.map((a) => (
                    <li key={a.request_id} className="text-xs">
                        <Link
                            href={`/pedidos?pedido=${a.request_id}`}
                            className="flex flex-wrap items-baseline gap-x-2 rounded-md px-1 py-0.5 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 dark:hover:bg-red-500/20"
                        >
                            <span className="font-mono text-[11px] text-red-700 dark:text-red-300">{a.code}</span>
                            <span className="break-words text-gray-900">{a.title}</span>
                            <span className="text-gray-600">
                                {a.critical > 0 ? `${a.critical} ${a.critical === 1 ? "risco crítico" : "riscos críticos"}` : "risco crítico"}
                                {a.assignee_name ? ` · com ${a.assignee_name}` : " · sem responsável"}
                                {" · "}
                                {relativeTime(a.alerted_at, now)}
                            </span>
                        </Link>
                    </li>
                ))}
            </ul>
            <p className="mt-2 text-[11px] text-red-700/80 dark:text-red-300/80">
                Análise gerada por IA, não é parecer. Revise antes de decidir.
            </p>
        </section>
    );
}

/**
 * On the request: the analysis found a critical risk. Says it once, plainly,
 * above the analysis, without deciding anything for the team.
 */
export function CriticalAlertBanner({ critical }: { critical: number }) {
    return (
        <p
            role="status"
            className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-500/10 dark:text-red-200"
        >
            <ShieldAlert aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>
                A análise do contrato encontrou {critical === 1 ? "1 risco crítico" : `${critical} riscos críticos`}. A liderança do Legal foi
                avisada no Mike. É um rascunho de IA: revise antes de decidir.
            </span>
        </p>
    );
}
