"use client";

import { useEffect, useState } from "react";
import { Check, CircleDashed, Sparkles } from "lucide-react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import {
    answerRequestIntake,
    getRequestIntake,
    searchRequestContracts,
    type ContractChoice,
    type IntakeAnswerInput,
    type RequestIntake,
} from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import { showToast } from "@/app/components/ui/toast";
import { cn } from "@/app/lib/utils";
import { KIND_OPTIONS } from "@/app/lib/requests";

const FIELD =
    "w-full rounded-lg border border-gray-200 bg-app-surface px-2 py-1.5 text-xs text-gray-900 placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40";

type Item = RequestIntake["items"][number];

/** How often the checklist looks again while the agent is reading the contract. */
export const PREFILL_POLL_MS = 5000;
type Draft = { value: string; detail: string; selected: string[]; unknown: boolean; contract: ContractChoice | null };
const EMPTY: Draft = { value: "", detail: "", selected: [], unknown: false, contract: null };

/** How long a search waits for the person to stop typing, and how many letters it takes. */
export const CONTRACT_SEARCH_MS = 250;
const CONTRACT_MIN_LETTERS = 2;
const NOT_IN_MIKE = "Não está no Mike, vou anexar";

const isChoice = (item: Item) => item.kind === "choice" || item.kind === "multi_choice";

/** What the person gave for a question, in the shape the server takes; null while it is blank. */
function answerOf(item: Item, d: Draft): IntakeAnswerInput | null {
    if (d.unknown) return { unknown: true };
    if (item.kind === "contract" && d.contract) return { project_id: d.contract.id };
    if (isChoice(item)) return d.selected.length ? (item.kind === "multi_choice" ? d.selected : d.selected[0]) : null;
    if (!d.value.trim()) return null;
    return d.detail.trim() ? { value: d.value, detail: d.detail } : d.value;
}

/** The draft that stands for an answer already given, to correct it in place. */
function draftFrom(item: Item): Draft {
    const a = item.answer;
    if (!a) return EMPTY;
    if (a.unknown) return { ...EMPTY, unknown: true };
    // A contract answer is picked again, never re-sent from its label: that would untie the link.
    return { ...EMPTY, value: a.choice ?? (isChoice(item) || item.kind === "contract" ? "" : a.value), detail: a.detail ?? "", selected: a.selected ?? [] };
}

const kindLabel = (kind: string) => KIND_OPTIONS.find((k) => k.value === kind)?.label ?? kind;

/**
 * The request's intake checklist: what is confirmed, what the agent read in
 * the contract ("inferido, confirme", with the contract's own words), and
 * what is still open. Only the open items are asked; an inferred answer is
 * confirmed in one click or corrected in place.
 */
export function IntakeChecklist({
    intake,
    busy,
    onAnswer,
    audience = "requester",
}: {
    intake: RequestIntake;
    busy?: boolean;
    onAnswer: (body: { answers?: Record<string, IntakeAnswerInput>; confirm?: string[] }) => void;
    /** "team" answers on the requester's behalf; the words change, not the rules. */
    audience?: "requester" | "team";
}) {
    const [drafts, setDrafts] = useState<Record<string, Draft>>({});
    const [editing, setEditing] = useState<string | null>(null);
    const open = intake.items.filter((i) => i.state === "pendente");
    const toConfirm = intake.items.filter((i) => i.state === "inferido");
    const draftOf = (key: string): Draft => drafts[key] ?? EMPTY;
    const setDraft = (key: string, patch: Partial<Draft>) =>
        setDrafts((d) => ({ ...d, [key]: { ...draftOf(key), ...patch } }));

    const filled = open.filter((i) => answerOf(i, draftOf(i.key)) !== null);
    const send = () => {
        const answers: Record<string, IntakeAnswerInput> = {};
        for (const i of filled) answers[i.key] = answerOf(i, draftOf(i.key))!;
        onAnswer({ answers });
        setDrafts({});
    };

    return (
        <div>
            <p className="flex items-center gap-2 text-xs text-gray-600">
                <span
                    className={cn(
                        "font-medium",
                        intake.complete ? "text-emerald-700" : "text-gray-900",
                    )}
                >
                    {intake.nothing_to_fill
                        ? "Nada a preencher neste tipo de pedido"
                        : intake.complete
                          ? "Checklist completo"
                          : `${intake.answered} de ${intake.total} respondidas`}
                </span>
                {toConfirm.length ? (
                    <span className="text-violet-700">· {toConfirm.length} lida{toConfirm.length === 1 ? "" : "s"} no contrato para confirmar</span>
                ) : null}
            </p>
            {intake.kind_changed ? (
                <p className="mt-1 text-[11px] text-gray-600" role="status">
                    O tipo mudou de {kindLabel(intake.kind_changed.from)} para {kindLabel(intake.kind_changed.to)}: agora são {intake.total} pergunta{intake.total === 1 ? "" : "s"}. As respostas que você já deu ficam guardadas.
                </p>
            ) : null}
            {intake.prefill === "lendo" && !intake.complete ? (
                <p className="mt-1 flex items-center gap-1.5 text-[11px] text-violet-700" role="status">
                    <Sparkles className="h-3 w-3" aria-hidden />
                    O agente está lendo o contrato para preencher o que ele responde.
                </p>
            ) : intake.prefill === "falhou" && !intake.complete ? (
                <p className="mt-1 text-[11px] text-gray-500" role="status">
                    O agente não conseguiu ler o contrato agora. Responda as perguntas abaixo.
                </p>
            ) : null}

            <ul className="mt-2 space-y-2">
                {intake.items.map((item) =>
                    item.state === "pendente" ? null : (
                        <AnsweredRow
                            key={item.key}
                            item={item}
                            canAnswer={intake.can_answer}
                            busy={busy}
                            editing={editing === item.key}
                            draft={draftOf(item.key)}
                            onDraft={(patch) => setDraft(item.key, patch)}
                            onEdit={() => {
                                setEditing(item.key);
                                setDraft(item.key, draftFrom(item));
                            }}
                            onConfirm={() => onAnswer({ confirm: [item.key] })}
                            onSave={() => {
                                const answer = answerOf(item, draftOf(item.key));
                                if (answer === null) return;
                                onAnswer({ answers: { [item.key]: answer } });
                                setEditing(null);
                            }}
                        />
                    ),
                )}
            </ul>

            {open.length && intake.can_answer ? (
                <form
                    className="mt-3 space-y-3 rounded-xl border border-gray-200 p-3"
                    aria-label="Perguntas pendentes"
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (filled.length) send();
                    }}
                >
                    <p className="text-xs font-medium text-gray-900">
                        {audience === "team" ? "Falta saber de quem pediu" : "Falta pouco para o Legal começar"}
                    </p>
                    {open.map((item) => (
                        <Question key={item.key} item={item} draft={draftOf(item.key)} onDraft={(patch) => setDraft(item.key, patch)} />
                    ))}
                    <PillButtonUI tone="black" size="sm" type="submit" loading={busy} disabled={!filled.length}>
                        Salvar respostas
                    </PillButtonUI>
                </form>
            ) : open.length ? (
                <ul className="mt-2 space-y-1 text-xs text-gray-500">
                    {open.map((i) => (
                        <li key={i.key} className="flex items-center gap-1.5">
                            <CircleDashed aria-hidden="true" className="h-3 w-3" />
                            {i.label}
                        </li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}

function Question({ item, draft, onDraft }: { item: Item; draft: Draft; onDraft: (patch: Partial<Draft>) => void }) {
    const id = `intake-${item.key}`;
    return (
        <div className="text-xs">
            <label htmlFor={id} className="mb-0.5 block text-gray-700">
                {item.label}
                {item.required ? null : <span className="text-gray-400"> (opcional)</span>}
            </label>
            {item.hint ? <p className="mb-1 text-[11px] text-gray-500">{item.hint}</p> : null}
            <AnswerField id={id} item={item} draft={draft} onDraft={onDraft} />
        </div>
    );
}

/** The input for the question, and the "Não sei" button where the question allows it. */
function AnswerField({ id, item, draft, onDraft }: { id: string; item: Item; draft: Draft; onDraft: (patch: Partial<Draft>) => void }) {
    return (
        <div>
            {draft.unknown ? (
                <p className="rounded-lg bg-gray-50 px-2 py-1.5 text-gray-600 dark:bg-white/5">Você marcou que não sabe. O Legal vai confirmar com você.</p>
            ) : (
                <AnswerInput id={id} item={item} draft={draft} onDraft={onDraft} />
            )}
            {item.no_unknown ? null : (
                <button
                    type="button"
                    aria-pressed={draft.unknown}
                    className="mt-1 text-[11px] text-gray-500 underline underline-offset-2 hover:text-gray-800"
                    onClick={() => onDraft({ unknown: !draft.unknown })}
                >
                    {draft.unknown ? "Prefiro responder" : "Não sei"}
                </button>
            )}
        </div>
    );
}

/**
 * "Qual é o contrato original?": search the Mike's contracts by name or
 * counterparty and pick one, or type that it is not there (a plain answer,
 * which also unties a contract picked before).
 */
function ContractPicker({ id, draft, onDraft }: { id: string; draft: Draft; onDraft: (patch: Partial<Draft>) => void }) {
    const [query, setQuery] = useState("");
    const [found, setFound] = useState<ContractChoice[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [typing, setTyping] = useState(draft.value !== "");
    const term = query.trim();
    const searching = !typing && term.length >= CONTRACT_MIN_LETTERS;
    useEffect(() => {
        if (!searching) return;
        const controller = new AbortController();
        const timer = setTimeout(() => {
            searchRequestContracts(term, controller.signal)
                .then((list) => {
                    setFound(list);
                    setFailed(false);
                })
                .catch(() => {
                    if (!controller.signal.aborted) setFailed(true);
                });
        }, CONTRACT_SEARCH_MS);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [term, searching]);

    if (draft.contract) {
        return (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 px-2 py-1.5">
                <span className="min-w-0 break-words text-gray-900">
                    {draft.contract.name}
                    {draft.contract.counterparty ? <span className="text-gray-500"> · {draft.contract.counterparty}</span> : null}
                </span>
                <button type="button" className="shrink-0 text-[11px] text-gray-500 underline underline-offset-2" onClick={() => onDraft({ contract: null })}>
                    Trocar
                </button>
            </div>
        );
    }
    if (typing) {
        return (
            <div>
                <input
                    id={id}
                    className={FIELD}
                    placeholder="Diga qual é, se souber"
                    value={draft.value}
                    onChange={(e) => onDraft({ value: e.target.value })}
                />
                <button type="button" className="mt-1 text-[11px] text-gray-500 underline underline-offset-2" onClick={() => {
                        setTyping(false);
                        onDraft({ value: "" });
                    }}>
                    Procurar no Mike
                </button>
            </div>
        );
    }
    return (
        <div>
            <input
                id={id}
                className={FIELD}
                role="combobox"
                aria-expanded={searching && found !== null}
                aria-controls={`${id}-lista`}
                placeholder="Procure pelo nome ou pela contraparte"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
            />
            {searching && found !== null ? (
                <ul id={`${id}-lista`} role="listbox" aria-label="Contratos encontrados" className="mt-1 max-h-40 overflow-auto rounded-lg border border-gray-200">
                    {found.length ? (
                        found.map((c) => (
                            <li key={c.id} role="option" aria-selected={false}>
                                <button
                                    type="button"
                                    className="block w-full px-2 py-1.5 text-left hover:bg-gray-50"
                                    onClick={() => {
                                        onDraft({ contract: c });
                                        setQuery("");
                                    }}
                                >
                                    {c.name}
                                    {c.counterparty ? <span className="text-gray-500"> · {c.counterparty}</span> : null}
                                </button>
                            </li>
                        ))
                    ) : (
                        <li className="px-2 py-1.5 text-gray-500">Nenhum contrato com esse nome.</li>
                    )}
                </ul>
            ) : null}
            {searching && failed ? <p className="mt-1 text-[11px] text-gray-500" role="status">Não consegui buscar agora. Escreva o nome e anexe o contrato.</p> : null}
            <button
                type="button"
                className="mt-1 text-[11px] text-gray-500 underline underline-offset-2"
                onClick={() => {
                    setTyping(true);
                    onDraft({ value: NOT_IN_MIKE });
                }}
            >
                Não está no Mike, vou anexar
            </button>
        </div>
    );
}

function AnswerInput({
    id,
    item,
    draft,
    onDraft,
}: {
    id: string;
    item: Item;
    draft: Draft;
    onDraft: (patch: Partial<Draft>) => void;
}) {
    if (item.kind === "yes_no") {
        return (
            <div>
                <div role="radiogroup" aria-labelledby={id} className="flex gap-2" id={id}>
                    {(["sim", "nao"] as const).map((v) => (
                        <label key={v} className="inline-flex items-center gap-1">
                            <input
                                type="radio"
                                name={id}
                                value={v}
                                checked={draft.value === v}
                                onChange={() => onDraft({ value: v })}
                            />
                            {v === "sim" ? "Sim" : "Não"}
                        </label>
                    ))}
                </div>
                {item.detail_label && draft.value === "sim" ? (
                    <input
                        aria-label={item.detail_label}
                        placeholder={item.detail_label}
                        className={cn(FIELD, "mt-1")}
                        value={draft.detail}
                        onChange={(e) => onDraft({ detail: e.target.value })}
                    />
                ) : null}
            </div>
        );
    }
    if (item.kind === "contract") {
        return <ContractPicker id={id} draft={draft} onDraft={onDraft} />;
    }
    if (item.kind === "choice" || item.kind === "multi_choice") {
        const single = item.kind === "choice";
        const toggle = (code: string) =>
            onDraft({
                selected: single
                    ? [code]
                    : draft.selected.includes(code)
                      ? draft.selected.filter((c) => c !== code)
                      : [...draft.selected, code],
            });
        return (
            <div role={single ? "radiogroup" : "group"} aria-label={item.label} id={id} className="space-y-1">
                {(item.options ?? []).map((o) => (
                    <label key={o.value} className="flex items-center gap-1.5">
                        <input
                            type={single ? "radio" : "checkbox"}
                            name={id}
                            value={o.value}
                            checked={draft.selected.includes(o.value)}
                            onChange={() => toggle(o.value)}
                        />
                        {o.label}
                    </label>
                ))}
            </div>
        );
    }
    if (item.kind === "long_text") {
        return <textarea id={id} rows={3} className={FIELD} value={draft.value} onChange={(e) => onDraft({ value: e.target.value })} />;
    }
    return (
        <input
            id={id}
            className={FIELD}
            placeholder={item.kind === "date" ? "ex.: 01/11/2026 ou na assinatura" : item.kind === "money" ? "ex.: R$ 12.000 por mês" : undefined}
            value={draft.value}
            onChange={(e) => onDraft({ value: e.target.value })}
        />
    );
}

function AnsweredRow({
    item,
    canAnswer,
    busy,
    editing,
    draft,
    onDraft,
    onEdit,
    onConfirm,
    onSave,
}: {
    item: Item;
    canAnswer: boolean;
    busy?: boolean;
    editing: boolean;
    draft: Draft;
    onDraft: (patch: Partial<Draft>) => void;
    onEdit: () => void;
    onConfirm: () => void;
    onSave: () => void;
}) {
    const inferred = item.state === "inferido";
    return (
        <li
            className={cn(
                "rounded-lg px-2 py-1.5 text-xs",
                inferred ? "bg-violet-50 dark:bg-violet-500/10" : "",
            )}
        >
            <div className="flex items-start gap-1.5">
                {inferred ? (
                    <Sparkles aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0 text-violet-600" />
                ) : (
                    <Check aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
                )}
                <div className="min-w-0 flex-1">
                    <span className="block text-gray-500">{item.label}</span>
                    {editing ? (
                        <form
                            className="mt-1 space-y-1"
                            onSubmit={(e) => {
                                e.preventDefault();
                                onSave();
                            }}
                        >
                            <AnswerField id={`intake-edit-${item.key}`} item={item} draft={draft} onDraft={onDraft} />
                            <PillButtonUI tone="black" size="sm" type="submit" loading={busy} disabled={answerOf(item, draft) === null}>
                                Salvar
                            </PillButtonUI>
                        </form>
                    ) : (
                        <span className={cn("block break-words", item.answer?.unknown ? "italic text-gray-500" : "text-gray-900")}>{item.answer?.value}</span>
                    )}
                    {inferred && !editing ? (
                        <>
                            {item.answer?.quote ? (
                                <blockquote className="mt-1 border-l-2 border-violet-300 pl-2 text-[11px] text-gray-600">
                                    “{item.answer.quote}”
                                </blockquote>
                            ) : null}
                            <span className="mt-1 block text-[11px] text-violet-700">Lido no contrato pelo agente. Confirme ou corrija.</span>
                        </>
                    ) : null}
                </div>
                {canAnswer && !editing ? (
                    <div className="flex shrink-0 gap-1">
                        {inferred ? (
                            <PillButtonUI tone="black" size="sm" onClick={onConfirm} loading={busy}>
                                Confirmar
                            </PillButtonUI>
                        ) : null}
                        <PillButtonUI tone="white" size="sm" onClick={onEdit} disabled={busy}>
                            {inferred ? "Corrigir" : "Mudar"}
                        </PillButtonUI>
                    </div>
                ) : null}
            </div>
        </li>
    );
}

/**
 * The checklist with its own loading and saving, for the team's panel and the
 * requester's page. Says nothing while loading and stays out of the way when
 * the request has no checklist to show.
 */
export function RequestIntakeSection({
    requestId,
    audience,
    onChanged,
    reloadKey,
}: {
    requestId: string;
    audience: "requester" | "team";
    onChanged?: () => void;
    /** Bump to reload (after another change on the request). */
    reloadKey?: number;
}) {
    const [intake, setIntake] = useState<RequestIntake | null>(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        let cancelled = false;
        getRequestIntake(requestId)
            .then((data) => {
                if (!cancelled) setIntake(data);
            })
            .catch(() => {
                if (!cancelled) setIntake(null);
            });
        return () => {
            cancelled = true;
        };
    }, [requestId, reloadKey]);
    // While the agent reads the contract, look again until it is done; a
    // failed look keeps the screen as it is and tries again.
    const reading = intake?.prefill === "lendo";
    const [missed, setMissed] = useState(0);
    useEffect(() => {
        if (!reading) return;
        const timer = setTimeout(() => {
            getRequestIntake(requestId)
                .then(setIntake)
                .catch(() => setMissed((n) => n + 1));
        }, PREFILL_POLL_MS);
        return () => clearTimeout(timer);
    }, [reading, intake, missed, requestId]);
    if (!intake) return null;
    return (
        <IntakeChecklist
            intake={intake}
            audience={audience}
            busy={busy}
            onAnswer={async (body) => {
                setBusy(true);
                try {
                    const next = await answerRequestIntake(requestId, body);
                    setIntake(next);
                    if (next.complete && !intake.complete) {
                        showToast({ tone: "success", message: "Checklist completo. O Legal já pode analisar o contrato." });
                    }
                    onChanged?.();
                } catch (err) {
                    notifyError(err, { lang: "pt", action: "salvar as respostas" });
                } finally {
                    setBusy(false);
                }
            }}
        />
    );
}
