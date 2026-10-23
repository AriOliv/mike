"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, CalendarPlus, Check, FileText, Loader2, RotateCcw, X } from "lucide-react";
import {
    downloadObligationIcs,
    getContractAlerts,
    getContractAmendments,
    getObligationOwners,
    updateObligation,
    type ContractAlert,
    type LinkedAmendment,
    type ObligationOwner,
    type ObligationStatus,
} from "@/app/lib/mikeApi";
import { useAuth } from "@/app/contexts/AuthContext";
import { downloadBlob } from "@/app/lib/downloadDocument";
import { describeError, notifyError } from "@/app/lib/userFacingError";
import { amendmentLine, dueLabel, KIND_LABEL, sortAlerts, STATUS_LABEL } from "@/app/lib/obligations";
import { ObligationOwnerEditor } from "@/app/components/radar/ObligationOwnerEditor";

const STATUS_STYLE: Record<ObligationStatus, string> = {
    aberto: "bg-blue-100 text-blue-700",
    feito: "bg-emerald-100 text-emerald-700",
    dispensado: "bg-gray-100 text-gray-600",
};

const ACTION =
    "inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gray-900 disabled:opacity-50";

/** The deadlines of one contract: what each is, who looks after it, where it stands. */
export function ContractAlertsView({ projectId }: { projectId: string }) {
    const { user } = useAuth();
    const me = user?.email?.toLowerCase() ?? null;
    const [alerts, setAlerts] = useState<ContractAlert[] | null>(null);
    const [people, setPeople] = useState<ObligationOwner[]>([]);
    const [amendments, setAmendments] = useState<LinkedAmendment[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const [mine, team, linked] = await Promise.all([
                getContractAlerts(projectId),
                // Not everyone is on the team; they just cannot hand a deadline on.
                getObligationOwners().catch(() => [] as ObligationOwner[]),
                // The amendments are a side note: the deadlines load without them.
                getContractAmendments(projectId).catch(() => [] as LinkedAmendment[]),
            ]);
            setAlerts(sortAlerts(mine));
            setPeople(team);
            setAmendments(linked);
            setError(null);
        } catch (e) {
            setError(describeError(e, { lang: "pt", action: "carregar os alertas do contrato" }).message);
        }
    }, [projectId]);

    useEffect(() => {
        void load();
    }, [load]);

    async function setStatus(alert: ContractAlert, status: ObligationStatus) {
        setBusy(alert.id);
        try {
            await updateObligation(alert.id, { status });
            await load();
        } catch (e) {
            notifyError(e, { lang: "pt", action: "atualizar o alerta" });
        } finally {
            setBusy(null);
        }
    }

    async function createEvent(alert: ContractAlert) {
        setBusy(alert.id);
        try {
            const file = await downloadObligationIcs(alert.id);
            downloadBlob(file.blob, file.filename);
        } catch (e) {
            notifyError(e, { lang: "pt", action: "criar o evento" });
        } finally {
            setBusy(null);
        }
    }

    if (alerts === null && !error) {
        return (
            <div className="flex flex-1 items-center justify-center text-gray-400">
                <Loader2 className="h-5 w-5 animate-spin" />
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-y-auto px-6 pb-8 pt-2">
            {error && (
                <div role="alert" className="mb-3 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {error}
                </div>
            )}
            {amendments.length > 0 && (
                <section aria-label="Aditivos deste contrato" className="mb-4 rounded-xl border border-gray-200 px-4 py-3">
                    <h3 className="mb-1 text-xs font-medium uppercase text-gray-500">Aditivos ligados</h3>
                    <ul>
                        {amendments.map((m) => (
                            <li key={m.id} className="flex flex-wrap items-center gap-2 py-1 text-sm">
                                <FileText className="h-3.5 w-3.5 text-gray-400" aria-hidden />
                                <Link href={`/pedidos/${m.id}`} className="text-gray-900 hover:underline">
                                    {m.code} · {m.title}
                                </Link>
                                <span className="text-xs text-gray-500">{amendmentLine(m)}</span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
            {alerts && alerts.length === 0 && (
                <div className="rounded-xl border border-dashed border-gray-200 px-4 py-12 text-center text-sm text-gray-500">
                    Este contrato ainda não tem alertas. Eles surgem quando o Mike lê a vigência e o aviso prévio do contrato.
                </div>
            )}
            {alerts && alerts.length > 0 && (
                <ul className="overflow-hidden rounded-xl border border-gray-200 bg-white">
                    {alerts.map((a, i) => {
                        const closed = a.status !== "aberto";
                        return (
                            <li key={a.id} className={`flex flex-col gap-1 px-4 py-3 ${i > 0 ? "border-t border-gray-100" : ""} ${closed ? "opacity-70" : ""}`}>
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase text-gray-600">
                                        {KIND_LABEL[a.kind]}
                                    </span>
                                    <span className={`text-sm text-gray-800 ${closed ? "line-through" : ""}`}>{a.title}</span>
                                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${STATUS_STYLE[a.status]}`}>{STATUS_LABEL[a.status]}</span>
                                    <span
                                        className={`ml-auto text-xs tabular-nums ${!closed && a.days_left < 0 ? "font-medium text-red-700" : "text-gray-500"}`}
                                    >
                                        {a.due_date}
                                        {closed ? "" : ` · ${dueLabel(a.days_left)}`}
                                    </span>
                                </div>
                                {a.source_quote && (
                                    <p className="line-clamp-2 border-l-2 border-gray-200 pl-2 text-[11px] italic text-gray-500">{a.source_quote}</p>
                                )}
                                <div className="flex flex-wrap items-center gap-1">
                                    <ObligationOwnerEditor item={a} me={me} people={people} onSaved={() => void load()} />
                                    <span className="mx-1 text-gray-300" aria-hidden>
                                        ·
                                    </span>
                                    {a.status === "aberto" ? (
                                        <>
                                            <button className={ACTION} disabled={busy === a.id} onClick={() => void setStatus(a, "feito")}>
                                                <Check className="h-3 w-3" aria-hidden /> Dar baixa
                                            </button>
                                            <button className={ACTION} disabled={busy === a.id} onClick={() => void setStatus(a, "dispensado")}>
                                                <X className="h-3 w-3" aria-hidden /> Dispensar
                                            </button>
                                        </>
                                    ) : (
                                        <button className={ACTION} disabled={busy === a.id} onClick={() => void setStatus(a, "aberto")}>
                                            <RotateCcw className="h-3 w-3" aria-hidden /> Reabrir
                                        </button>
                                    )}
                                    <button className={ACTION} disabled={busy === a.id} onClick={() => void createEvent(a)}>
                                        <CalendarPlus className="h-3 w-3" aria-hidden /> Criar evento
                                    </button>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
