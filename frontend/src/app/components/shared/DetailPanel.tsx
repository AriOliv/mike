"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { CloseButton } from "@/shared/ui/CloseButton";
import { LIQUID_GLASS_FLOAT_CLASS } from "@/shared/ui/LiquidGlassUI";
import { cn } from "@/app/lib/utils";

export type DetailField = {
    label: string;
    value: ReactNode;
    /** Draws attention to the row, e.g. a notice deadline about to close. */
    emphasis?: boolean;
};

export type DetailPanelProps = {
    title: ReactNode;
    /** A line under the title, e.g. the counterparty. */
    subtitle?: ReactNode;
    fields: DetailField[];
    /** Buttons at the top, next to the close button. */
    actions?: ReactNode;
    /** Pinned right under the title, above the fields: what needs the reader first. */
    banner?: ReactNode;
    summary?: ReactNode;
    /** Extra content between the summary and the activity, e.g. the traffic light. */
    aside?: ReactNode;
    activity?: ReactNode;
    onClose: () => void;
    className?: string;
};

/**
 * The panel that slides over a list to show one item without leaving it.
 * Escape closes it. Below 900px it covers the screen.
 */
export function DetailPanel({
    title,
    subtitle,
    fields,
    actions,
    banner,
    summary,
    aside,
    activity,
    onClose,
    className,
}: DetailPanelProps) {
    const ref = useRef<HTMLElement>(null);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    useEffect(() => {
        ref.current?.focus();
    }, []);

    return (
        <aside
            ref={ref}
            tabIndex={-1}
            aria-label="Detalhes"
            className={cn(
                "fixed inset-0 z-[120] flex flex-col overflow-y-auto bg-app-floating outline-none",
                "min-[900px]:inset-y-0 min-[900px]:left-auto min-[900px]:right-0 min-[900px]:w-[420px] min-[900px]:border-l min-[900px]:border-gray-200",
                LIQUID_GLASS_FLOAT_CLASS,
                className,
            )}
        >
            <div className="flex items-center justify-end gap-2 px-5 pt-4">
                {actions}
                <CloseButton onClick={onClose} label="Fechar" />
            </div>
            <div className="px-5 pb-6">
                <h2 className="break-words font-serif text-xl text-gray-900">{title}</h2>
                {subtitle ? <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p> : null}
                {banner ? <div className="mt-4">{banner}</div> : null}
                <dl className="mt-4 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-xs">
                    {fields.map((field) => (
                        <div key={field.label} className="contents">
                            <dt className="text-gray-500">{field.label}</dt>
                            <dd
                                className={cn(
                                    "min-w-0 break-words",
                                    field.emphasis ? "font-medium text-gray-900" : "text-gray-700",
                                )}
                            >
                                {field.value}
                            </dd>
                        </div>
                    ))}
                </dl>
                {summary ? (
                    <section className="mt-6">
                        <h3 className="mb-2 text-xs font-medium text-gray-500">Resumo</h3>
                        <div className="text-sm leading-relaxed text-gray-800">{summary}</div>
                    </section>
                ) : null}
                {aside ? <div className="mt-4">{aside}</div> : null}
                {activity ? (
                    <section className="mt-6">
                        <h3 className="mb-2 text-xs font-medium text-gray-500">Atividade</h3>
                        {activity}
                    </section>
                ) : null}
            </div>
        </aside>
    );
}
