"use client";

import { Check, Circle, Loader2, OctagonX, Square } from "lucide-react";
import { cn } from "@/app/lib/utils";

/**
 * Where a piece of work stands. "rodando" and "pronto" are an agent's states
 * (working, finished and waiting for a person); the other four are the task
 * axis people move a card through. Colour never stands alone: every state
 * carries an icon and a word.
 */
export type ChipStatus =
    | "rodando"
    | "pronto"
    | "em_andamento"
    | "bloqueado"
    | "concluido"
    | "a_fazer"
    | "erro";

export const STATUS_LABEL: Record<ChipStatus, string> = {
    rodando: "Em andamento",
    pronto: "Pronto p/ revisão",
    em_andamento: "Em andamento",
    bloqueado: "Bloqueado",
    concluido: "Concluído",
    a_fazer: "A fazer",
    erro: "Falhou",
};

const TONE: Record<ChipStatus, string> = {
    rodando: "bg-blue-50 text-blue-700",
    pronto: "bg-app-surface-active text-gray-900",
    em_andamento: "bg-blue-50 text-blue-700",
    bloqueado: "bg-red-50 text-red-700",
    concluido: "text-gray-500",
    a_fazer: "bg-gray-100 text-gray-600",
    erro: "bg-red-50 text-red-700",
};

function StatusIcon({ status }: { status: ChipStatus }) {
    const base = "h-3 w-3 shrink-0";
    switch (status) {
        case "rodando":
            return <Loader2 aria-hidden="true" className={cn(base, "animate-spin motion-reduce:animate-none")} />;
        case "pronto":
            return <Circle aria-hidden="true" className={cn(base, "fill-blue-600 text-blue-600")} />;
        case "em_andamento":
            return <Circle aria-hidden="true" className={cn(base, "fill-blue-500 text-blue-500")} />;
        case "bloqueado":
            return <Square aria-hidden="true" className={cn(base, "fill-red-500 text-red-500")} />;
        case "concluido":
            return <Check aria-hidden="true" className={base} />;
        case "erro":
            return <OctagonX aria-hidden="true" className={base} />;
        default:
            return <Circle aria-hidden="true" className={base} />;
    }
}

export type StatusChipProps = {
    status: ChipStatus;
    /** Replaces the standard word, e.g. the agent's current step "Lendo o contrato…". */
    label?: string;
    size?: "sm" | "md";
    className?: string;
};

/** The state of a review, a request or a card, as an icon and a word. */
export function StatusChip({ status, label, size = "sm", className }: StatusChipProps) {
    return (
        <span
            data-status={status}
            className={cn(
                "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full font-medium",
                size === "sm" ? "h-5 px-2 text-[11px]" : "h-6 px-2.5 text-xs",
                TONE[status],
                className,
            )}
        >
            <StatusIcon status={status} />
            {label ?? STATUS_LABEL[status]}
        </span>
    );
}
