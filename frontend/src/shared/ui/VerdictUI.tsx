"use client";

import type { ReactElement } from "react";
import { CircleAlert, CircleCheck, CircleDashed, Minus } from "lucide-react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * The traffic light a contract review speaks in: how a clause, a document or
 * a regulatory change stands against the playbook. Web and Word both render
 * it, so the mapping from a finding's status lives here and nowhere else.
 */
export type Verdict = "alinhado" | "precisa_revisao" | "diverge" | "nao_aplica";

/** A playbook finding's status, as the review API reports it. */
export type VerdictSourceStatus =
    | "acceptable"
    | "needs_review"
    | "unacceptable"
    | "missing_required"
    | "not_applicable"
    | "outside_scope";

export function verdictOf(status: VerdictSourceStatus): Verdict {
    switch (status) {
        case "acceptable":
            return "alinhado";
        case "needs_review":
            return "precisa_revisao";
        case "unacceptable":
        case "missing_required":
            return "diverge";
        default:
            return "nao_aplica";
    }
}

export const VERDICT_LABEL: Record<Verdict, string> = {
    alinhado: "Alinhado",
    precisa_revisao: "Precisa revisão",
    diverge: "Diverge",
    nao_aplica: "Não se aplica",
};

/** Most urgent first: the order a list of findings is read in. */
export const VERDICT_URGENCY: readonly Verdict[] = [
    "diverge",
    "precisa_revisao",
    "alinhado",
    "nao_aplica",
];

const TONE: Record<Verdict, { text: string; fill: string; icon: typeof CircleCheck }> = {
    alinhado: { text: "text-emerald-700", fill: "bg-emerald-50", icon: CircleCheck },
    precisa_revisao: { text: "text-amber-700", fill: "bg-amber-50", icon: CircleDashed },
    diverge: { text: "text-red-700", fill: "bg-red-50", icon: CircleAlert },
    nao_aplica: { text: "text-gray-500", fill: "bg-gray-100", icon: Minus },
};

export type VerdictTally = Record<"alinhado" | "precisa_revisao" | "diverge", number>;

/** Counts statuses into the three lights; what does not apply is left out. */
export function tallyVerdicts(statuses: Iterable<VerdictSourceStatus>): VerdictTally {
    const tally: VerdictTally = { alinhado: 0, precisa_revisao: 0, diverge: 0 };
    for (const status of statuses) {
        const verdict = verdictOf(status);
        if (verdict !== "nao_aplica") tally[verdict] += 1;
    }
    return tally;
}

export type VerdictLabelUIProps = {
    verdict: Verdict;
    /** Replaces the standard wording, e.g. "Exige ação" on a regulatory change. */
    label?: string;
    className?: string;
};

/** The verdict of one finding: icon and word, never colour alone. */
export function VerdictLabelUI({ verdict, label, className }: VerdictLabelUIProps): ReactElement {
    const tone = TONE[verdict];
    const Icon = tone.icon;
    return (
        <span
            data-verdict={verdict}
            className={twMerge(
                clsx(
                    "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium",
                    tone.text,
                    tone.fill,
                    className,
                ),
            )}
        >
            <Icon aria-hidden="true" className="h-3 w-3" />
            {label ?? VERDICT_LABEL[verdict]}
        </span>
    );
}

const ORDER: readonly (keyof VerdictTally)[] = ["alinhado", "precisa_revisao", "diverge"];

const SPOKEN: Record<keyof VerdictTally, [string, string]> = {
    alinhado: ["alinhado", "alinhados"],
    precisa_revisao: ["precisa revisão", "precisam revisão"],
    diverge: ["diverge", "divergem"],
};

function spoken(verdict: keyof VerdictTally, count: number): string {
    return `${count} ${SPOKEN[verdict][count === 1 ? 0 : 1]}`;
}

export type VerdictCountsUIProps = VerdictTally & {
    /** compact: one row of icon + number for a table cell; tiles: three panels. */
    variant?: "compact" | "tiles";
    /** Makes each count a filter; called again with null to clear it. */
    onSelect?: (verdict: keyof VerdictTally | null) => void;
    /** The verdict currently filtered on, shown pressed. */
    selected?: keyof VerdictTally | null;
    className?: string;
};

/**
 * The review at a glance. A zero stays on screen in grey so the layout does
 * not jump as a review fills in. With `onSelect`, each count filters the
 * findings it counts; pressing the selected one again clears the filter.
 */
export function VerdictCountsUI({
    variant = "compact",
    onSelect,
    selected = null,
    className,
    ...tally
}: VerdictCountsUIProps): ReactElement {
    const tiles = variant === "tiles";
    return (
        <div
            role="group"
            aria-label="Resumo da revisão"
            className={twMerge(
                clsx(tiles ? "grid grid-cols-3 gap-2" : "inline-flex items-center gap-2.5", className),
            )}
        >
            {ORDER.map((verdict) => {
                const count = tally[verdict];
                const tone = TONE[verdict];
                const Icon = tone.icon;
                const colour = count > 0 ? tone.text : "text-gray-400";
                const pressed = selected === verdict;
                const content = tiles ? (
                    <>
                        <span className="font-serif text-2xl leading-none text-gray-900">{count}</span>
                        <span className={clsx("flex items-center gap-1 text-xs", colour)}>
                            {VERDICT_LABEL[verdict]}
                            <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                        </span>
                    </>
                ) : (
                    <>
                        <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                        <span aria-hidden="true">{count}</span>
                    </>
                );
                const shape = tiles
                    ? clsx(
                          "flex min-w-0 flex-col items-start gap-1.5 rounded-xl border px-3 py-2.5 text-left",
                          pressed
                              ? "border-gray-300 bg-app-surface-active"
                              : "border-gray-200 bg-app-surface",
                      )
                    : clsx(
                          "inline-flex items-center gap-1 rounded-md text-xs tabular-nums",
                          colour,
                          pressed && "bg-app-surface-active px-1",
                      );
                if (!onSelect)
                    return (
                        <span
                            key={verdict}
                            data-verdict={verdict}
                            aria-label={spoken(verdict, count)}
                            role="img"
                            className={shape}
                        >
                            {content}
                        </span>
                    );
                return (
                    <button
                        key={verdict}
                        type="button"
                        data-verdict={verdict}
                        aria-pressed={pressed}
                        aria-label={`${spoken(verdict, count)}: filtrar`}
                        onClick={() => onSelect(pressed ? null : verdict)}
                        className={clsx(
                            shape,
                            "transition-colors hover:bg-app-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40",
                        )}
                    >
                        {content}
                    </button>
                );
            })}
        </div>
    );
}
