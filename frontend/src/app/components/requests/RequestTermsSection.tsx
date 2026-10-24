"use client";

import { useEffect, useState } from "react";
import { Diamond } from "lucide-react";
import {
    getRequestTerms,
    saveRequestTerms,
    MikeApiError,
    type RequestTermKey,
    type RequestTerms,
} from "@/app/lib/mikeApi";
import { brDate, emailError, monthsError, parseMonths } from "@/app/lib/contractTerms";
import { notifyError } from "@/app/lib/userFacingError";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

const FIELD =
    "w-full rounded-lg border border-gray-200 bg-app-surface px-2 py-1.5 text-xs text-gray-900 placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40";

type Editable = RequestTermKey | "counterparty_email";

const LABEL: Record<Editable, string> = {
    counterparty: "Com quem",
    counterparty_email: "E-mail da outra parte",
    term_start: "Início da vigência",
    term_months: "Prazo",
};

/** What a suggestion reads as, in the field's own words ("12 meses", "12/11/2026"). */
function suggestionText(key: RequestTermKey, value: string): string {
    if (key === "term_start") return /^\d{4}-\d{2}-\d{2}$/.test(value) ? brDate(value) : value;
    if (key === "term_months") return `${value} ${Number(value) === 1 ? "mês" : "meses"}`;
    return value;
}

function currentText(terms: RequestTerms, key: Editable): string | null {
    switch (key) {
        case "counterparty":
            return terms.counterparty;
        case "counterparty_email":
            return terms.counterparty_email;
        case "term_start":
            return terms.term_start ? brDate(terms.term_start) : null;
        case "term_months":
            return terms.term_months === null ? null : `${terms.term_months} ${terms.term_months === 1 ? "mês" : "meses"}`;
    }
}

/**
 * The contract's terms on the request, for the team: who is on the other side,
 * the start and the term, and the end worked out from them. What the agent
 * read from the contract shows as a suggestion with the contract's own words
 * as proof, to confirm or correct; nothing the agent read is a fact until a
 * person says so. The other party's e-mail is only kept, and says so.
 */
export function RequestTermsView({
    terms,
    busy,
    onSave,
}: {
    terms: RequestTerms;
    busy: boolean;
    /** Resolves to an error message for a field, or null when saved. */
    onSave: (body: Parameters<typeof saveRequestTerms>[1]) => Promise<{ field: string; message: string } | null>;
}) {
    const [editing, setEditing] = useState<Editable | null>(null);
    const [draft, setDraft] = useState("");
    const [problem, setProblem] = useState<{ field: string; message: string } | null>(null);

    function start(key: Editable) {
        setProblem(null);
        setEditing(key);
        if (key === "term_start") setDraft(terms.term_start ?? "");
        else if (key === "term_months") setDraft(terms.term_months === null ? "" : String(terms.term_months));
        else setDraft((key === "counterparty" ? terms.counterparty : terms.counterparty_email) ?? "");
    }

    async function save(key: Editable) {
        const local = key === "counterparty_email" ? emailError(draft) : key === "term_months" ? monthsError(draft) : null;
        if (local) return setProblem({ field: key, message: local });
        const months = parseMonths(draft);
        const body =
            key === "term_months"
                ? { term_months: months === null ? "" : months }
                : ({ [key]: draft.trim() } as Parameters<typeof saveRequestTerms>[1]);
        const failure = await onSave(body);
        if (failure) return setProblem(failure);
        setEditing(null);
        setProblem(null);
    }

    const rows: Editable[] = ["counterparty", "term_start", "term_months", "counterparty_email"];
    const canAnswer = terms.can_answer;

    return (
        <div className="space-y-2.5">
            {rows.map((key) => {
                const suggestion = key === "counterparty_email" ? undefined : terms.inferred[key];
                const value = currentText(terms, key);
                const isEditing = editing === key;
                return (
                    <div key={key} className="text-xs">
                        <div className="flex items-baseline justify-between gap-3">
                            <span className="text-gray-500">{LABEL[key]}</span>
                            {canAnswer && !isEditing ? (
                                <button
                                    type="button"
                                    onClick={() => start(key)}
                                    aria-label={`Editar: ${LABEL[key]}`}
                                    className="rounded text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                >
                                    {value ? "Editar" : "Informar"}
                                </button>
                            ) : null}
                        </div>
                        {isEditing ? (
                            <div className="mt-1 space-y-1.5">
                                <input
                                    className={FIELD}
                                    aria-label={LABEL[key]}
                                    type={key === "term_start" ? "date" : key === "counterparty_email" ? "email" : "text"}
                                    inputMode={key === "term_months" ? "numeric" : undefined}
                                    value={draft}
                                    onChange={(e) => {
                                        setDraft(e.target.value);
                                        setProblem(null);
                                    }}
                                    autoFocus
                                />
                                {problem?.field === key ? (
                                    <p role="alert" className="text-xs text-red-600">
                                        {problem.message}
                                    </p>
                                ) : null}
                                <div className="flex gap-2">
                                    <PillButtonUI tone="black" size="xs" loading={busy} onClick={() => void save(key)}>
                                        Salvar
                                    </PillButtonUI>
                                    <PillButtonUI tone="white" size="xs" onClick={() => setEditing(null)} disabled={busy}>
                                        Cancelar
                                    </PillButtonUI>
                                </div>
                            </div>
                        ) : (
                            <p className={value ? "mt-0.5 text-gray-900" : "mt-0.5 text-gray-400"}>{value ?? "Não informado"}</p>
                        )}
                        {suggestion && !isEditing ? (
                            <div className="mt-1.5 rounded-lg border border-violet-200 bg-violet-50 px-2.5 py-2">
                                <p className="flex flex-wrap items-center gap-1.5 text-gray-900">
                                    <span className="inline-flex items-center gap-0.5 rounded bg-violet-100 px-1 text-[10px] font-medium text-violet-700">
                                        <Diamond aria-hidden="true" className="h-2.5 w-2.5" />
                                        IA
                                    </span>
                                    Li no contrato: <span className="font-medium">{suggestionText(key as RequestTermKey, suggestion.value)}</span>
                                </p>
                                <blockquote className="mt-1 border-l-2 border-violet-200 pl-2 text-[11px] italic text-gray-600 [overflow-wrap:anywhere]">
                                    {suggestion.quote}
                                </blockquote>
                                {canAnswer ? (
                                    <div className="mt-1.5 flex gap-2">
                                        <PillButtonUI
                                            tone="black"
                                            size="xs"
                                            loading={busy}
                                            onClick={() => void onSave({ confirm: [key as RequestTermKey] })}
                                        >
                                            Confirmar
                                        </PillButtonUI>
                                        <PillButtonUI tone="white" size="xs" onClick={() => start(key)} disabled={busy}>
                                            Corrigir
                                        </PillButtonUI>
                                    </div>
                                ) : null}
                            </div>
                        ) : null}
                        {key === "counterparty_email" && value ? (
                            <p className="mt-0.5 text-[11px] text-gray-500">Só guardamos este e-mail para uso futuro. Não enviamos nada a essa pessoa.</p>
                        ) : null}
                    </div>
                );
            })}
            {terms.term_end ? (
                <p className="border-t border-gray-100 pt-2 text-xs text-gray-700">
                    Termina em <span className="font-medium">{brDate(terms.term_end)}</span>
                    <span className="text-gray-500"> (início + {terms.term_months} {terms.term_months === 1 ? "mês" : "meses"} − 1 dia)</span>
                </p>
            ) : null}
        </div>
    );
}

/** Loads the request's terms and saves a change or a confirmation, with a 422 painted on its own field. */
export function RequestTermsSection({ requestId, reloadKey, onChanged }: { requestId: string; reloadKey?: number; onChanged?: () => void }) {
    const [terms, setTerms] = useState<RequestTerms | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let cancelled = false;
        getRequestTerms(requestId)
            .then((data) => !cancelled && setTerms(data))
            .catch(() => !cancelled && setTerms(null));
        return () => {
            cancelled = true;
        };
    }, [requestId, reloadKey]);

    if (!terms) return null;
    return (
        <RequestTermsView
            terms={terms}
            busy={busy}
            onSave={async (body) => {
                setBusy(true);
                try {
                    setTerms(await saveRequestTerms(requestId, body));
                    onChanged?.();
                    return null;
                } catch (err) {
                    // A 422 that names a field goes under that field, not in a toast.
                    if (err instanceof MikeApiError && err.status === 422 && err.field) {
                        return { field: err.field, message: err.message };
                    }
                    notifyError(err, { lang: "pt", action: "salvar os dados do contrato" });
                    return { field: "", message: "" };
                } finally {
                    setBusy(false);
                }
            }}
        />
    );
}
