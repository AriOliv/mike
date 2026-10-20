"use client";

import {
    useEffect,
    useId,
    useRef,
    useState,
    type KeyboardEvent,
    type ReactNode,
} from "react";
import { Check, ChevronRight, Diamond, Loader2, Pencil, X } from "lucide-react";
import { clsx } from "clsx";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { TextSlabUI } from "@/shared/ui/TextSlabUI";
import { LIQUID_GLASS_FLAT_CLASS } from "@/app/components/ui/liquid-surface";

export type AgentSuggestionDecision = {
    kind: "aceito" | "editado" | "rejeitado";
    by: string;
    at: string;
    reason?: string | null;
};

export type AgentSuggestionProps = {
    /** "Agente de revisão" — the agents' fixed PT names. */
    agent: string;
    /** "há 2 min · 3 fontes". */
    meta?: ReactNode;
    /** The verdict label, e.g. a `VerdictLabelUI`. */
    label?: ReactNode;
    title: ReactNode;
    /** Assessment, sources, precedent: whatever the suggestion stands on. */
    children?: ReactNode;
    /** The proposed wording, shown as a redline by the caller. */
    preview?: ReactNode;
    /** The text "Editar" starts from. Without it, Editar is not offered. */
    editableText?: string;
    decision?: AgentSuggestionDecision | null;
    /** What a person can do here; false shows the suggestion read-only. */
    canDecide?: boolean;
    busy?: boolean;
    onAccept?: () => void;
    onEdit?: (text: string) => void;
    onReject?: (reason: string) => void;
    /** Reopens a decided suggestion. */
    onReopen?: () => void;
    /** "ver raciocínio": the details behind the suggestion, collapsed. */
    details?: ReactNode;
    /** Focus target for j/k navigation and a/e/r shortcuts. */
    focused?: boolean;
    onFocus?: () => void;
    id?: string;
    className?: string;
};

const DECIDED_LABEL: Record<AgentSuggestionDecision["kind"], string> = {
    aceito: "Aceito",
    editado: "Editado",
    rejeitado: "Rejeitado",
};

function formatTime(iso: string) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
        ? ""
        : date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/**
 * One agent suggestion a person decides in one click: Aceitar, Editar (the
 * wording opens in place) or Rejeitar (with an optional one-line reason).
 * With the card focused, `a`, `e` and `r` do the same. A decided suggestion
 * folds to one line naming who decided and when; clicking it reopens it.
 * Undo is the caller's toast, so the card never asks for confirmation.
 */
export function AgentSuggestion({
    agent,
    meta,
    label,
    title,
    children,
    preview,
    editableText,
    decision = null,
    canDecide = true,
    busy = false,
    onAccept,
    onEdit,
    onReject,
    onReopen,
    details,
    focused = false,
    onFocus,
    id,
    className,
}: AgentSuggestionProps) {
    const headingId = useId();
    const [mode, setMode] = useState<"idle" | "editing" | "rejecting">("idle");
    const [draft, setDraft] = useState(editableText ?? "");
    const [reason, setReason] = useState("");
    const [showDetails, setShowDetails] = useState(false);
    const card = useRef<HTMLElement>(null);
    const field = useRef<HTMLTextAreaElement & HTMLInputElement>(null);

    useEffect(() => {
        if (focused) card.current?.focus({ preventScroll: false });
    }, [focused]);
    useEffect(() => {
        if (mode !== "idle") field.current?.focus();
    }, [mode]);

    const canEdit = canDecide && !!onEdit && editableText !== undefined;
    const startEdit = () => {
        setDraft(editableText ?? "");
        setMode("editing");
    };
    const submitEdit = () => {
        const text = draft.trim();
        if (!text) return;
        setMode("idle");
        onEdit?.(text);
    };
    const submitReject = () => {
        setMode("idle");
        onReject?.(reason.trim());
        setReason("");
    };

    function onKeyDown(event: KeyboardEvent<HTMLElement>) {
        // Shortcuts only on the card itself, never while typing in it.
        if (event.target !== event.currentTarget || !canDecide || busy || decision) return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key === "a" && onAccept) {
            event.preventDefault();
            onAccept();
        } else if (event.key === "e" && canEdit) {
            event.preventDefault();
            startEdit();
        } else if (event.key === "r" && onReject) {
            event.preventDefault();
            setMode("rejecting");
        }
    }

    if (decision)
        return (
            <article
                ref={card}
                id={id}
                tabIndex={-1}
                aria-labelledby={headingId}
                onFocus={onFocus}
                className={clsx(
                    "min-w-0 rounded-xl px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40",
                    LIQUID_GLASS_FLAT_CLASS,
                    className,
                )}
            >
                <button
                    type="button"
                    onClick={onReopen}
                    disabled={!onReopen}
                    aria-label={`Reabrir: ${DECIDED_LABEL[decision.kind]}`}
                    className="flex w-full min-w-0 items-center gap-2 text-left text-xs text-gray-500 focus-visible:outline-none enabled:hover:text-gray-900"
                >
                    {decision.kind === "rejeitado" ? (
                        <X aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                        <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span id={headingId} className="min-w-0 flex-1 truncate text-gray-700">
                        {title}
                    </span>
                    <span className="shrink-0">
                        {DECIDED_LABEL[decision.kind]} por {decision.by}
                        {formatTime(decision.at) && ` · ${formatTime(decision.at)}`}
                    </span>
                </button>
                {decision.reason && (
                    <p className="mt-1 pl-5 text-xs text-gray-500 [overflow-wrap:anywhere]">“{decision.reason}”</p>
                )}
            </article>
        );

    return (
        <article
            ref={card}
            id={id}
            tabIndex={0}
            aria-labelledby={headingId}
            aria-keyshortcuts={canDecide ? "a e r" : undefined}
            onKeyDown={onKeyDown}
            onFocus={onFocus}
            data-focused={focused || undefined}
            className={clsx(
                "min-w-0 space-y-3 rounded-xl p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 md:p-4",
                LIQUID_GLASS_FLAT_CLASS,
                focused && "ring-2 ring-blue-500/30",
                className,
            )}
        >
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-violet-700">
                <Diamond aria-hidden="true" className="h-3 w-3 fill-violet-100" />
                <span className="font-medium">{agent}</span>
                {meta && <span className="text-gray-500">· {meta}</span>}
            </p>
            <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
                {label}
                <h4 id={headingId} className="min-w-0 flex-1 text-sm font-medium text-gray-900 [overflow-wrap:anywhere]">
                    {title}
                </h4>
            </div>
            {children}
            {mode === "editing" ? (
                <div className="space-y-2">
                    <label className="block text-xs font-medium text-gray-500" htmlFor={`${headingId}-edit`}>
                        Sua redação
                    </label>
                    <textarea
                        id={`${headingId}-edit`}
                        ref={field}
                        value={draft}
                        rows={4}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") setMode("idle");
                            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submitEdit();
                        }}
                        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs leading-relaxed text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                    />
                    <div className="flex gap-2">
                        <PillButtonUI tone="black" size="sm" disabled={!draft.trim()} onClick={submitEdit}>
                            Salvar edição
                        </PillButtonUI>
                        <TextButtonUI size="sm" onClick={() => setMode("idle")}>
                            Cancelar
                        </TextButtonUI>
                    </div>
                </div>
            ) : (
                preview && <TextSlabUI className="text-xs leading-relaxed text-gray-800">{preview}</TextSlabUI>
            )}
            {mode === "rejecting" && (
                <div className="flex items-center gap-2">
                    <label className="sr-only" htmlFor={`${headingId}-reason`}>
                        Por quê? (opcional)
                    </label>
                    <input
                        id={`${headingId}-reason`}
                        ref={field}
                        value={reason}
                        placeholder="Por quê? (opcional, Enter confirma)"
                        maxLength={300}
                        onChange={(event) => setReason(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") submitReject();
                            if (event.key === "Escape") setMode("idle");
                        }}
                        className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                    />
                    <PillButtonUI tone="black" size="sm" onClick={submitReject}>
                        Rejeitar
                    </PillButtonUI>
                </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
                {canDecide && mode === "idle" && (
                    <>
                        {onAccept && (
                            <PillButtonUI tone="black" size="sm" disabled={busy} onClick={onAccept} aria-keyshortcuts="a">
                                {busy ? (
                                    <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                                ) : (
                                    <Check aria-hidden="true" className="h-3.5 w-3.5" />
                                )}
                                Aceitar <kbd className="ml-1 text-[10px] opacity-60">a</kbd>
                            </PillButtonUI>
                        )}
                        {canEdit && (
                            <PillButtonUI tone="white" size="sm" disabled={busy} onClick={startEdit} aria-keyshortcuts="e">
                                <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
                                Editar <kbd className="ml-1 text-[10px] opacity-60">e</kbd>
                            </PillButtonUI>
                        )}
                        {onReject && (
                            <PillButtonUI tone="white" size="sm" disabled={busy} onClick={() => setMode("rejecting")} aria-keyshortcuts="r">
                                <X aria-hidden="true" className="h-3.5 w-3.5" />
                                Rejeitar <kbd className="ml-1 text-[10px] opacity-60">r</kbd>
                            </PillButtonUI>
                        )}
                    </>
                )}
                {details && (
                    <TextButtonUI
                        size="xs"
                        className="ml-auto"
                        aria-expanded={showDetails}
                        onClick={() => setShowDetails((open) => !open)}
                    >
                        ver raciocínio
                        <ChevronRight
                            aria-hidden="true"
                            className={clsx("h-3.5 w-3.5 transition-transform", showDetails && "rotate-90")}
                        />
                    </TextButtonUI>
                )}
            </div>
            {details && showDetails && <div className="space-y-2 text-xs text-gray-700">{details}</div>}
        </article>
    );
}
