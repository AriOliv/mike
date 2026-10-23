"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Paperclip, X } from "lucide-react";
import { ModalUI } from "@/shared/ui/ModalUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import {
    createRequest,
    getRequestRole,
    lookupCnpj,
    uploadStandaloneDocument,
    MikeApiError,
    type LegalRequest,
    type RequestKind,
    type RequestUrgency,
} from "@/app/lib/mikeApi";
import { KIND_OPTIONS, URGENCY_OPTIONS } from "@/app/lib/requests";
import { describeError, errorCode, notifyError } from "@/app/lib/userFacingError";
import { emailError, monthsError, parseMonths, startNotice, termEndSentence } from "@/app/lib/contractTerms";

const FIELD =
    "w-full rounded-lg border border-gray-200 bg-app-surface px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40";

/**
 * "Pedir ao Legal" in three short parts, one at a time: what you need (and
 * your area), the contract (the file, the other party, the term), and what
 * the Legal needs to know (the context, how urgent, by when). The second
 * part is skippable: an NDA or a question has no file. Nothing in it is
 * required. No legal field; the triage agent does the rest.
 */
const PARTS = ["O que você precisa", "O contrato", "O que o Legal precisa saber"] as const;
const FIELD_PART: Record<string, 0 | 1 | 2> = { counterparty_email: 1, term_start: 1, term_months: 1 };

export function RequestForm({
    open,
    onClose,
    onCreated,
}: {
    open: boolean;
    onClose: () => void;
    onCreated: (request: LegalRequest) => void;
}) {
    const [kind, setKind] = useState<RequestKind | null>(null);
    const [part, setPart] = useState<0 | 1 | 2>(0);
    const [counterparty, setCounterparty] = useState("");
    const [counterpartyEmail, setCounterpartyEmail] = useState("");
    const [termStart, setTermStart] = useState("");
    const [termMonths, setTermMonths] = useState("");
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [touched, setTouched] = useState<Record<string, boolean>>({});
    // L-54: a CNPJ typed here can be looked up; the company name replaces it.
    const [cnpjBusy, setCnpjBusy] = useState(false);
    const [cnpjNote, setCnpjNote] = useState<string | null>(null);
    const [context, setContext] = useState("");
    const [urgency, setUrgency] = useState<RequestUrgency>("normal");
    const [neededBy, setNeededBy] = useState("");
    const [files, setFiles] = useState<File[]>([]);
    // The requesting area: asked once, remembered by the server afterwards.
    const [areas, setAreas] = useState<string[]>([]);
    const [knownArea, setKnownArea] = useState<string | null | undefined>(undefined);
    const [area, setArea] = useState<string | null>(null);
    const [changingArea, setChangingArea] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!open || knownArea !== undefined) return;
        let cancelled = false;
        getRequestRole()
            .then((me) => {
                if (cancelled) return;
                setAreas(me.areas ?? []);
                setKnownArea(me.area ?? null);
            })
            // Without the answer the form still works; the area is just not asked.
            .catch(() => !cancelled && setKnownArea(null));
        return () => {
            cancelled = true;
        };
    }, [open, knownArea]);

    const askArea = (knownArea === null || changingArea) && areas.length > 0;

    const emailMessage = fieldErrors.counterparty_email || (touched.email ? emailError(counterpartyEmail) : null);
    const monthsMessage = fieldErrors.term_months || monthsError(termMonths);
    const startMessage = fieldErrors.term_start || null;
    const startWarning = startNotice(termStart);
    const endSentence = termEndSentence(termStart, parseMonths(termMonths));

    function reset() {
        setPart(0);
        setCounterpartyEmail("");
        setTermStart("");
        setTermMonths("");
        setFieldErrors({});
        setTouched({});
        setKind(null);
        setCounterparty("");
        setContext("");
        setUrgency("normal");
        setNeededBy("");
        setFiles([]);
        setError(null);
        setChangingArea(false);
    }

    /** Part 1 is complete when there is a kind (and an area, when asked). */
    function partOneProblem(): string | null {
        if (!kind) return "Escolha o que você precisa.";
        if (askArea && !area) return "Diga de qual área você é.";
        return null;
    }

    function next() {
        if (part === 0) {
            const problem = partOneProblem();
            if (problem) return setError(problem);
        }
        if (part === 1) {
            setTouched((t) => ({ ...t, email: true }));
            const problem = emailError(counterpartyEmail) ?? monthsError(termMonths);
            if (problem) return setError(problem);
        }
        setError(null);
        setPart((current) => Math.min(2, current + 1) as 0 | 1 | 2);
    }

    function back() {
        setError(null);
        setPart((current) => Math.max(0, current - 1) as 0 | 1 | 2);
    }

    async function findCnpj() {
        setCnpjBusy(true);
        setCnpjNote(null);
        try {
            const found = await lookupCnpj(counterparty);
            setCounterparty(found.razao_social.slice(0, 200));
            setCnpjNote(`Receita: ${found.situacao ?? "situação não informada"}${found.cnae.descricao ? ` · ${found.cnae.descricao}` : ""}`);
        } catch (e) {
            setCnpjNote(
                errorCode(e) === "cnpj_disabled"
                    ? "A consulta de CNPJ ainda não está ligada. Digite o nome da empresa."
                    : describeError(e, { lang: "pt", action: "consultar o CNPJ" }).message,
            );
        } finally {
            setCnpjBusy(false);
        }
    }

    async function submit(event?: FormEvent) {
        event?.preventDefault();
        // Enter in a field moves on; only the last part sends.
        if (part < 2) return next();
        const problem = partOneProblem();
        if (problem || !kind) {
            setPart(0);
            return setError(problem ?? "Escolha o que você precisa.");
        }
        if (!context.trim() && !counterparty.trim()) return setError("Conte em uma frase o que você precisa.");
        const blocking = emailError(counterpartyEmail) ?? monthsError(termMonths);
        if (blocking) {
            setPart(1);
            setTouched((t) => ({ ...t, email: true }));
            return setError(blocking);
        }
        const months = parseMonths(termMonths);
        setBusy(true);
        setError(null);
        setFieldErrors({});
        try {
            const uploaded = await Promise.all(files.map((file) => uploadStandaloneDocument(file)));
            const { request } = await createRequest({
                kind,
                counterparty: counterparty.trim() || undefined,
                context: context.trim() || undefined,
                urgency,
                needed_by: neededBy || null,
                document_ids: uploaded.map((d) => d.id),
                ...(area ? { requester_area: area } : {}),
                ...(counterpartyEmail.trim() ? { counterparty_email: counterpartyEmail.trim() } : {}),
                ...(termStart ? { term_start: termStart } : {}),
                ...(months !== null && !Number.isNaN(months) ? { term_months: months } : {}),
            });
            if (area) setKnownArea(area);
            reset();
            onCreated(request);
        } catch (err) {
            // A 422 that names a field is painted on that field, in the part that holds it.
            if (err instanceof MikeApiError && err.status === 422 && err.field && err.field in FIELD_PART) {
                setFieldErrors({ [err.field]: err.message });
                setPart(FIELD_PART[err.field]);
                setError(null);
            } else {
                notifyError(err, { lang: "pt", action: "enviar seu pedido", onRetry: () => submit() });
            }
        } finally {
            setBusy(false);
        }
    }

    return (
        <ModalUI
            open={open}
            onClose={onClose}
            size="md"
            ariaLabel="Pedir ao Legal"
            breadcrumbs={["Pedir ao Legal"]}
            footerStatus={
                error ? (
                    <span role="alert" className="text-xs text-red-600">
                        {error}
                    </span>
                ) : (
                    <span className="text-xs text-gray-500">O Legal responde por e-mail e aqui em Pedidos.</span>
                )
            }
            cancelAction={
                part === 0 ? (
                    <PillButtonUI tone="white" onClick={onClose}>
                        Cancelar
                    </PillButtonUI>
                ) : (
                    <PillButtonUI tone="white" onClick={back} disabled={busy}>
                        Voltar
                    </PillButtonUI>
                )
            }
            primaryAction={
                part < 2 ? (
                    <PillButtonUI tone="black" onClick={next}>
                        {part === 1 && !files.length && !counterparty.trim() && !counterpartyEmail.trim() && !termStart && !termMonths.trim()
                            ? "Pular"
                            : "Continuar"}
                    </PillButtonUI>
                ) : (
                    <PillButtonUI tone="black" type="submit" form="request-form" loading={busy}>
                        Enviar pedido
                    </PillButtonUI>
                )
            }
        >
            <form id="request-form" onSubmit={submit} className="space-y-5 px-1 pb-2">
                <p className="text-xs text-gray-500" aria-live="polite">
                    <span className="font-medium text-gray-700">Parte {part + 1} de 3</span> · {PARTS[part]}
                </p>

                <div className={part === 0 ? "space-y-5" : "hidden"}>
                <fieldset>
                    <legend className="mb-2 text-xs font-medium text-gray-700">O que você precisa?</legend>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {KIND_OPTIONS.map((option) => (
                            <button
                                key={option.value}
                                type="button"
                                aria-pressed={kind === option.value}
                                onClick={() => setKind(option.value)}
                                className={
                                    "flex min-w-0 flex-col items-start rounded-xl border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 " +
                                    (kind === option.value
                                        ? "border-gray-400 bg-app-surface-active"
                                        : "border-gray-200 bg-app-surface hover:bg-app-surface-hover")
                                }
                            >
                                <span className="text-sm text-gray-900">{option.label}</span>
                                <span className="text-[11px] text-gray-500">{option.hint}</span>
                            </button>
                        ))}
                    </div>
                </fieldset>

                {askArea ? (
                    <fieldset>
                        <legend className="mb-1 text-xs font-medium text-gray-700">De qual área você é?</legend>
                        <p className="mb-2 text-[11px] text-gray-500">Só nesta primeira vez: depois o Mike lembra.</p>
                        <div className="flex flex-wrap gap-1.5">
                            {areas.map((option) => (
                                <TabPillButtonUI key={option} active={area === option} onClick={() => setArea(option)}>
                                    {option}
                                </TabPillButtonUI>
                            ))}
                        </div>
                    </fieldset>
                ) : knownArea ? (
                    <p className="text-xs text-gray-500">
                        Área: <span className="text-gray-900">{knownArea}</span> ·{" "}
                        <button
                            type="button"
                            onClick={() => {
                                setArea(knownArea);
                                setChangingArea(true);
                            }}
                            className="rounded underline-offset-2 hover:text-gray-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                        >
                            trocar
                        </button>
                    </p>
                ) : null}
                </div>

                <div className={part === 1 ? "space-y-5" : "hidden"}>
                    <p className="text-xs text-gray-500">
                        Tem um contrato ou minuta? Anexe aqui. Se é um NDA novo ou uma dúvida, pode pular: nada desta parte é obrigatório.
                    </p>
                    <div>
                        <input
                            ref={fileInput}
                            type="file"
                            multiple
                            hidden
                            accept=".pdf,.doc,.docx"
                            aria-label="Anexar arquivos"
                            onChange={(e) => {
                                const picked = Array.from(e.target.files ?? []);
                                setFiles((current) => [...current, ...picked].slice(0, 5));
                                e.target.value = "";
                            }}
                        />
                        <PillButtonUI tone="white" size="xs" onClick={() => fileInput.current?.click()} disabled={files.length >= 5}>
                            <Paperclip aria-hidden="true" className="h-3 w-3" />
                            Anexar contrato ou minuta
                        </PillButtonUI>
                        {files.length ? (
                            <ul className="mt-2 space-y-1">
                                {files.map((file, index) => (
                                    <li key={`${file.name}-${index}`} className="flex items-center gap-2 text-xs text-gray-700">
                                        <span className="min-w-0 break-all">{file.name}</span>
                                        <button
                                            type="button"
                                            aria-label={`Remover ${file.name}`}
                                            onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                                            className="rounded p-0.5 text-gray-400 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                        >
                                            <X aria-hidden="true" className="h-3 w-3" />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        ) : null}
                    </div>
                    <label className="block">
                        <span className="mb-1 block text-xs font-medium text-gray-700">Com quem?</span>
                        <span className="flex gap-2">
                            <input
                                className={FIELD}
                                value={counterparty}
                                onChange={(e) => {
                                    setCounterparty(e.target.value);
                                    setCnpjNote(null);
                                }}
                                placeholder="Empresa ou pessoa do outro lado (se houver). Pode digitar o CNPJ."
                                maxLength={200}
                            />
                            {counterparty.replace(/\D/g, "").length === 14 ? (
                                <PillButtonUI tone="white" size="sm" onClick={() => void findCnpj()} loading={cnpjBusy} disabled={cnpjBusy}>
                                    Buscar CNPJ
                                </PillButtonUI>
                            ) : null}
                        </span>
                        {cnpjNote ? <span className="mt-1 block text-[11px] text-gray-500">{cnpjNote}</span> : null}
                    </label>

                    <div>
                        <label className="block">
                            <span className="mb-1 block text-xs font-medium text-gray-700">E-mail da outra parte (opcional)</span>
                            <input
                                type="email"
                                className={FIELD}
                                value={counterpartyEmail}
                                onChange={(e) => {
                                    setCounterpartyEmail(e.target.value);
                                    setError(null);
                                    setFieldErrors((f) => ({ ...f, counterparty_email: "" }));
                                }}
                                onBlur={() => setTouched((t) => ({ ...t, email: true }))}
                                placeholder="nome@empresa.com"
                                aria-invalid={emailMessage ? true : undefined}
                                aria-describedby="email-help"
                                maxLength={254}
                            />
                        </label>
                        <p id="email-help" className="mt-1 text-[11px] text-gray-500">
                            Só guardamos este e-mail para uso futuro. Não enviamos nada a essa pessoa.
                        </p>
                        {emailMessage ? <p role="alert" className="mt-1 text-xs text-red-600">{emailMessage}</p> : null}
                    </div>

                    <div className="flex flex-wrap items-start gap-4">
                        <div>
                            <label className="block">
                                <span className="mb-1 block text-xs font-medium text-gray-700">Início da vigência</span>
                                <input
                                    type="date"
                                    className={FIELD + " w-auto py-1.5"}
                                    value={termStart}
                                    onChange={(e) => {
                                        setTermStart(e.target.value);
                                        setFieldErrors((f) => ({ ...f, term_start: "" }));
                                    }}
                                    aria-invalid={startMessage ? true : undefined}
                                />
                            </label>
                            {startMessage ? <p role="alert" className="mt-1 text-xs text-red-600">{startMessage}</p> : null}
                        </div>
                        <div>
                            <label className="block">
                                <span className="mb-1 block text-xs font-medium text-gray-700">Prazo (em meses)</span>
                                <input
                                    inputMode="numeric"
                                    className={FIELD + " w-28"}
                                    value={termMonths}
                                    onChange={(e) => {
                                        setTermMonths(e.target.value);
                                        setError(null);
                                        setFieldErrors((f) => ({ ...f, term_months: "" }));
                                    }}
                                    placeholder="12"
                                    aria-invalid={monthsMessage ? true : undefined}
                                    maxLength={4}
                                />
                            </label>
                            {monthsMessage ? <p role="alert" className="mt-1 text-xs text-red-600">{monthsMessage}</p> : null}
                        </div>
                    </div>
                    {endSentence ? <p className="-mt-2 text-xs text-gray-600">{endSentence}</p> : null}
                    {startWarning ? <p className="-mt-2 text-xs text-amber-700">{startWarning}</p> : null}
                </div>

                <div className={part === 2 ? "space-y-5" : "hidden"}>
                <label className="block">
                    <span className="mb-1 block text-xs font-medium text-gray-700">Conte o contexto</span>
                    <textarea
                        className={FIELD + " min-h-[96px] resize-y"}
                        value={context}
                        onChange={(e) => setContext(e.target.value)}
                        placeholder="O que vai acontecer, valores, prazos, o que preocupa. Uma ou duas frases bastam."
                        maxLength={8000}
                    />
                </label>

                <div className="flex flex-wrap items-end gap-4">
                    <fieldset>
                        <legend className="mb-1 text-xs font-medium text-gray-700">Urgência</legend>
                        <div className="flex gap-1.5">
                            {URGENCY_OPTIONS.map((option) => (
                                <TabPillButtonUI
                                    key={option.value}
                                    active={urgency === option.value}
                                    onClick={() => setUrgency(option.value)}
                                >
                                    {option.label}
                                </TabPillButtonUI>
                            ))}
                        </div>
                    </fieldset>
                    <label className="block">
                        <span className="mb-1 block text-xs font-medium text-gray-700">Precisa até</span>
                        <input
                            type="date"
                            className={FIELD + " w-auto py-1.5"}
                            value={neededBy}
                            onChange={(e) => setNeededBy(e.target.value)}
                        />
                    </label>
                </div>

                </div>
            </form>
        </ModalUI>
    );
}
