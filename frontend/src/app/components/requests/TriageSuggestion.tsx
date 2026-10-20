"use client";

import { useEffect, useState } from "react";
import { Check, Diamond, Pencil, X } from "lucide-react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import type { RequestKind, RequestTriage } from "@/app/lib/mikeApi";
import { KIND_OPTIONS } from "@/app/lib/requests";
import { relativeTime } from "@/app/lib/activityFeed";

const FIELD =
    "w-full rounded-lg border border-gray-200 bg-app-surface px-2 py-1.5 text-xs text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40";

export type TriageDecision =
    | { decision: "accepted" }
    | { decision: "edited"; kind: RequestKind; counterparty: string | null; assignee_id: string | null }
    | { decision: "rejected"; reason?: string };

/**
 * The triage agent's suggestion as one card the Head decides in one click:
 * Aceitar (a), Editar (e), Rejeitar (r). Decided, it folds into one line.
 * Local to Pedidos until the shared AgentSuggestion lands; same look (§4.7).
 */
export function TriageSuggestion({
    triage,
    currentKind,
    team,
    canDecide,
    busy,
    onDecide,
    now,
}: {
    triage: RequestTriage;
    currentKind: RequestKind;
    team: { id: string; name: string }[];
    canDecide: boolean;
    busy?: boolean;
    onDecide: (decision: TriageDecision) => void;
    now?: number;
}) {
    const [mode, setMode] = useState<"view" | "edit" | "reject">("view");
    const [kind, setKind] = useState<RequestKind>(triage.kind ?? currentKind);
    const [counterparty, setCounterparty] = useState(triage.counterparty ?? "");
    const [assignee, setAssignee] = useState(triage.assignee_id ?? "");
    const [reason, setReason] = useState("");

    useEffect(() => {
        if (!canDecide || triage.decision || mode !== "view") return;
        const onKey = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            if (event.key === "a") onDecide({ decision: "accepted" });
            if (event.key === "e") setMode("edit");
            if (event.key === "r") setMode("reject");
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [canDecide, triage.decision, mode, onDecide]);

    const kindLabel = KIND_OPTIONS.find((k) => k.value === (triage.kind ?? currentKind))?.label ?? triage.kind;

    if (triage.decision) {
        const verb = triage.decision === "accepted" ? "Aceita" : triage.decision === "edited" ? "Ajustada" : "Recusada";
        return (
            <p className="flex items-center gap-1.5 text-xs text-gray-500">
                <Check aria-hidden="true" className="h-3 w-3" />
                Triagem {verb.toLowerCase()}
                {triage.decided_at ? ` · ${relativeTime(triage.decided_at, now)}` : ""}
            </p>
        );
    }

    return (
        <section
            aria-label="Sugestão do agente de triagem"
            className="rounded-xl border border-violet-200/70 bg-violet-50/40 p-3 text-xs dark:border-violet-500/30"
        >
            <header className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-violet-700">
                <Diamond aria-hidden="true" className="h-3 w-3 fill-current" />
                <span className="font-medium">Agente de triagem</span>
                {triage.suggested_at ? <span className="text-gray-500">· {relativeTime(triage.suggested_at, now)}</span> : null}
                <span className="text-gray-500">· sugerido</span>
                {triage.ai === false ? <span className="text-gray-500">· sem IA (regras)</span> : null}
            </header>

            {mode === "edit" ? (
                <div className="space-y-2">
                    <label className="block">
                        <span className="mb-0.5 block text-gray-500">Tipo</span>
                        <select className={FIELD} value={kind} onChange={(e) => setKind(e.target.value as RequestKind)}>
                            {KIND_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>
                                    {o.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="block">
                        <span className="mb-0.5 block text-gray-500">Contraparte</span>
                        <input className={FIELD} value={counterparty} onChange={(e) => setCounterparty(e.target.value)} />
                    </label>
                    <label className="block">
                        <span className="mb-0.5 block text-gray-500">Responsável</span>
                        <select className={FIELD} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                            <option value="">Ninguém ainda</option>
                            {team.map((m) => (
                                <option key={m.id} value={m.id}>
                                    {m.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    <div className="flex gap-2 pt-1">
                        <PillButtonUI
                            tone="black"
                            size="xs"
                            loading={busy}
                            onClick={() =>
                                onDecide({
                                    decision: "edited",
                                    kind,
                                    counterparty: counterparty.trim() || null,
                                    assignee_id: assignee || null,
                                })
                            }
                        >
                            Salvar
                        </PillButtonUI>
                        <PillButtonUI tone="white" size="xs" onClick={() => setMode("view")}>
                            Cancelar
                        </PillButtonUI>
                    </div>
                </div>
            ) : (
                <>
                    <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-2 gap-y-1.5">
                        <dt className="text-gray-500">Tipo</dt>
                        <dd className="break-words text-gray-900">
                            {kindLabel}
                            {triage.kind_changed ? <span className="text-gray-500"> (o pedido dizia outro)</span> : null}
                        </dd>
                        <dt className="text-gray-500">Contraparte</dt>
                        <dd className="break-words text-gray-900">{triage.counterparty || "não identificada"}</dd>
                        {triage.area ? (
                            <>
                                <dt className="text-gray-500">Área</dt>
                                <dd className="text-gray-900">{triage.area}</dd>
                            </>
                        ) : null}
                        <dt className="text-gray-500">Responsável</dt>
                        <dd className="break-words text-gray-900">
                            {triage.assignee_name ?? "ninguém disponível"}
                            {triage.assignee_reason ? (
                                <span className="block text-[11px] text-gray-500">{triage.assignee_reason}</span>
                            ) : null}
                        </dd>
                        <dt className="text-gray-500">Playbook</dt>
                        <dd className="break-words text-gray-900">{triage.playbook_name ?? "nenhum compatível"}</dd>
                        {triage.missing?.length ? (
                            <>
                                <dt className="text-gray-500">Falta</dt>
                                <dd className="text-amber-700">
                                    <ul className="list-inside list-disc">
                                        {triage.missing.map((m) => (
                                            <li key={m} className="break-words">
                                                {m}
                                            </li>
                                        ))}
                                    </ul>
                                </dd>
                            </>
                        ) : null}
                    </dl>

                    {mode === "reject" ? (
                        <form
                            className="mt-3 flex flex-wrap items-center gap-2"
                            onSubmit={(e) => {
                                e.preventDefault();
                                onDecide({ decision: "rejected", reason: reason.trim() || undefined });
                            }}
                        >
                            <input
                                autoFocus
                                aria-label="Por quê? (opcional)"
                                placeholder="Por quê? (opcional, Enter confirma)"
                                className={FIELD + " min-w-0 flex-1"}
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                onKeyDown={(e) => e.key === "Escape" && setMode("view")}
                            />
                            <PillButtonUI tone="white" size="xs" type="submit" loading={busy}>
                                Rejeitar
                            </PillButtonUI>
                        </form>
                    ) : canDecide ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                            <PillButtonUI
                                tone="black"
                                size="xs"
                                loading={busy}
                                onClick={() => onDecide({ decision: "accepted" })}
                                aria-keyshortcuts="a"
                            >
                                <Check aria-hidden="true" className="h-3 w-3" />
                                Aceitar <kbd className="ml-1 font-mono text-[10px] opacity-60">a</kbd>
                            </PillButtonUI>
                            <PillButtonUI tone="white" size="xs" onClick={() => setMode("edit")} aria-keyshortcuts="e">
                                <Pencil aria-hidden="true" className="h-3 w-3" />
                                Editar <kbd className="ml-1 font-mono text-[10px] opacity-60">e</kbd>
                            </PillButtonUI>
                            <PillButtonUI tone="white" size="xs" onClick={() => setMode("reject")} aria-keyshortcuts="r">
                                <X aria-hidden="true" className="h-3 w-3" />
                                Rejeitar <kbd className="ml-1 font-mono text-[10px] opacity-60">r</kbd>
                            </PillButtonUI>
                        </div>
                    ) : (
                        <p className="mt-3 text-[11px] text-gray-500">A liderança do Legal confirma a triagem.</p>
                    )}
                </>
            )}
        </section>
    );
}
