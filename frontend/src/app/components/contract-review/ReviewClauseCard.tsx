"use client";

import { useMemo } from "react";
import { BookOpen, FileSearch, Scale, TriangleAlert } from "lucide-react";
import { AgentSuggestion } from "@/app/components/shared/AgentSuggestion";
import { VerdictLabelUI } from "@/shared/ui/VerdictUI";
import type { ReviewClause } from "@/app/lib/mikeApi";
import { diffWords } from "@/app/lib/wordDiff";
import {
    fichaStateLabel,
    isDecidable,
    precedentSentence,
    relativeTime,
    sourceCount,
} from "@/app/lib/contractReviewView";

const SEVERITY: Record<string, string> = {
    critica: "crítica",
    alta: "alta",
    media: "média",
    baixa: "baixa",
    info: "informativa",
};

/** The contract language with the suggested wording marked in place. */
export function Redline({ before, after }: { before: string; after: string }) {
    const segments = useMemo(() => diffWords(before, after), [before, after]);
    return (
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            {segments.map((segment, index) =>
                segment.type === "removed" ? (
                    <del key={index} className="rounded-sm bg-red-50 text-red-700 decoration-red-400">
                        <span className="sr-only">Removido: </span>
                        {segment.text}
                    </del>
                ) : segment.type === "added" ? (
                    <ins key={index} className="rounded-sm bg-emerald-50 text-emerald-700 no-underline">
                        <span className="sr-only">Incluído: </span>
                        {segment.text}
                    </ins>
                ) : (
                    <span key={index}>{segment.text}</span>
                ),
            )}
        </p>
    );
}

/**
 * One clause of the first review: the verdict and the rule behind it, the
 * playbook's standard position, the Ficha fields it read, precedent from
 * signed contracts, and the suggested wording to accept, edit or reject.
 */
export function ReviewClauseCard({
    clause,
    reviewedAt,
    canDecide,
    busy,
    focused,
    onFocus,
    onLocate,
    onAccept,
    onEdit,
    onReject,
    onReopen,
}: {
    clause: ReviewClause;
    reviewedAt: string;
    canDecide: boolean;
    busy: boolean;
    focused: boolean;
    onFocus: () => void;
    onLocate: () => void;
    onAccept: () => void;
    onEdit: (text: string) => void;
    onReject: (reason: string) => void;
    onReopen: () => void;
}) {
    const decidable = isDecidable(clause) && clause.verdict !== "nao_aplica";
    const missing = clause.playbook_status === "missing_required";
    const before = missing ? "" : clause.edit?.deleted_text || clause.quote;
    const after = clause.edit?.inserted_text || clause.suggestedText;
    const playbook = clause.sources.find((s) => s.kind === "playbook");
    const rules = clause.sources.filter((s) => s.kind === "regra");
    const fields = clause.sources.filter((s) => s.kind === "ficha");
    const precedent = precedentSentence(clause.precedent);
    const sources = sourceCount(clause);
    const decision = clause.decision
        ? {
              kind: clause.decision.decision,
              by: clause.decision.decided_by,
              at: clause.decision.decided_at,
              reason: clause.decision.reason,
          }
        : null;

    return (
        <AgentSuggestion
            id={`clausula-${clause.id}`}
            agent="Agente de revisão"
            meta={`${relativeTime(reviewedAt)}${sources ? ` · ${sources} ${sources === 1 ? "fonte" : "fontes"}` : ""}`}
            label={<VerdictLabelUI verdict={clause.verdict} />}
            title={
                <button
                    type="button"
                    onClick={onLocate}
                    className="text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                    title="Ver no documento"
                >
                    {clause.location ? `${clause.location} · ` : ""}
                    {clause.ruleName}
                </button>
            }
            decision={decision}
            canDecide={canDecide && decidable}
            busy={busy}
            focused={focused}
            onFocus={onFocus}
            onAccept={decidable ? onAccept : undefined}
            onEdit={decidable && (before || missing) ? onEdit : undefined}
            editableText={decidable ? after : undefined}
            onReject={decidable ? onReject : undefined}
            onReopen={canDecide ? onReopen : undefined}
            preview={decidable && after ? <Redline before={before} after={after} /> : undefined}
            details={
                clause.quote ? (
                    <>
                        <p className="font-medium text-gray-500">Trecho do contrato</p>
                        <blockquote className="border-l-2 border-gray-200 pl-2 font-serif text-sm text-gray-700">
                            {clause.quote}
                        </blockquote>
                    </>
                ) : undefined
            }
        >
            {clause.analysis && <p className="text-sm leading-relaxed text-gray-700">{clause.analysis}</p>}
            {(playbook || rules.length > 0 || fields.length > 0 || precedent) && (
                <ul aria-label="Fontes" className="space-y-1.5 text-xs text-gray-600">
                    {playbook?.kind === "playbook" && (
                        <li className="flex gap-1.5">
                            <BookOpen aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
                            <span className="min-w-0 [overflow-wrap:anywhere]">
                                <span className="font-medium text-gray-700">Posição padrão:</span> {playbook.position}
                            </span>
                        </li>
                    )}
                    {rules.map(
                        (rule) =>
                            rule.kind === "regra" && (
                                <li key={rule.rule_id} className="flex gap-1.5">
                                    <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                                    <span className="min-w-0 [overflow-wrap:anywhere]">
                                        <span className="font-medium text-gray-700">Regra {rule.rule_id}</span> ({SEVERITY[rule.severity] ?? rule.severity}): {rule.label}
                                        {rule.pending_validation && <span className="text-gray-500"> · a confirmar na Ficha</span>}
                                    </span>
                                </li>
                            ),
                    )}
                    {fields.map(
                        (field) =>
                            field.kind === "ficha" && (
                                <li key={field.path} className="flex gap-1.5">
                                    <FileSearch aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
                                    <span className="min-w-0 [overflow-wrap:anywhere]">
                                        <span className="font-medium text-gray-700">Ficha · {field.label}:</span> {fichaStateLabel(field.state)}
                                    </span>
                                </li>
                            ),
                    )}
                    {precedent && clause.precedent && (
                        <li className="flex gap-1.5">
                            <Scale aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
                            <span className="min-w-0 [overflow-wrap:anywhere]">
                                <span className="font-medium text-gray-700">Precedentes:</span> {precedent}
                                {clause.precedent.projects.length > 0 && (
                                    <>
                                        {" "}
                                        (
                                        {clause.precedent.projects.map((project, index) => (
                                            <span key={project.id}>
                                                {index > 0 && ", "}
                                                <a
                                                    href={`/projects/${project.id}/review`}
                                                    className="underline decoration-gray-300 hover:decoration-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                                >
                                                    {project.name}
                                                </a>
                                            </span>
                                        ))}
                                        )
                                    </>
                                )}
                            </span>
                        </li>
                    )}
                </ul>
            )}
            {!clause.covered && (
                <p className="text-xs text-gray-500">Sem regra no playbook para este ponto: revise e, se for recorrente, crie uma regra.</p>
            )}
        </AgentSuggestion>
    );
}
