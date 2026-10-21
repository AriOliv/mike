"use client";

import { useState } from "react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { AgentSuggestion } from "@/app/components/shared/AgentSuggestion";
import type { RequestKind, RequestTriage } from "@/app/lib/mikeApi";
import { KIND_OPTIONS } from "@/app/lib/requests";
import { relativeTime } from "@/app/lib/activityFeed";

const FIELD =
    "w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40";

export type TriageDecision =
    | { decision: "accepted" }
    | { decision: "edited"; kind: RequestKind; counterparty: string | null; assignee_id: string | null }
    | { decision: "rejected"; reason?: string };

const DECISION_KIND = { accepted: "aceito", edited: "editado", rejected: "rejeitado" } as const;

/**
 * The triage agent's suggestion on the shared AgentSuggestion card: what the
 * agent read (kind, counterparty, area, what is missing, playbook) and who it
 * suggests. Aceitar (a) applies it, Editar (e) opens the three fields,
 * Rejeitar (r) asks why. Decided, it folds into "Aceito por …"; clicking the
 * line reopens it.
 */
export function TriageSuggestion({
    triage,
    currentKind,
    team,
    canDecide,
    busy,
    onDecide,
    onReopen,
    decidedBy,
    now,
}: {
    triage: RequestTriage;
    currentKind: RequestKind;
    team: { id: string; name: string }[];
    canDecide: boolean;
    busy?: boolean;
    onDecide: (decision: TriageDecision) => void;
    /** Takes the decision back (the toast's Desfazer, or a click on the folded line). */
    onReopen?: () => void;
    /** Who decided, for the folded line. */
    decidedBy?: string;
    now?: number;
}) {
    const [editing, setEditing] = useState(false);
    const [kind, setKind] = useState<RequestKind>(triage.kind ?? currentKind);
    const [counterparty, setCounterparty] = useState(triage.counterparty ?? "");
    const [assignee, setAssignee] = useState(triage.assignee_id ?? "");

    const kindLabel = KIND_OPTIONS.find((k) => k.value === (triage.kind ?? currentKind))?.label ?? triage.kind;
    const meta = [
        triage.suggested_at ? relativeTime(triage.suggested_at, now) : null,
        "sugerido",
        triage.ai === false ? "sem IA (regras)" : null,
    ]
        .filter(Boolean)
        .join(" · ");

    const editor = (
        <form
            className="space-y-2"
            aria-label="Ajustar triagem"
            onSubmit={(e) => {
                e.preventDefault();
                setEditing(false);
                onDecide({
                    decision: "edited",
                    kind,
                    counterparty: counterparty.trim() || null,
                    assignee_id: assignee || null,
                });
            }}
        >
            <label className="block text-xs">
                <span className="mb-0.5 block text-gray-500">Tipo</span>
                <select className={FIELD} value={kind} onChange={(e) => setKind(e.target.value as RequestKind)}>
                    {KIND_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                            {o.label}
                        </option>
                    ))}
                </select>
            </label>
            <label className="block text-xs">
                <span className="mb-0.5 block text-gray-500">Contraparte</span>
                <input className={FIELD} value={counterparty} onChange={(e) => setCounterparty(e.target.value)} />
            </label>
            <label className="block text-xs">
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
            <PillButtonUI tone="black" size="sm" type="submit" loading={busy}>
                Salvar
            </PillButtonUI>
        </form>
    );

    return (
        <AgentSuggestion
            agent="Agente de triagem"
            meta={meta}
            title={
                <>
                    {kindLabel}
                    {triage.kind_changed ? <span className="font-normal text-gray-500"> (o pedido dizia outro)</span> : null}
                </>
            }
            decision={
                triage.decision
                    ? {
                          kind: DECISION_KIND[triage.decision],
                          by: decidedBy ?? "liderança do Legal",
                          at: triage.decided_at ?? "",
                      }
                    : null
            }
            canDecide={canDecide}
            busy={busy}
            onAccept={() => onDecide({ decision: "accepted" })}
            editor={editor}
            editing={editing}
            onEditingChange={setEditing}
            onReject={(reason) => onDecide({ decision: "rejected", reason: reason || undefined })}
            onReopen={canDecide ? onReopen : undefined}
        >
            {editing ? null : (
                <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-xs">
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
            )}
            {!canDecide && !triage.decision ? (
                <p className="text-[11px] text-gray-500">A liderança do Legal confirma a triagem.</p>
            ) : null}
        </AgentSuggestion>
    );
}
