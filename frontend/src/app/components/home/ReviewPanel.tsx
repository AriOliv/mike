"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Diamond, ExternalLink, RotateCw, UserPlus } from "lucide-react";
import { DetailPanel } from "@/app/components/shared/DetailPanel";
import { ActivityFeed } from "@/app/components/shared/ActivityFeed";
import { StatusChip } from "@/app/components/ui/status-chip";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { pillButtonUIClassName } from "@/shared/ui/PillButtonUI.styles";
import { CitationPillUI } from "@/shared/ui/CitationPillUI";
import { VerdictCountsUI, type Verdict } from "@/shared/ui/VerdictUI";
import { toActivityItems } from "@/app/lib/activityFeed";
import { brDate, personName, reviewChip, summarySentences } from "@/app/lib/home";
import {
    getCardActivity,
    getProjectPeople,
    type CardEvent,
    type HomeReview,
} from "@/app/lib/mikeApi";
import { NoticeBadge } from "./HomeReviewTable";

const LANE_LABEL: Record<string, string> = {
    entrada: "Entrada",
    triagem: "Triagem",
    revisao: "Revisão",
    negociacao: "Negociação",
    assinatura: "Assinatura",
    arquivado: "Arquivado",
};

/**
 * The contract's review page: this run's findings when there is one (`run=`),
 * filtered to a verdict when given (`veredito=`). Without a run it opens the
 * contract's latest review, Ficha included.
 */
export function reviewHref(review: HomeReview, verdict?: Verdict | null): string {
    const params = new URLSearchParams();
    if (review.playbook_run_id) params.set("run", review.playbook_run_id);
    if (verdict) params.set("veredito", verdict);
    const query = params.toString();
    return `/projects/${review.project_id}/review${query ? `?${query}` : ""}`;
}

type Person = { email: string; name: string };

/** The people who can see the card, so a review is only ever given to one of them. */
function useCardPeople(projectId: string): Person[] | null {
    const [people, setPeople] = useState<{ id: string; list: Person[] } | null>(null);
    useEffect(() => {
        let live = true;
        getProjectPeople(projectId)
            .then((p) => {
                const all = [
                    ...(p.owner?.email ? [{ email: p.owner.email, name: p.owner.display_name }] : []),
                    ...p.members.map((m) => ({ email: m.email, name: m.display_name })),
                ];
                const seen = new Set<string>();
                const list = all
                    .map((x) => ({ email: x.email.toLowerCase(), name: x.name?.trim() || x.email.split("@")[0] }))
                    .filter((x) => !seen.has(x.email) && seen.add(x.email));
                if (live) setPeople({ id: projectId, list });
            })
            .catch(() => live && setPeople({ id: projectId, list: [] }));
        return () => {
            live = false;
        };
    }, [projectId]);
    return people?.id === projectId ? people.list : null;
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
    const router = useRouter();
    // Keyed by what was loaded, so a newer review reads as loading until it arrives.
    const feedKey = `${review.project_id}:${review.updated_at}`;
    const [feed, setFeed] = useState<{ key: string; events: CardEvent[] } | null>(null);
    const people = useCardPeople(review.project_id);

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
    const href = reviewHref(review);
    const finished = review.status === "ready" || review.status === "done";
    const assignee = review.assignee_email?.toLowerCase() ?? "";
    const options = people ?? [];
    // Someone assigned outside the card's people still shows as the current value.
    const listed = !assignee || options.some((p) => p.email === assignee);

    const select = (
        <select
            aria-label="Responsável"
            value={assignee}
            disabled={people === null}
            onChange={(e) => onAssign(review, e.target.value || null)}
            className="h-6 max-w-full min-w-0 rounded-md border border-gray-200 bg-app-surface px-1.5 text-xs text-gray-800 outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
            <option value="">Sem responsável</option>
            {!listed ? <option value={assignee}>{personName(assignee)}</option> : null}
            {options.map((p) => (
                <option key={p.email} value={p.email}>
                    {p.name}
                    {p.email === me ? " (você)" : ""}
                </option>
            ))}
        </select>
    );

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
                    value: (
                        <span className="flex flex-wrap items-center gap-2">
                            {select}
                            {me && assignee !== me ? (
                                <button
                                    type="button"
                                    onClick={() => onAssign(review, me)}
                                    className="text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                >
                                    assumir
                                </button>
                            ) : null}
                            {!assignee && review.suggested_assignee ? (
                                <span className="inline-flex items-center gap-1 text-violet-700">
                                    <Diamond aria-hidden="true" className="h-2.5 w-2.5 fill-current" />
                                    sugerido: {review.suggested_assignee}
                                </span>
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
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                            <NoticeBadge review={review} />
                            <span>até {brDate(review.notice_deadline)}</span>
                        </span>
                    ) : review.term_end ? (
                        `vence ${brDate(review.term_end)}, sem aviso no contrato`
                    ) : (
                        "O contrato não trata disso."
                    ),
                },
                {
                    label: "Ficha",
                    value: review.ficha ? (
                        <Link
                            href={`/projects/${review.project_id}`}
                            className="underline-offset-2 hover:text-gray-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                        >
                            {review.ficha.filled} de {review.ficha.total} campos preenchidos
                        </Link>
                    ) : (
                        "Ainda não preenchida"
                    ),
                },
            ]}
            summary={
                review.status === "failed" ? (
                    <p className="text-red-700">{review.error ?? "A revisão falhou."}</p>
                ) : finished && review.summary ? (
                    <ol className="space-y-1">
                        {summarySentences(review.summary).map((sentence, index) => (
                            <li key={index}>
                                {sentence.text}{" "}
                                {sentence.clause ? (
                                    <CitationPillUI
                                        aria-label={`Ver a cláusula ${sentence.clause} na revisão`}
                                        title={`Cláusula ${sentence.clause}`}
                                        onClick={() => router.push(href)}
                                        className="align-text-top"
                                    >
                                        {index + 1}
                                    </CitationPillUI>
                                ) : null}
                            </li>
                        ))}
                    </ol>
                ) : finished ? (
                    <p className="text-gray-500">Sem resumo para este contrato.</p>
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
                            onSelect={(verdict) => router.push(reviewHref(review, verdict))}
                        />
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                        {review.status === "ready" ? (
                            <PillButtonUI tone="black" size="sm" onClick={() => onAccept(review)}>
                                <Check aria-hidden="true" className="h-3.5 w-3.5" />
                                Aceitar revisão
                            </PillButtonUI>
                        ) : null}
                        {!assignee && me ? (
                            <PillButtonUI tone="white" size="sm" onClick={() => onAssign(review, me)}>
                                <UserPlus aria-hidden="true" className="h-3.5 w-3.5" />
                                Assumir
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
