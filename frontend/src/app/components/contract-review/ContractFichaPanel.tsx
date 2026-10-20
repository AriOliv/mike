"use client";

import { useState } from "react";
import { Check, CircleAlert, CircleCheck, CircleDashed, Pencil } from "lucide-react";
import { clsx } from "clsx";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { EmptyState } from "@/app/components/ui/empty-state";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import type { ContractFicha, FichaField } from "@/app/lib/mikeApi";
import { fichaGroups, fieldSummary } from "@/app/lib/contractFichaView";

/**
 * The Ficha beside the review: each field with its state (a conferir /
 * verificado / corrigido), its clause, and Verificar in one click. A field
 * the contract does not treat says so instead of staying blank. Clicking a
 * citation shows the clause in the document.
 */
export function ContractFichaPanel({
    ficha,
    loading,
    extracting,
    canEdit,
    onExtract,
    onConfirm,
    onCorrect,
    onLocate,
}: {
    ficha: ContractFicha | null;
    loading: boolean;
    extracting: boolean;
    canEdit: boolean;
    onExtract: () => void;
    onConfirm: (path: string) => void;
    onCorrect: (path: string, text: string) => void;
    onLocate: (quote: string) => void;
}) {
    const [editing, setEditing] = useState<string | null>(null);
    const [draft, setDraft] = useState("");

    if (loading)
        return (
            <div aria-hidden="true" className="space-y-3 p-1">
                {["w-1/2", "w-3/4", "w-2/3", "w-1/2"].map((width) => (
                    <SkeletonLine key={width} className={width} />
                ))}
            </div>
        );
    if (!ficha?.ficha)
        return (
            <EmptyState
                title="A Ficha ainda não foi extraída"
                description="Eu leio o contrato e preencho os campos da planilha do Legal (vigência, aviso prévio, cessão, mudança de controle, LGPD, multas), cada um com a cláusula de origem. Você confere e verifica em 1 clique. Os campos verificados alimentam o semáforo da revisão."
                action={
                    canEdit && (
                        <PillButtonUI tone="black" loading={extracting} onClick={onExtract}>
                            {extracting ? "Lendo o contrato…" : "Extrair a Ficha"}
                        </PillButtonUI>
                    )
                }
                className="py-6"
            />
        );

    const { verified, total } = ficha.progress;
    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm text-gray-900">
                    <span className="font-medium">
                        {verified}/{total}
                    </span>{" "}
                    verificados
                </p>
                <div
                    role="progressbar"
                    aria-label="Campos verificados"
                    aria-valuemin={0}
                    aria-valuemax={total}
                    aria-valuenow={verified}
                    className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-gray-100"
                >
                    <div className="h-full bg-emerald-500" style={{ width: `${total ? (verified / total) * 100 : 0}%` }} />
                </div>
                {canEdit && (
                    <TextButtonUI size="xs" disabled={extracting} onClick={onExtract}>
                        {extracting ? "Lendo o contrato…" : "Reextrair"}
                    </TextButtonUI>
                )}
            </div>
            {fichaGroups(ficha.ficha).map((group) => (
                <section key={group.title} aria-label={group.title} className="space-y-1.5">
                    <h4 className="text-xs font-medium uppercase tracking-wide text-gray-500">{group.title}</h4>
                    <ul className="space-y-1">
                        {group.fields.map(({ path, label, field }) => (
                            <FichaRow
                                key={path}
                                path={path}
                                label={label}
                                field={field}
                                canEdit={canEdit}
                                editing={editing === path}
                                draft={draft}
                                onDraft={setDraft}
                                onStartEdit={() => {
                                    setDraft(fieldSummary(field));
                                    setEditing(path);
                                }}
                                onCancel={() => setEditing(null)}
                                onSave={() => {
                                    setEditing(null);
                                    onCorrect(path, draft);
                                }}
                                onConfirm={() => onConfirm(path)}
                                onLocate={onLocate}
                            />
                        ))}
                    </ul>
                </section>
            ))}
        </div>
    );
}

function StateMark({ field }: { field: FichaField }) {
    if (field.review.state === "confirmado")
        return (
            <span className="inline-flex items-center gap-1 text-emerald-700">
                <CircleCheck aria-hidden="true" className="h-3.5 w-3.5" />
                verificado
            </span>
        );
    if (field.review.state === "corrigido")
        return (
            <span className="inline-flex items-center gap-1 text-emerald-700">
                <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
                corrigido
            </span>
        );
    const unverified = field.citations.some((citation) => !citation.verified);
    if (unverified)
        return (
            <span className="inline-flex items-center gap-1 text-red-700">
                <CircleAlert aria-hidden="true" className="h-3.5 w-3.5" />
                citação não localizada
            </span>
        );
    return (
        <span className={clsx("inline-flex items-center gap-1", field.confidence === "baixa" ? "text-amber-700" : "text-violet-700")}>
            <CircleDashed aria-hidden="true" className="h-3.5 w-3.5" />
            IA · a conferir
        </span>
    );
}

function FichaRow({
    path,
    label,
    field,
    canEdit,
    editing,
    draft,
    onDraft,
    onStartEdit,
    onCancel,
    onSave,
    onConfirm,
    onLocate,
}: {
    path: string;
    label: string;
    field: FichaField;
    canEdit: boolean;
    editing: boolean;
    draft: string;
    onDraft: (text: string) => void;
    onStartEdit: () => void;
    onCancel: () => void;
    onSave: () => void;
    onConfirm: () => void;
    onLocate: (quote: string) => void;
}) {
    const citation = field.citations[0];
    const missing = field.status === "nao_encontrado";
    return (
        <li className="rounded-lg px-2 py-1.5 hover:bg-app-surface-hover">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="w-40 shrink-0 text-xs text-gray-500">{label}</span>
                <span className={clsx("min-w-0 flex-1 text-sm [overflow-wrap:anywhere]", missing ? "text-gray-500" : "text-gray-900")}>
                    {missing ? "O contrato não trata disso." : fieldSummary(field)}
                </span>
                <span className="shrink-0 text-[11px]">
                    <StateMark field={field} />
                </span>
            </div>
            {editing ? (
                <div className="mt-1.5 flex items-center gap-2">
                    <label className="sr-only" htmlFor={`ficha-${path}`}>
                        Valor correto de {label}
                    </label>
                    <input
                        id={`ficha-${path}`}
                        autoFocus
                        value={draft}
                        onChange={(event) => onDraft(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") onSave();
                            if (event.key === "Escape") onCancel();
                        }}
                        className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                    />
                    <PillButtonUI tone="black" size="xs" onClick={onSave}>
                        Salvar
                    </PillButtonUI>
                </div>
            ) : (
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 pl-0 text-xs sm:pl-42">
                    {citation && (
                        <button
                            type="button"
                            onClick={() => onLocate(citation.quote)}
                            className="text-gray-500 underline decoration-gray-300 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                        >
                            {citation.clause ?? "ver no documento"}
                        </button>
                    )}
                    {canEdit && field.review.state === "pendente" && (
                        <>
                            <TextButtonUI size="xs" onClick={onConfirm} aria-label={`Verificar ${label}`}>
                                <Check aria-hidden="true" className="h-3 w-3" />
                                Verificar
                            </TextButtonUI>
                            <TextButtonUI size="xs" onClick={onStartEdit} aria-label={`Corrigir ${label}`}>
                                Corrigir
                            </TextButtonUI>
                        </>
                    )}
                </div>
            )}
        </li>
    );
}
