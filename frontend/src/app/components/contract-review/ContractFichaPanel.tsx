"use client";

import { useState } from "react";
import { Check, CircleAlert, CircleCheck, CircleDashed, Diamond, Pencil } from "lucide-react";
import { CitationPillUI } from "@/shared/ui/CitationPillUI";
import { clsx } from "clsx";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { EmptyState } from "@/app/components/ui/empty-state";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import type { ContractFicha, FichaField } from "@/app/lib/mikeApi";
import {
    correctedValue,
    correctionDraft,
    correctionForm,
    fichaGroups,
    fieldSummary,
    type CorrectionForm,
} from "@/app/lib/contractFichaView";

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
    confirming,
}: {
    ficha: ContractFicha | null;
    loading: boolean;
    extracting: boolean;
    canEdit: boolean;
    onExtract: () => void;
    onConfirm: (path: string) => void;
    /** Fields whose Verificar is in its undo window or being saved. */
    confirming?: ReadonlySet<string>;
    onCorrect: (path: string, value: unknown) => void;
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
                        {group.fields.map(({ path, label, field }) => {
                            const form = correctionForm(path, ficha.choices?.[path]);
                            return (
                                <FichaRow
                                    key={path}
                                    path={path}
                                    label={label}
                                    field={field}
                                    canEdit={canEdit}
                                    form={form}
                                    editing={editing === path}
                                    draft={draft}
                                    onDraft={setDraft}
                                    onStartEdit={() => {
                                        if (!form) return;
                                        setDraft(correctionDraft(form, field.value));
                                        setEditing(path);
                                    }}
                                    onCancel={() => setEditing(null)}
                                    onSave={() => {
                                        if (!form) return;
                                        setEditing(null);
                                        onCorrect(path, correctedValue(form, field.value, draft));
                                    }}
                                    onConfirm={() => onConfirm(path)}
                                    confirming={confirming?.has(path) ?? false}
                                    onLocate={onLocate}
                                />
                            );
                        })}
                    </ul>
                </section>
            ))}
        </div>
    );
}

const FIELD_CLASS =
    "min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40";

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
    // Violet marks who wrote it (an agent); amber marks the state (to check).
    return (
        <span className="inline-flex items-center gap-1">
            <Diamond aria-hidden="true" className="h-3 w-3 fill-violet-100 text-violet-600" />
            <span className="text-violet-700">IA</span>
            <span className="text-gray-400">·</span>
            <span className="inline-flex items-center gap-1 text-amber-700">
                <CircleDashed aria-hidden="true" className="h-3.5 w-3.5" />
                {field.confidence === "baixa" ? "a conferir, pouca certeza" : "a conferir"}
            </span>
        </span>
    );
}

function FichaRow({
    path,
    label,
    field,
    canEdit,
    form,
    editing,
    draft,
    onDraft,
    onStartEdit,
    onCancel,
    onSave,
    onConfirm,
    confirming,
    onLocate,
}: {
    path: string;
    label: string;
    field: FichaField;
    canEdit: boolean;
    form: CorrectionForm;
    editing: boolean;
    draft: string;
    onDraft: (text: string) => void;
    onStartEdit: () => void;
    onCancel: () => void;
    onSave: () => void;
    onConfirm: () => void;
    confirming: boolean;
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
            {field.review.state !== "pendente" && field.ai_value !== undefined && field.notes && (
                <p className="mt-0.5 text-xs text-amber-700 sm:pl-42">
                    {field.notes} IA leu: {fieldSummary({ value: field.ai_value }) || "o contrato não trata disso"}
                </p>
            )}
            {editing && form ? (
                <div className="mt-1.5 flex items-center gap-2">
                    <label className="sr-only" htmlFor={`ficha-${path}`}>
                        Valor correto de {label}
                    </label>
                    {form.kind === "text" ? (
                        <input
                            id={`ficha-${path}`}
                            autoFocus
                            value={draft}
                            onChange={(event) => onDraft(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") onSave();
                                if (event.key === "Escape") onCancel();
                            }}
                            className={FIELD_CLASS}
                        />
                    ) : (
                        <select
                            id={`ficha-${path}`}
                            autoFocus
                            value={draft}
                            onChange={(event) => onDraft(event.target.value)}
                            onKeyDown={(event) => event.key === "Escape" && onCancel()}
                            className={FIELD_CLASS}
                        >
                            <option value="">O contrato não trata disso</option>
                            {form.kind === "boolean" ? (
                                <>
                                    <option value="true">Sim</option>
                                    <option value="false">Não</option>
                                </>
                            ) : (
                                form.options.map((option) => (
                                    <option key={option.value} value={option.value}>
                                        {option.label}
                                    </option>
                                ))
                            )}
                        </select>
                    )}
                    <PillButtonUI tone="black" size="xs" onClick={onSave}>
                        Salvar
                    </PillButtonUI>
                    <TextButtonUI size="xs" onClick={onCancel}>
                        Cancelar
                    </TextButtonUI>
                </div>
            ) : (
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 pl-0 text-xs sm:pl-42">
                    {citation && (
                        <span className="inline-flex items-center gap-1 text-gray-500">
                            <CitationPillUI
                                aria-label={`Ver no documento: ${citation.clause ?? label}`}
                                title="Ver no documento"
                                onClick={() => onLocate(citation.quote)}
                            >
                                1
                            </CitationPillUI>
                            {citation.clause}
                        </span>
                    )}
                    {canEdit && field.review.state === "pendente" && (
                        <>
                            <TextButtonUI size="xs" onClick={onConfirm} disabled={confirming} aria-label={`Verificar ${label}`}>
                                <Check aria-hidden="true" className="h-3 w-3" />
                                {confirming ? "Verificando…" : "Verificar"}
                            </TextButtonUI>
                            {form && (
                                <TextButtonUI size="xs" onClick={onStartEdit} aria-label={`Corrigir ${label}`}>
                                    Corrigir
                                </TextButtonUI>
                            )}
                        </>
                    )}
                </div>
            )}
        </li>
    );
}
