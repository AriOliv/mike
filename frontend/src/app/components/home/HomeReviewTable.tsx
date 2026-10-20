"use client";

import { FileText } from "lucide-react";
import { StatusChip } from "@/app/components/ui/status-chip";
import { UserAvatar } from "@/app/components/ui/user-avatar";
import {
    SkeletonLine,
    TableBody,
    TableCell,
    TableHeaderCell,
    TableHeaderRow,
    TableRow,
    TableScrollArea,
} from "@/app/components/shared/TablePrimitive";
import { VerdictCountsUI } from "@/shared/ui/VerdictUI";
import { relativeTime } from "@/app/lib/activityFeed";
import { deadlineBadge, personName, reviewChip } from "@/app/lib/home";
import type { HomeReview } from "@/app/lib/mikeApi";
import { cn } from "@/app/lib/utils";

const COLUMNS = {
    doc: "w-[18rem] min-w-[18rem] pl-3",
    status: "w-44",
    summary: "w-32",
    notice: "w-24",
    updated: "w-24",
    owner: "w-36",
};

const BADGE_TONE = {
    neutro: "text-gray-500",
    atencao: "text-amber-700",
    critico: "text-red-700 font-medium",
} as const;

/** The D-xx of a contract's notice deadline, or a dash. */
export function DeadlineCell({ date, today }: { date: string | null; today?: string }) {
    if (!date) return <span className="text-gray-300">—</span>;
    const badge = deadlineBadge(date, today);
    return (
        <span title={badge.title} className={cn("font-mono text-[11px]", BADGE_TONE[badge.tone])}>
            {badge.text}
        </span>
    );
}

export function HomeReviewTable({
    reviews,
    loading,
    selectedId,
    onOpen,
    empty,
    now,
}: {
    reviews: HomeReview[];
    loading: boolean;
    selectedId: string | null;
    onOpen: (review: HomeReview) => void;
    empty: React.ReactNode;
    now?: number;
}) {
    const header = (
        <TableHeaderRow>
            <TableHeaderCell className={COLUMNS.doc}>Documento</TableHeaderCell>
            <TableHeaderCell className={COLUMNS.status}>Status</TableHeaderCell>
            <TableHeaderCell className={COLUMNS.summary}>Resumo IA</TableHeaderCell>
            <TableHeaderCell className={COLUMNS.notice}>Aviso</TableHeaderCell>
            <TableHeaderCell className={COLUMNS.updated}>Atualizado</TableHeaderCell>
            <TableHeaderCell className={COLUMNS.owner}>Responsável</TableHeaderCell>
        </TableHeaderRow>
    );
    return (
        <TableScrollArea header={header} className="mx-0 mb-0 md:mx-0 md:mb-0">
            <TableBody role="list" aria-label="Revisões" aria-busy={loading || undefined}>
                {loading
                    ? [0, 1, 2, 3].map((i) => (
                          <div key={i} className="flex h-11 items-center pr-3">
                              <div className={COLUMNS.doc}>
                                  <SkeletonLine className="w-40" />
                              </div>
                              <div className={COLUMNS.status}>
                                  <SkeletonLine className="w-24" />
                              </div>
                              <div className={COLUMNS.summary}>
                                  <SkeletonLine className="w-16" />
                              </div>
                          </div>
                      ))
                    : reviews.length === 0
                      ? empty
                      : reviews.map((review) => {
                            const chip = reviewChip(review);
                            const selected = review.id === selectedId;
                            const owner = personName(review.assignee_email);
                            return (
                                <TableRow
                                    key={review.id}
                                    role="listitem"
                                    selected={selected}
                                    tabIndex={0}
                                    aria-current={selected || undefined}
                                    data-review={review.id}
                                    onClick={() => onOpen(review)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") onOpen(review);
                                    }}
                                    className="h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40"
                                >
                                    <div className={cn("flex min-w-0 items-center gap-2", COLUMNS.doc)}>
                                        <FileText aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                                        <div className="min-w-0">
                                            <p className="truncate text-xs text-gray-900">
                                                {review.filename ?? review.project_name}
                                            </p>
                                            <p className="truncate text-[11px] text-gray-500">
                                                {review.counterparty ?? review.project_name}
                                            </p>
                                        </div>
                                    </div>
                                    <TableCell className={COLUMNS.status}>
                                        <StatusChip status={chip.status} label={chip.label} />
                                    </TableCell>
                                    <TableCell className={COLUMNS.summary}>
                                        {review.status === "ready" || review.status === "done" ? (
                                            <VerdictCountsUI
                                                alinhado={review.aligned}
                                                precisa_revisao={review.needs_review}
                                                diverge={review.deviates}
                                            />
                                        ) : (
                                            <span className="text-gray-300">—</span>
                                        )}
                                    </TableCell>
                                    <TableCell className={COLUMNS.notice}>
                                        <DeadlineCell date={review.notice_deadline} />
                                    </TableCell>
                                    <TableCell className={COLUMNS.updated}>
                                        {relativeTime(review.updated_at, now)}
                                    </TableCell>
                                    <TableCell className={cn("flex items-center gap-1.5", COLUMNS.owner)}>
                                        {owner ? (
                                            <>
                                                <UserAvatar size="sm" email={review.assignee_email} />
                                                <span className="truncate text-gray-700">{owner}</span>
                                            </>
                                        ) : (
                                            <span className="text-gray-400">Sem responsável</span>
                                        )}
                                    </TableCell>
                                </TableRow>
                            );
                        })}
            </TableBody>
        </TableScrollArea>
    );
}
