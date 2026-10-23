"use client";

import { Check, Diamond } from "lucide-react";
import type { RequestStageRow, RequestStageStrip, StageStripEntry } from "@/app/lib/mikeApi";
import { positionText, sinceText, stageHolderText } from "@/app/lib/requests";
import { cn } from "@/app/lib/utils";

/** The holder sentence is amber when the ball is with whoever asked, and only then. */
function holderTone(owner: { kind: string }, hasOwner: boolean): string {
    if (owner.kind === "requester") return "text-amber-700";
    if (owner.kind === "none" && hasOwner) return "text-amber-700";
    return "text-gray-500";
}

function Marker({ state }: { state: StageStripEntry["state"] }) {
    if (state === "concluida") return <Check aria-hidden="true" className="h-3 w-3 shrink-0 text-emerald-600" />;
    return (
        <span
            aria-hidden="true"
            className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                state === "atual" ? "bg-blue-600 ring-2 ring-blue-200" : "border border-gray-400 bg-white",
            )}
        />
    );
}

/**
 * Where the request is, who has it and since when, at the top of the panel.
 * Wide: every stage with its mark, the current one named. Narrow: only the
 * current stage and a row of dots (a seven-item strip scrolling sideways
 * loses where you are). Below it, the timeline with the current stage first.
 * Only counts and labels: never contract text.
 */
export function StageStrip({
    stage,
    stages = [],
    now,
    className,
}: {
    stage: RequestStageStrip;
    stages?: RequestStageRow[];
    /** For tests; by default the time is read when the helper runs. */
    now?: number;
    className?: string;
}) {
    const position = positionText(stage.position);
    // The clock is read where the event happens, not while rendering; the page re-renders on every change anyway.
    const holder = stageHolderText(stage.owner, stage.since, now);
    const tone = holderTone(stage.owner, stage.owner.kind !== "none");
    const noOwner = stage.owner.kind === "none" && stage.stage !== "concluido";
    const timeline = [...stages].reverse();

    return (
        <section aria-label="Etapa do pedido" className={cn("rounded-xl border border-gray-200 bg-white px-3 py-3", className)}>
            <ol aria-label="Etapas" className="hidden flex-wrap items-center gap-x-1 gap-y-1 text-[11px] min-[420px]:flex">
                {stage.strip.map((entry, i) => (
                    <li
                        key={entry.stage}
                        aria-current={entry.state === "atual" ? "step" : undefined}
                        className={cn(
                            "inline-flex items-center gap-1",
                            entry.state === "concluida" && "text-emerald-700",
                            entry.state === "atual" && "font-medium text-gray-900",
                            entry.state === "pendente" && "max-w-[5.5rem] truncate text-gray-400",
                        )}
                    >
                        <Marker state={entry.state} />
                        {entry.label}
                        {i < stage.strip.length - 1 ? <span aria-hidden="true" className="ml-1 text-gray-300">—</span> : null}
                    </li>
                ))}
            </ol>

            <div className="min-[420px]:hidden">
                <ol aria-label="Etapas" className="mb-1.5 flex items-center gap-1.5">
                    {stage.strip.map((entry) => (
                        <li key={entry.stage} aria-current={entry.state === "atual" ? "step" : undefined} aria-label={`${entry.label}: ${entry.state}`}>
                            <Marker state={entry.state} />
                        </li>
                    ))}
                </ol>
            </div>

            <p className="mt-2 text-sm font-medium text-gray-900">
                {stage.label}
                {position ? <span className="ml-2 text-xs font-normal text-gray-500">{position}</span> : null}
            </p>
            {stage.stage !== "concluido" && (
                <p className={cn("mt-0.5 flex flex-wrap items-center gap-1.5 text-xs", noOwner ? "text-amber-700" : tone)}>
                    {stage.owner.kind === "agent" && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-violet-50 px-1 text-[10px] font-medium text-violet-700">
                            <Diamond aria-hidden="true" className="h-2.5 w-2.5" />
                            IA
                        </span>
                    )}
                    {holder}
                </p>
            )}

            {timeline.length > 0 && (
                <ul aria-label="Linha do tempo" className="mt-3 space-y-1.5 border-t border-gray-100 pt-2.5">
                    {timeline.map((row, i) => (
                        <li key={`${row.stage}-${row.entered_at}`} className="flex items-baseline gap-2 text-xs">
                            <span className={cn("w-16 shrink-0 text-gray-400", i === 0 && "text-gray-600")}>
                                {sinceText(row.entered_at, now)}
                            </span>
                            <span className={cn("min-w-0", i === 0 ? "font-medium text-gray-900" : "text-gray-700")}>
                                {stage.strip.find((s) => s.stage === row.stage)?.label ?? row.stage}
                                {row.owner_kind === "agent" ? <span className="ml-1 text-[10px] text-violet-700">IA</span> : null}
                                {row.owner_name ? <span className="text-gray-500"> · {row.owner_name}</span> : null}
                                {row.note ? <span className="block text-gray-500">{row.note}</span> : null}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
