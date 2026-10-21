"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, ExternalLink, RotateCw, UserPlus } from "lucide-react";
import { DetailPanel } from "@/app/components/shared/DetailPanel";
import { ActivityFeed } from "@/app/components/shared/ActivityFeed";
import { StatusChip } from "@/app/components/ui/status-chip";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { pillButtonUIClassName } from "@/shared/ui/PillButtonUI.styles";
import { VerdictCountsUI } from "@/shared/ui/VerdictUI";
import { toActivityItems } from "@/app/lib/activityFeed";
import { brDate, personName, reviewChip } from "@/app/lib/home";
import { getCardActivity, type CardEvent, type HomeReview } from "@/app/lib/mikeApi";
import { playbookRunPath } from "@/app/lib/playbookRunActivity";
import { NoticeBadge } from "./HomeReviewTable";

const LANE_LABEL: Record<string, string> = {
    entrada: "Entrada",
    triagem: "Triagem",
    revisao: "Revisão",
    negociacao: "Negociação",
    assinatura: "Assinatura",
    arquivado: "Arquivado",
};

/** Where "Abrir" goes: the playbook's findings when there are some, else the card. */
export function reviewHref(review: HomeReview): string {
    return review.playbook_id && review.playbook_run_id
        ? playbookRunPath({ id: review.playbook_run_id, playbookId: review.playbook_id })
        : `/projects/${review.project_id}`;
}

export function ReviewPanel({
    review,
    me,
    onClose,
    onAccept,
    onAssign,
    onRetry,
}: {
    review: HomeReview;
    me: string | null;
    onClose: () => void;
    onAccept: (review: HomeReview) => void;
    onAssign: (review: HomeReview, email: string | null) => void;
    onRetry: (review: HomeReview) => void;
}) {
    // Keyed by what was loaded, so a newer review reads as loading until it arrives.
    const feedKey = `${review.project_id}:${review.updated_at}`;
    const [feed, setFeed] = useState<{ key: string; events: CardEvent[] } | null>(null);
    const [assigning, setAssigning] = useState(false);
    const [email, setEmail] = useState(review.assignee_email ?? "");

    useEffect(() => {
        let live = true;
        getCardActivity(review.project_id, 20)
            .then((events) => live && setFeed({ key: feedKey, events }))
            .catch(() => live && setFeed({ key: feedKey, events: [] }));
        return () => {
            live = false;
        };
    }, [review.project_id, feedKey]);
    const events = feed?.key === feedKey ? feed.events : null;

    const chip = reviewChip(review);
    const owner = personName(review.assignee_email);
    const href = reviewHref(review);
    const finished = review.status === "ready" || review.status === "done";

    return (
        <DetailPanel
            title={review.filename ?? review.project_name}
            subtitle={review.project_name}
            onClose={onClose}
            actions={
                <Link href={href} className={pillButtonUIClassName({ tone: "white", size: "xs" })}>
                    <ExternalLink aria-hidden="true" className="h-3 w-3" />
                    Abrir revisão
                </Link>
            }
            fields={[
                { label: "Contraparte", value: review.counterparty ?? "Não informada" },
                {
                    label: "Status",
                    value: <StatusChip status={chip.status} label={chip.label} />,
                },
                {
                    label: "Etapa",
                    value: review.lane ? LANE_LABEL[review.lane] ?? review.lane : "Fora da esteira",
                },
                {
                    label: "Responsável",
                    value: assigning ? (
                        <form
                            className="flex items-center gap-1.5"
                            onSubmit={(e) => {
                                e.preventDefault();
                                onAssign(review, email.trim() || null);
                                setAssigning(false);
                            }}
                        >
                            <input
                                autoFocus
                                type="email"
                                aria-label="E-mail do responsável"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="nome@avenia.io"
                                className="h-6 min-w-0 flex-1 rounded-md border border-gray-200 bg-app-surface px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                            />
                            <PillButtonUI tone="black" size="xs" type="submit">
                                Salvar
                            </PillButtonUI>
                        </form>
                    ) : (
                        <span className="flex flex-wrap items-center gap-2">
                            <span>{owner ?? "Sem responsável"}</span>
                            <button
                                type="button"
                                onClick={() => setAssigning(true)}
                                className="text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                            >
                                trocar
                            </button>
                            {me && review.assignee_email !== me ? (
                                <button
                                    type="button"
                                    onClick={() => onAssign(review, me)}
                                    className="text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                >
                                    assumir
                                </button>
                            ) : null}
                        </span>
                    ),
                },
                { label: "Pedido", value: review.requester_name ? `de ${review.requester_name}` : "Sem pedido de origem" },
                { label: "Prazo", value: review.deadline ? brDate(review.deadline) : "Sem prazo" },
                {
                    label: "Aviso prévio",
                    emphasis: !!review.notice_deadline,
                    value: review.notice_deadline ? (
                        <span className="inline-flex items-center gap-1.5">
                            <NoticeBadge review={review} />
                            <span>até {brDate(review.notice_deadline)}</span>
                        </span>
                    ) : review.term_end ? (
                        `vence ${brDate(review.term_end)}, sem aviso no contrato`
                    ) : (
                        "O contrato não trata disso."
                    ),
                },
            ]}
            summary={
                review.status === "failed" ? (
                    <p className="text-red-700">{review.error ?? "A revisão falhou."}</p>
                ) : finished ? (
                    review.summary
                ) : (
                    <p className="text-gray-500">Estou lendo este contrato. O resumo aparece aqui quando eu terminar.</p>
                )
            }
            aside={
                <div className="space-y-3">
                    {finished && review.playbook_id ? (
                        <VerdictCountsUI
                            variant="tiles"
                            alinhado={review.aligned}
                            precisa_revisao={review.needs_review}
                            diverge={review.deviates}
                        />
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                        {review.status === "ready" ? (
                            <PillButtonUI tone="black" size="sm" onClick={() => onAccept(review)}>
                                <Check aria-hidden="true" className="h-3.5 w-3.5" />
                                Aceitar revisão
                            </PillButtonUI>
                        ) : null}
                        {!review.assignee_email ? (
                            <PillButtonUI tone="white" size="sm" onClick={() => setAssigning(true)}>
                                <UserPlus aria-hidden="true" className="h-3.5 w-3.5" />
                                Atribuir
                            </PillButtonUI>
                        ) : null}
                        {review.status === "failed" || finished ? (
                            <PillButtonUI tone="white" size="sm" onClick={() => onRetry(review)}>
                                <RotateCw aria-hidden="true" className="h-3.5 w-3.5" />
                                {review.status === "failed" ? "Tentar de novo" : "Revisar de novo"}
                            </PillButtonUI>
                        ) : null}
                    </div>
                </div>
            }
            activity={
                <ActivityFeed
                    loading={events === null}
                    items={toActivityItems(events ?? [], (e) =>
                        e.action === "review.completed" ? reviewHref(review) : undefined,
                    )}
                    limit={6}
                    emptyText="Nenhuma atividade neste contrato ainda."
                />
            }
        />
    );
}
