"use client";

import Link from "next/link";
import { Diamond, MessageSquare, Settings2 } from "lucide-react";
import { UserAvatar } from "@/app/components/ui/user-avatar";
import { activitySentence, relativeTime, type ActivityItem } from "@/app/lib/activityFeed";
import { cn } from "@/app/lib/utils";

export type { ActivityItem } from "@/app/lib/activityFeed";

function ActorMark({ item }: { item: ActivityItem }) {
    if (item.actorType === "agent")
        return (
            <span
                role="img"
                aria-label="Agente"
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-violet-50 text-violet-700"
            >
                <Diamond aria-hidden="true" className="h-2.5 w-2.5 fill-current" />
            </span>
        );
    if (item.actorType === "hermes")
        return (
            <span
                role="img"
                aria-label="Assistente"
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600"
            >
                <MessageSquare aria-hidden="true" className="h-2.5 w-2.5" />
            </span>
        );
    if (item.actorType === "system")
        return (
            <span
                role="img"
                aria-label="Sistema"
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-500"
            >
                <Settings2 aria-hidden="true" className="h-2.5 w-2.5" />
            </span>
        );
    return <UserAvatar size="sm" name={item.actorName} />;
}

export type ActivityFeedProps = {
    items: ActivityItem[];
    /** Shows only the newest N, with a "ver tudo" link when there are more. */
    limit?: number;
    seeAllHref?: string;
    loading?: boolean;
    /** What to say when nothing happened yet. */
    emptyText?: string;
    now?: number;
    className?: string;
};

/**
 * One timeline for people and agents. A person is a monogram; an agent is a
 * violet diamond; every line says who, what, with how many sources, and when.
 */
export function ActivityFeed({
    items,
    limit,
    seeAllHref,
    loading = false,
    emptyText = "Nada aconteceu aqui ainda.",
    now,
    className,
}: ActivityFeedProps) {
    if (loading)
        return (
            <ul aria-busy="true" className={cn("space-y-2.5", className)}>
                {[0, 1, 2].map((i) => (
                    <li key={i} className="flex items-center gap-2">
                        <span className="h-4 w-4 animate-pulse rounded-full bg-gray-100" />
                        <span className="h-3 w-48 animate-pulse rounded bg-gray-100" />
                    </li>
                ))}
            </ul>
        );
    if (items.length === 0) return <p className={cn("text-xs text-gray-400", className)}>{emptyText}</p>;
    const shown = limit ? items.slice(0, limit) : items;
    return (
        <div className={className}>
            <ul className="space-y-2.5">
                {shown.map((item) => (
                    <li key={item.id} className="flex items-start gap-2 text-xs" data-actor={item.actorType}>
                        <span className="mt-px">
                            <ActorMark item={item} />
                        </span>
                        <span className="min-w-0 flex-1 break-words text-gray-700">
                            {activitySentence(item)}
                            <span className="text-gray-400"> · {relativeTime(item.at, now)}</span>
                            {item.confirmedBy ? (
                                <span className="text-gray-500"> · confirmado por {item.confirmedBy}</span>
                            ) : null}
                            {item.href ? (
                                <>
                                    {" "}
                                    <Link
                                        href={item.href}
                                        className="whitespace-nowrap text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                    >
                                        ver o que fez ▸
                                    </Link>
                                </>
                            ) : item.steps?.length ? (
                                <details className="mt-1 [&_summary::-webkit-details-marker]:hidden">
                                    <summary className="inline cursor-pointer text-gray-500 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40">
                                        ver o que fez ▸
                                    </summary>
                                    <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-gray-500">
                                        {item.steps.map((step, index) => (
                                            <li key={index}>{step}</li>
                                        ))}
                                    </ol>
                                </details>
                            ) : null}
                        </span>
                    </li>
                ))}
            </ul>
            {seeAllHref && limit && items.length > limit ? (
                <Link
                    href={seeAllHref}
                    className="mt-3 inline-block text-xs text-gray-500 hover:text-gray-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                >
                    Ver tudo ({items.length})
                </Link>
            ) : null}
        </div>
    );
}
