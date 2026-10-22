"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ExternalLink, Send, UserPlus, X } from "lucide-react";
import { DetailPanel } from "@/app/components/shared/DetailPanel";
import { ActivityFeed } from "@/app/components/shared/ActivityFeed";
import { AgentPlan } from "@/app/components/shared/AgentPlan";
import { StageStrip } from "./StageStrip";
import { StatusChip } from "@/app/components/ui/status-chip";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import {
    assignRequest,
    decideRequestTriage,
    deliverRequest,
    getCardActivity,
    getRequest,
    inviteRequestParticipant,
    postRequestMessage,
    requestContractAnalysis,
    revokeRequestParticipant,
    type LegalRequest,
} from "@/app/lib/mikeApi";
import { toActivityItems } from "@/app/lib/activityFeed";
import {
    CHANNEL_LABEL,
    formatDate,
    requestPlan,
    slaText,
    requestChip,
} from "@/app/lib/requests";
import { notifyError } from "@/app/lib/userFacingError";
import { showToast } from "@/app/components/ui/toast";
import { RequestConversation } from "./RequestConversation";
import { RequestIntakeSection } from "./IntakeChecklist";
import { CriticalAlertBanner } from "./CriticalAlerts";
import { AnalystAnalysisView } from "@/app/components/contract-review/AnalystAnalysisView";
import { ExternalChip } from "./ExternalChip";
import { TriageSuggestion, type TriageDecision } from "./TriageSuggestion";

const FIELD =
    "w-full rounded-lg border border-gray-200 bg-app-surface px-2 py-1.5 text-xs text-gray-900 placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40";

/** Critical risks the analysis found, from the card's alert event. */
function criticalCount(events: { action: string; after?: unknown }[]): number {
    const alert = events.find((e) => e.action === "request.critical_alert");
    const n = Number((alert?.after as { critical?: unknown } | null | undefined)?.critical ?? 0);
    return n > 0 ? n : 1;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="mt-6">
            <h3 className="mb-2 text-xs font-medium text-gray-500">{title}</h3>
            {children}
        </section>
    );
}

/**
 * One request, for the legal team, over the list: the request, the triage
 * agent's suggestion to accept/edit/reject, the plan (agents and people),
 * the conversation with whoever asked, outside participants, delivery and
 * the card's activity.
 */
export function RequestPanel({
    requestId,
    team,
    onClose,
    onChanged,
}: {
    requestId: string;
    team: { id: string; name: string; email: string }[];
    onClose: () => void;
    onChanged: () => void;
}) {
    const [request, setRequest] = useState<LegalRequest | null>(null);
    const [events, setEvents] = useState<Awaited<ReturnType<typeof getCardActivity>>>([]);
    const [busy, setBusy] = useState<string | null>(null);
    const [inviteOpen, setInviteOpen] = useState(false);
    const [inviteEmail, setInviteEmail] = useState("");
    const [inviteLabel, setInviteLabel] = useState("");
    const [deliverOpen, setDeliverOpen] = useState(false);
    const [deliverText, setDeliverText] = useState("");

    const [reloadKey, setReloadKey] = useState(0);

    useEffect(() => {
        let cancelled = false;
        setRequest(null);
        setEvents([]);
        (async () => {
            try {
                const data = await getRequest(requestId);
                if (cancelled) return;
                setRequest(data);
                const activity = data.project_id ? await getCardActivity(data.project_id, 30).catch(() => []) : [];
                if (!cancelled) setEvents(activity);
            } catch (err) {
                if (!cancelled)
                    notifyError(err, { lang: "pt", action: "abrir este pedido", onRetry: () => setReloadKey((k) => k + 1) });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [requestId, reloadKey]);

    /**
     * Runs a change, refreshes the panel and confirms with a toast. A change
     * that can be taken back offers Desfazer for 10 s instead of asking first.
     */
    async function run(
        label: string,
        action: () => Promise<LegalRequest>,
        done?: string,
        undo?: () => Promise<LegalRequest>,
    ) {
        setBusy(label);
        try {
            const updated = await action();
            setRequest(updated);
            if (updated.project_id) setEvents(await getCardActivity(updated.project_id, 30).catch(() => events));
            onChanged();
            if (done)
                showToast({
                    tone: "success",
                    message: done,
                    ...(undo
                        ? {
                              durationMs: 10_000,
                              actions: [{ label: "Desfazer", onClick: () => run("desfazer", undo, "Desfeito.") }],
                          }
                        : {}),
                });
        } catch (err) {
            notifyError(err, { lang: "pt", action: label });
        } finally {
            setBusy(null);
        }
    }

    if (!request) {
        return (
            <DetailPanel
                title={<span className="inline-block h-6 w-48 animate-pulse rounded bg-gray-100" />}
                fields={["Status", "Prazo", "Responsável", "Solicitante"].map((label) => ({
                    label,
                    value: <span className="inline-block h-3 w-32 animate-pulse rounded bg-gray-100" />,
                }))}
                onClose={onClose}
            />
        );
    }

    const r = request;
    const open = r.status !== "entregue" && r.status !== "cancelado";
    const reopen = async () => {
        const reopened = await decideRequestTriage(r.id, { decision: "reopened" });
        // The decision may have handed the request to someone: hand it back.
        if ((reopened.assignee_id ?? null) !== (r.assignee_id ?? null)) return assignRequest(r.id, r.assignee_id ?? null);
        return reopened;
    };
    const decide = (d: TriageDecision) =>
        run(
            "decidir a triagem",
            () => decideRequestTriage(r.id, d),
            d.decision === "rejected" ? "Triagem recusada." : "Triagem aplicada.",
            reopen,
        );
    const assign = (assigneeId: string | null) => {
        const previous = r.assignee_id ?? null;
        return run(
            "trocar o responsável",
            () => assignRequest(r.id, assigneeId),
            "Responsável atualizado.",
            () => assignRequest(r.id, previous),
        );
    };
    const focusAssignee = () => document.getElementById(`assignee-${r.id}`)?.focus();
    const chip = requestChip(r.status, { triaged: !!r.triage, pending: !!r.triage && !r.triage.decision });

    return (
        <DetailPanel
            title={r.title}
            subtitle={
                <>
                    <span className="font-mono">{r.code}</span> · {r.kind_label}
                    {r.counterparty ? ` · ${r.counterparty}` : ""}
                </>
            }
            actions={
                r.project_id ? (
                    <Link
                        href={`/projects/${r.project_id}`}
                        className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-gray-600 hover:bg-app-surface-hover hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                    >
                        Abrir card <ExternalLink aria-hidden="true" className="h-3 w-3" />
                    </Link>
                ) : null
            }
            fields={[
                { label: "Status", value: <StatusChip status={chip.status} label={chip.label} /> },
                {
                    label: "Prazo",
                    value: `${formatDate(r.due_at)} · ${slaText(r.sla, r.due_at)}`,
                    emphasis: r.sla === "estourado" || r.sla === "estourando",
                },
                {
                    label: "Responsável",
                    value: (
                        <select
                            id={`assignee-${r.id}`}
                            aria-label="Responsável"
                            className={FIELD + " py-1"}
                            value={r.assignee_id ?? ""}
                            disabled={!open || busy !== null}
                            onChange={(e) => assign(e.target.value || null)}
                        >
                            <option value="">Sem responsável</option>
                            {team.map((m) => (
                                <option key={m.id} value={m.id}>
                                    {m.name}
                                </option>
                            ))}
                        </select>
                    ),
                },
                {
                    label: "Solicitante",
                    value: (
                        <>
                            {r.requester_name ?? r.requester_email}
                            {r.requester_name ? <span className="block text-gray-500">{r.requester_email}</span> : null}
                        </>
                    ),
                },
                { label: "Área", value: r.requester_area ?? <span className="text-gray-500">não informada</span> },
                { label: "Canal", value: CHANNEL_LABEL[r.source?.channel ?? "form"] ?? r.source?.channel },
                { label: "Urgência", value: r.urgency === "normal" ? "Normal" : r.urgency === "alta" ? "Alta" : "Urgente" },
                ...(r.needed_by ? [{ label: "Precisa até", value: formatDate(`${r.needed_by}T12:00:00Z`) }] : []),
            ]}
            summary={
                <>
                    {r.summary ? (
                        <p>{r.summary}</p>
                    ) : (
                        <p className="text-gray-500">O agente de triagem ainda está lendo o pedido…</p>
                    )}
                    {r.context ? (
                        <details className="mt-2 text-xs text-gray-600">
                            <summary className="cursor-pointer text-gray-500">Pedido original</summary>
                            <p className="mt-1 whitespace-pre-wrap break-words">{r.context}</p>
                        </details>
                    ) : null}
                </>
            }
            aside={
                <>
                    {r.triage ? (
                        <TriageSuggestion
                            triage={r.triage}
                            currentKind={r.kind}
                            team={team}
                            canDecide={!!r.can_decide && open}
                            decidedBy={team.find((m) => m.id === r.triage?.decided_by)?.name}
                            busy={busy === "decide the triage"}
                            onDecide={decide}
                            onReopen={() => run("reabrir a triagem", reopen, "Triagem reaberta.")}
                        />
                    ) : (
                        <StatusChip status="rodando" label="Fazendo a triagem…" />
                    )}
                    {r.stage ? (
                        <StageStrip className="mt-5" stage={r.stage} stages={r.stages} />
                    ) : (
                        <AgentPlan
                            className="mt-5"
                            title="Plano"
                            steps={requestPlan(r)}
                            onChangeOwner={open && r.can_decide !== undefined ? focusAssignee : undefined}
                        />
                    )}

                    <Section title="Checklist do pedido">
                        <RequestIntakeSection
                            requestId={r.id}
                            audience="team"
                            reloadKey={reloadKey}
                            onChanged={() => {
                                if (r.project_id) getCardActivity(r.project_id, 30).then(setEvents, () => undefined);
                                onChanged();
                            }}
                        />
                    </Section>

                    {r.project_id ? (
                        <Section title="Análise do contrato">
                            {r.critical_alert_at ? <div className="mb-3"><CriticalAlertBanner critical={criticalCount(events)} /></div> : null}
                            {r.intake_completed_at ? null : (
                                <p className="mb-2 text-xs text-gray-500">
                                    A análise roda sozinha quando o checklist fecha e o contrato está no pedido.
                                </p>
                            )}
                            <AnalystAnalysisView
                                key={`${r.id}-${reloadKey}-${r.intake_completed_at ?? ""}`}
                                projectId={r.project_id}
                                canDecide={open}
                                onChanged={onChanged}
                            />
                            {open && r.intake_completed_at ? (
                                <PillButtonUI
                                    className="mt-2"
                                    tone="white"
                                    size="sm"
                                    loading={busy === "pedir a análise"}
                                    onClick={async () => {
                                        setBusy("pedir a análise");
                                        try {
                                            const started = await requestContractAnalysis(r.id);
                                            showToast({
                                                tone: "success",
                                                message: started.queued ? "Análise na fila. Leva alguns minutos." : "A análise deste contrato já existe.",
                                            });
                                            setReloadKey((k) => k + 1);
                                        } catch (err) {
                                            notifyError(err, { lang: "pt", action: "pedir a análise" });
                                        } finally {
                                            setBusy(null);
                                        }
                                    }}
                                >
                                    Analisar contrato
                                </PillButtonUI>
                            ) : null}
                        </Section>
                    ) : null}

                    <Section title="Conversa com o solicitante">
                        <RequestConversation
                            messages={r.messages}
                            mode={open ? "team" : "readonly"}
                            disabled={busy !== null}
                            onSend={(body, kind) =>
                                run(
                                    "enviar a mensagem",
                                    () => postRequestMessage(r.id, body, kind),
                                    kind === "question" ? "Pergunta enviada. O prazo fica pausado." : "Recado enviado.",
                                )
                            }
                        />
                    </Section>

                    <Section title="Quem mais acompanha">
                        {(r.participants ?? []).filter((p) => !p.revoked_at).length === 0 && !inviteOpen ? (
                            <p className="text-xs text-gray-500">
                                Só o time e quem pediu. Convide um escritório externo ou alguém da área para este pedido.
                            </p>
                        ) : null}
                        <ul className="space-y-1.5 text-xs">
                            {(r.participants ?? [])
                                .filter((p) => !p.revoked_at)
                                .map((p) => (
                                    <li key={p.id} className="flex items-start gap-2">
                                        <div className="min-w-0 flex-1">
                                            <span className="break-all text-gray-900">{p.email}</span>
                                            <span className="block text-gray-500">
                                                {p.label ? `${p.label} · ` : ""}
                                                {p.role === "external" ? <ExternalChip /> : "Só acompanha"} · até {formatDate(p.expires_at)}
                                            </span>
                                        </div>
                                        <button
                                            type="button"
                                            aria-label={`Remover acesso de ${p.email}`}
                                            onClick={() =>
                                                run("remover este acesso", () => revokeRequestParticipant(r.id, p.id), "Acesso removido.")
                                            }
                                            className="rounded p-1 text-gray-400 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                        >
                                            <X aria-hidden="true" className="h-3 w-3" />
                                        </button>
                                    </li>
                                ))}
                        </ul>
                        {inviteOpen ? (
                            <form
                                className="mt-2 space-y-2"
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    void run(
                                        "convidar esta pessoa",
                                        () =>
                                            inviteRequestParticipant(r.id, {
                                                email: inviteEmail.trim(),
                                                label: inviteLabel.trim() || undefined,
                                            }),
                                        "Convite enviado por e-mail.",
                                    ).then(() => {
                                        setInviteOpen(false);
                                        setInviteEmail("");
                                        setInviteLabel("");
                                    });
                                }}
                            >
                                <input
                                    autoFocus
                                    type="email"
                                    required
                                    aria-label="E-mail do convidado"
                                    placeholder="e-mail@escritorio.com.br"
                                    className={FIELD}
                                    value={inviteEmail}
                                    onChange={(e) => setInviteEmail(e.target.value)}
                                />
                                <input
                                    aria-label="Quem é (opcional)"
                                    placeholder="Quem é (ex.: Escritório X · Societário)"
                                    className={FIELD}
                                    value={inviteLabel}
                                    onChange={(e) => setInviteLabel(e.target.value)}
                                />
                                <p className="text-[11px] text-gray-500">
                                    Vê só este pedido (status, conversa e entrega), nunca o card nem a carteira. Expira em 90 dias.
                                </p>
                                <div className="flex gap-2">
                                    <PillButtonUI tone="black" size="xs" type="submit" loading={busy === "convidar esta pessoa"}>
                                        Convidar
                                    </PillButtonUI>
                                    <PillButtonUI tone="white" size="xs" onClick={() => setInviteOpen(false)}>
                                        Cancelar
                                    </PillButtonUI>
                                </div>
                            </form>
                        ) : open ? (
                            <PillButtonUI tone="white" size="xs" className="mt-2" onClick={() => setInviteOpen(true)}>
                                <UserPlus aria-hidden="true" className="h-3 w-3" />
                                Convidar
                            </PillButtonUI>
                        ) : null}
                    </Section>

                    <Section title="Entrega">
                        {r.delivery ? (
                            <div className="text-xs">
                                <p className="text-gray-500">Entregue {r.delivery.delivered_at ? formatDate(r.delivery.delivered_at) : ""}</p>
                                {r.delivery.message ? <p className="mt-1 whitespace-pre-wrap text-gray-800">{r.delivery.message}</p> : null}
                            </div>
                        ) : deliverOpen ? (
                            <form
                                className="space-y-2"
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    void run(
                                        "entregar este pedido",
                                        () => deliverRequest(r.id, { message: deliverText.trim() }),
                                        "Entregue. Quem pediu recebeu por e-mail.",
                                    ).then(() => setDeliverOpen(false));
                                }}
                            >
                                <textarea
                                    autoFocus
                                    aria-label="Devolutiva"
                                    placeholder="O que você conclui e o que a pessoa deve fazer agora."
                                    className={FIELD + " min-h-[80px] resize-y"}
                                    value={deliverText}
                                    onChange={(e) => setDeliverText(e.target.value)}
                                />
                                <p className="text-[11px] text-gray-500">
                                    Vai sair por e-mail para {r.requester_email}
                                    {(r.participants ?? []).some((p) => !p.revoked_at) ? " e fica visível para os convidados" : ""}.
                                </p>
                                <div className="flex gap-2">
                                    <PillButtonUI
                                        tone="black"
                                        size="xs"
                                        type="submit"
                                        disabled={!deliverText.trim()}
                                        loading={busy === "entregar este pedido"}
                                    >
                                        <Send aria-hidden="true" className="h-3 w-3" />
                                        Pode enviar
                                    </PillButtonUI>
                                    <PillButtonUI tone="white" size="xs" onClick={() => setDeliverOpen(false)}>
                                        Cancelar
                                    </PillButtonUI>
                                </div>
                            </form>
                        ) : (
                            <PillButtonUI tone="white" size="xs" onClick={() => setDeliverOpen(true)}>
                                Entregar ao solicitante
                            </PillButtonUI>
                        )}
                    </Section>
                </>
            }
            activity={
                <ActivityFeed
                    items={toActivityItems(events)}
                    limit={8}
                    emptyText="O que pessoas e agentes fizerem neste pedido aparece aqui."
                />
            }
            onClose={onClose}
        />
    );
}
