"use client";

import { Check, Circle, Diamond, Loader2, Pause, Send } from "lucide-react";
import { UserAvatar } from "@/app/components/ui/user-avatar";
import { cn } from "@/app/lib/utils";

export type AgentPlanStep = {
    id: string;
    owner: { kind: "agent" | "person" | "requester"; name: string };
    task: string;
    state: "feito" | "rodando" | "a_fazer" | "aguardando";
    /** The step leaves the Mike (e-mail, chat, counterparty): it asks before acting. */
    asksFirst?: boolean;
};

export type AgentPlanProps = {
    title?: string;
    steps: AgentPlanStep[];
    /** Offers "trocar" on people's steps. Changing one never restarts the others. */
    onChangeOwner?: (stepId: string) => void;
    className?: string;
};

const STATE_LABEL: Record<AgentPlanStep["state"], string> = {
    feito: "feito",
    rodando: "em andamento",
    a_fazer: "a fazer",
    aguardando: "aguardando",
};

function StateMark({ state }: { state: AgentPlanStep["state"] }) {
    const base = "h-3 w-3 shrink-0";
    switch (state) {
        case "feito":
            return <Check aria-hidden="true" className={cn(base, "text-emerald-600")} />;
        case "rodando":
            return (
                <Loader2 aria-hidden="true" className={cn(base, "animate-spin text-blue-600 motion-reduce:animate-none")} />
            );
        case "aguardando":
            return <Pause aria-hidden="true" className={cn(base, "text-amber-600")} />;
        default:
            return <Circle aria-hidden="true" className={cn(base, "text-gray-400")} />;
    }
}

function Owner({ owner }: { owner: AgentPlanStep["owner"] }) {
    if (owner.kind === "agent")
        return (
            <span className="inline-flex min-w-0 items-center gap-1.5">
                <span
                    role="img"
                    aria-label="Agente"
                    className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-violet-50 text-violet-700"
                >
                    <Diamond aria-hidden="true" className="h-2.5 w-2.5 fill-current" />
                </span>
                <span className="break-words text-violet-700">{owner.name}</span>
            </span>
        );
    return (
        <span className="inline-flex min-w-0 items-center gap-1.5">
            <UserAvatar size="sm" name={owner.name} />
            <span className="break-words text-gray-900">
                {owner.name}
                {owner.kind === "requester" ? <span className="text-gray-500"> · solicitante</span> : null}
            </span>
        </span>
    );
}

/**
 * Who does what, in order, people and agents on one list (§4.8b). Each step
 * says its state in words and an icon; a step that leaves the Mike carries
 * "pede ok antes".
 */
export function AgentPlan({ title = "Plano", steps, onChangeOwner, className }: AgentPlanProps) {
    const done = steps.filter((s) => s.state === "feito").length;
    const agents = steps.filter((s) => s.owner.kind === "agent").length;
    return (
        <section aria-label={title} className={cn("text-xs", className)}>
            <header className="mb-2 flex items-baseline justify-between gap-2">
                <h3 className="font-medium text-gray-500">{title}</h3>
                <span className="text-[11px] text-gray-400">
                    {done} de {steps.length} passos feitos · {agents} por agentes
                </span>
            </header>
            <ol className="space-y-2">
                {steps.map((step, index) => (
                    <li key={step.id} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2">
                        <span className="pt-0.5 text-right font-mono text-[11px] text-gray-400">{index + 1}</span>
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <Owner owner={step.owner} />
                                {onChangeOwner && step.owner.kind === "person" && step.state !== "feito" ? (
                                    <button
                                        type="button"
                                        onClick={() => onChangeOwner(step.id)}
                                        className="rounded text-[11px] text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                    >
                                        trocar
                                    </button>
                                ) : null}
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-gray-600">
                                <span className="break-words">{step.task}</span>
                                <span
                                    className={cn(
                                        "inline-flex items-center gap-1 text-[11px]",
                                        step.state === "feito" && "text-emerald-700",
                                        step.state === "rodando" && "text-blue-700",
                                        step.state === "aguardando" && "text-amber-700",
                                        step.state === "a_fazer" && "text-gray-500",
                                    )}
                                >
                                    <StateMark state={step.state} />
                                    {STATE_LABEL[step.state]}
                                </span>
                                {step.asksFirst ? (
                                    <span className="inline-flex items-center gap-1 text-[11px] text-gray-500">
                                        <Send aria-hidden="true" className="h-3 w-3" />
                                        pede ok antes
                                    </span>
                                ) : null}
                            </div>
                        </div>
                    </li>
                ))}
            </ol>
        </section>
    );
}
