"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, BookPlus, CalendarPlus, Diamond, ExternalLink, FilePlus2, Star } from "lucide-react";
import { DetailPanel } from "@/app/components/shared/DetailPanel";
import { AgentSuggestion } from "@/app/components/shared/AgentSuggestion";
import { DeadlineBadge } from "@/app/components/ui/deadline-badge";
import { CitationPillUI } from "@/shared/ui/CitationPillUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { VerdictLabelUI } from "@/shared/ui/VerdictUI";
import type { RegulatoryChange } from "@/app/lib/mikeApi";
import {
    IMPACT_LABEL,
    SOURCE_SHORT,
    TOPIC_LABEL,
    affectedLabel,
    brDate,
    impactVerdict,
} from "@/app/lib/regulatoryRadar";
import { cn } from "@/app/lib/utils";

type Props = {
    change: RegulatoryChange;
    scanName: string | null;
    busy: boolean;
    /** The open playbook-rule suggestion for this change, if one exists. */
    ruleSuggested: boolean;
    onClose: () => void;
    onStar: () => void;
    onArchive: () => void;
    onRestore: () => void;
    onRequest: () => void;
    onObligation: (dueDate?: string) => void;
    onSuggestRule: (guidance?: string) => void;
};

/** The agent's mark: whatever an agent wrote carries it, so authorship is never a guess. */
function AgentMark() {
    return (
        <Diamond
            aria-label="escrito pelo Agente regulatório"
            role="img"
            className="mr-1 inline h-3 w-3 shrink-0 fill-violet-100 align-[-1px] text-violet-700"
        />
    );
}

/** One quote, opened from its numbered pill: the verbatim passage and where it came from. */
function Quote({ n, label, quote, href, open, onToggle }: {
    n: number;
    label: string;
    quote: string;
    href?: string | null;
    open: boolean;
    onToggle: () => void;
}) {
    return (
        <div className="text-xs">
            <div className="flex items-start gap-2">
                <CitationPillUI active={open} onClick={onToggle} aria-label={`Citação ${n}: ${label}`} className="mt-px shrink-0">
                    {n}
                </CitationPillUI>
                {href ? (
                    <a
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        className="min-w-0 break-words text-gray-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                    >
                        {label}
                        <ExternalLink aria-hidden="true" className="ml-1 inline h-3 w-3 align-[-2px]" />
                    </a>
                ) : (
                    <span className="min-w-0 break-words text-gray-700">{label}</span>
                )}
            </div>
            {open ? (
                <blockquote className="mt-1.5 border-l-2 border-gray-200 pl-3 text-[13px] leading-relaxed text-gray-700 [overflow-wrap:anywhere]">
                    “{quote}”
                </blockquote>
            ) : null}
        </div>
    );
}

/** What accepting the agent's suggestion does: the action it names. */
export function suggestedActionKind(change: Pick<RegulatoryChange, "impact" | "request_project_id">): "pedido" | "lida" {
    return change.impact === "alto" && !change.request_project_id ? "pedido" : "lida";
}

export function ChangePanel({
    change,
    scanName,
    busy,
    ruleSuggested,
    onClose,
    onStar,
    onArchive,
    onRestore,
    onRequest,
    onObligation,
    onSuggestRule,
}: Props) {
    const router = useRouter();
    const [openQuote, setOpenQuote] = useState<number | null>(1);
    const [dueDate, setDueDate] = useState("");
    const archived = change.status === "arquivada";
    const verdict = impactVerdict(change.impact);
    const officialQuote = change.summary_quote ?? change.excerpt ?? "";
    const decided = archived || !!change.request_project_id || !!change.obligation_id || ruleSuggested;
    const accepts = suggestedActionKind(change);

    const fields = [
        {
            label: "Impacto",
            value: (
                <span className="flex flex-col items-start gap-1">
                    <VerdictLabelUI verdict={verdict} label={IMPACT_LABEL[change.impact]} />
                    {change.impact_reason ? (
                        <span className="break-words text-gray-600">
                            <AgentMark />
                            {change.impact_reason}
                        </span>
                    ) : null}
                </span>
            ),
            emphasis: change.impact === "alto",
        },
        { label: "Órgão", value: change.issuer ?? SOURCE_SHORT[change.source] },
        { label: "Publicado", value: brDate(change.published_at) ?? "—" },
        {
            label: "Vigência",
            value: change.effective_date ? (
                <span className="flex flex-wrap items-center gap-2">
                    {brDate(change.effective_date)}
                    <DeadlineBadge date={change.effective_date} kind="vigencia" />
                </span>
            ) : (
                "o ato não diz"
            ),
        },
        {
            label: "Temas",
            value: change.topics.length ? change.topics.map((t) => TOPIC_LABEL[t]).join(" · ") : "—",
        },
        { label: "Varredura", value: scanName ?? "—" },
    ];

    const summary = (
        <div className="space-y-3">
            <p className="break-words">
                {change.summary ? <AgentMark /> : null}
                {change.summary ?? change.excerpt ?? "O texto oficial não traz ementa."}
                {officialQuote ? (
                    <CitationPillUI
                        className="ml-1 align-middle"
                        active={openQuote === 1}
                        onClick={() => setOpenQuote(openQuote === 1 ? null : 1)}
                        aria-label="Citação 1: texto oficial"
                    >
                        1
                    </CitationPillUI>
                ) : null}
            </p>
            {!change.summary ? (
                <p className="text-[11px] text-gray-400">Sem resumo da IA: este é o trecho oficial.</p>
            ) : null}
            {officialQuote ? (
                <Quote
                    n={1}
                    label={`${SOURCE_SHORT[change.source]} · ${change.title}`}
                    quote={officialQuote}
                    href={change.url}
                    open={openQuote === 1}
                    onToggle={() => setOpenQuote(openQuote === 1 ? null : 1)}
                />
            ) : null}
        </div>
    );

    const aside = (
        <div className="space-y-5">
            {change.suggested_action && !decided ? (
                <AgentSuggestion
                    agent="Agente regulatório"
                    meta={`${change.affected.length + change.affected_hidden} ${
                        change.affected.length + change.affected_hidden === 1 ? "contrato" : "contratos"
                    } · 1 fonte oficial`}
                    label={<VerdictLabelUI verdict={verdict} label={IMPACT_LABEL[change.impact]} />}
                    title={change.suggested_action}
                    editableText={change.summary ?? change.excerpt ?? change.title}
                    busy={busy}
                    onAccept={accepts === "pedido" ? onRequest : onRestore}
                    onEdit={(text) => onSuggestRule(text)}
                    onReject={() => onArchive()}
                >
                    <p className="text-xs text-gray-600">
                        Aceitar {accepts === "pedido" ? "cria o pedido na Entrada" : "marca como lida"}; Editar transforma o
                        texto numa regra sugerida para o playbook; Rejeitar arquiva.
                    </p>
                </AgentSuggestion>
            ) : null}

            <section aria-label="Contratos afetados">
                <h3 className="mb-2 text-xs font-medium text-gray-500">
                    {affectedLabel(change.affected.length, change.affected_hidden)}
                </h3>
                {change.affected.length === 0 ? (
                    <p className="text-xs text-gray-400">
                        {change.affected_hidden > 0
                            ? "Os contratos afetados não estão compartilhados com você."
                            : "Nenhum contrato da base menciona os termos desta mudança."}
                    </p>
                ) : (
                    <ul className="space-y-2.5">
                        {change.affected.map((a, i) => (
                            <li key={a.project_id} className="space-y-1">
                                <button
                                    type="button"
                                    onClick={() => router.push(`/projects/${a.project_id}`)}
                                    className="block max-w-full break-words text-left text-xs font-medium text-gray-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                >
                                    {a.name}
                                    {a.counterparty ? <span className="font-normal text-gray-500"> · {a.counterparty}</span> : null}
                                </button>
                                <Quote
                                    n={i + 2}
                                    label={`menciona “${a.term}”`}
                                    quote={a.quote}
                                    open={openQuote === i + 2}
                                    onToggle={() => setOpenQuote(openQuote === i + 2 ? null : i + 2)}
                                />
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <section aria-label="O que fazer" className="space-y-2">
                <h3 className="text-xs font-medium text-gray-500">O que fazer</h3>
                <div className="flex flex-wrap gap-2">
                    {change.request_project_id ? (
                        <PillButtonUI tone="white" onClick={() => router.push(`/projects/${change.request_project_id}`)}>
                            <FilePlus2 aria-hidden="true" className="h-3.5 w-3.5" />
                            Abrir pedido criado
                        </PillButtonUI>
                    ) : (
                        <PillButtonUI tone="black" disabled={busy} onClick={onRequest}>
                            <FilePlus2 aria-hidden="true" className="h-3.5 w-3.5" />
                            Criar pedido <kbd className="ml-1 text-[10px] opacity-60">c</kbd>
                        </PillButtonUI>
                    )}
                    {ruleSuggested ? (
                        <span className="inline-flex items-center gap-1 text-xs text-gray-600">
                            <BookPlus aria-hidden="true" className="h-3.5 w-3.5" />
                            Regra sugerida, aguardando a liderança do Legal
                        </span>
                    ) : (
                        <PillButtonUI tone="white" disabled={busy} onClick={() => onSuggestRule()}>
                            <BookPlus aria-hidden="true" className="h-3.5 w-3.5" />
                            Adicionar ao playbook
                        </PillButtonUI>
                    )}
                </div>
                {change.obligation_id ? (
                    <p className="text-xs text-gray-600">A vigência já está nos Prazos.</p>
                ) : change.effective_date ? (
                    <PillButtonUI tone="white" disabled={busy} onClick={() => onObligation()}>
                        <CalendarPlus aria-hidden="true" className="h-3.5 w-3.5" />
                        Criar obrigação nos Prazos
                    </PillButtonUI>
                ) : (
                    <form
                        className="flex flex-wrap items-center gap-2"
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (dueDate) onObligation(dueDate);
                        }}
                    >
                        <label className="text-xs text-gray-600" htmlFor="obligation-date">
                            O ato não diz a vigência. Prazo:
                        </label>
                        <input
                            id="obligation-date"
                            type="date"
                            value={dueDate}
                            onChange={(e) => setDueDate(e.target.value)}
                            className="h-7 rounded-md border border-gray-200 bg-app-surface px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                        />
                        <PillButtonUI tone="white" type="submit" disabled={busy || !dueDate}>
                            <CalendarPlus aria-hidden="true" className="h-3.5 w-3.5" />
                            Criar obrigação
                        </PillButtonUI>
                    </form>
                )}
            </section>
        </div>
    );

    return (
        <DetailPanel
            title={change.title}
            subtitle={[SOURCE_SHORT[change.source], change.act_type].filter(Boolean).join(" · ")}
            fields={fields}
            summary={summary}
            aside={aside}
            onClose={onClose}
            actions={
                <>
                    <button
                        type="button"
                        onClick={onStar}
                        aria-pressed={change.starred}
                        aria-label={change.starred ? "Tirar dos favoritos (s)" : "Favoritar (s)"}
                        title={change.starred ? "Tirar dos favoritos (s)" : "Favoritar (s)"}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-full text-gray-500 hover:bg-app-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                    >
                        <Star aria-hidden="true" className={cn("h-4 w-4", change.starred && "fill-amber-400 text-amber-500")} />
                    </button>
                    <button
                        type="button"
                        onClick={archived ? onRestore : onArchive}
                        disabled={busy}
                        aria-label={archived ? "Restaurar" : "Arquivar (e)"}
                        title={archived ? "Restaurar" : "Arquivar (e)"}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-full text-gray-500 hover:bg-app-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                    >
                        {archived ? (
                            <ArchiveRestore aria-hidden="true" className="h-4 w-4" />
                        ) : (
                            <Archive aria-hidden="true" className="h-4 w-4" />
                        )}
                    </button>
                </>
            }
        />
    );
}
