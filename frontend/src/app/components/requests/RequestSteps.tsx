"use client";

import { Check, X } from "lucide-react";
import type { RequesterStep } from "@/app/lib/mikeApi";
import { STEP_LABELS, stepIndex } from "@/app/lib/requests";
import { cn } from "@/app/lib/utils";

/**
 * The four steps whoever asked sees, instead of the team's six lanes. A
 * cancelled request is not "Concluído": it reads Recebido → Cancelado, so the
 * person never takes it for a delivery.
 */
export function RequestSteps({
    step,
    cancelled,
    className,
}: {
    step: RequesterStep;
    cancelled?: boolean;
    className?: string;
}) {
    if (cancelled) {
        return (
            <ol aria-label="Andamento" className={cn("flex flex-wrap items-center gap-x-1 gap-y-1 text-[11px]", className)}>
                <li className="inline-flex items-center gap-1 text-emerald-700">
                    <Check aria-hidden="true" className="h-3 w-3" />
                    Recebido
                    <span aria-hidden="true" className="ml-1 text-gray-300">—</span>
                </li>
                <li className="inline-flex items-center gap-1 font-medium text-gray-600">
                    <X aria-hidden="true" className="h-3 w-3" />
                    Cancelado
                </li>
            </ol>
        );
    }
    const current = stepIndex(step);
    return (
        <ol aria-label="Andamento" className={cn("flex flex-wrap items-center gap-x-1 gap-y-1 text-[11px]", className)}>
            {STEP_LABELS.map((s, i) => {
                const done = i < current || step === "concluido";
                const here = i === current && step !== "concluido";
                return (
                    <li
                        key={s.step}
                        aria-current={here ? "step" : undefined}
                        className={cn(
                            "inline-flex items-center gap-1",
                            done && "text-emerald-700",
                            here && "font-medium text-gray-900",
                            !done && !here && "text-gray-400",
                        )}
                    >
                        {done ? (
                            <Check aria-hidden="true" className="h-3 w-3" />
                        ) : (
                            <span
                                aria-hidden="true"
                                className={cn("h-1.5 w-1.5 rounded-full", here ? "bg-blue-600" : "bg-gray-300")}
                            />
                        )}
                        {s.label}
                        {i < STEP_LABELS.length - 1 ? <span aria-hidden="true" className="ml-1 text-gray-300">—</span> : null}
                    </li>
                );
            })}
        </ol>
    );
}
