"use client";

import { useEffect, useState } from "react";
import { Check, CircleDashed, Sparkles } from "lucide-react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { answerRequestIntake, getRequestIntake, type IntakeAnswerInput, type RequestIntake } from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import { showToast } from "@/app/components/ui/toast";
import { cn } from "@/app/lib/utils";

const FIELD =
    "w-full rounded-lg border border-gray-200 bg-app-surface px-2 py-1.5 text-xs text-gray-900 placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40";

type Item = RequestIntake["items"][number];

/** How often the checklist looks again while the agent is reading the contract. */
export const PREFILL_POLL_MS = 5000;
type Draft = { value: string; detail: string };

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
    const draftOf = (key: string): Draft => drafts[key] ?? { value: "", detail: "" };
    const setDraft = (key: string, patch: Partial<Draft>) =>
        setDrafts((d) => ({ ...d, [key]: { ...draftOf(key), ...patch } }));

    const filled = open.filter((i) => draftOf(i.key).value.trim());
    const send = () => {
        const answers: Record<string, IntakeAnswerInput> = {};
        for (const i of filled) {
            const d = draftOf(i.key);
            answers[i.key] = d.detail.trim() ? { value: d.value, detail: d.detail } : d.value;
        }
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
                    {intake.complete ? "Checklist completo" : `${intake.answered} de ${intake.total} respondidas`}
                </span>
                {toConfirm.length ? (
                    <span className="text-violet-700">· {toConfirm.length} lida{toConfirm.length === 1 ? "" : "s"} no contrato para confirmar</span>
                ) : null}
            </p>
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
                                setDraft(item.key, {
                                    value: item.answer?.choice ?? item.answer?.value ?? "",
                                    detail: item.answer?.detail ?? "",
                                });
                            }}
                            onConfirm={() => onAnswer({ confirm: [item.key] })}
                            onSave={() => {
                                const d = draftOf(item.key);
                                onAnswer({ answers: { [item.key]: d.detail.trim() ? { value: d.value, detail: d.detail } : d.value } });
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
            <AnswerInput id={id} item={item} draft={draft} onDraft={onDraft} />
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
                                if (draft.value.trim()) onSave();
                            }}
                        >
                            <AnswerInput id={`intake-edit-${item.key}`} item={item} draft={draft} onDraft={onDraft} />
                            <PillButtonUI tone="black" size="sm" type="submit" loading={busy} disabled={!draft.value.trim()}>
                                Salvar
                            </PillButtonUI>
                        </form>
                    ) : (
                        <span className="block break-words text-gray-900">{item.answer?.value}</span>
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
