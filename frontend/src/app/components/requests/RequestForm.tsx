"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Paperclip, X } from "lucide-react";
import { ModalUI } from "@/shared/ui/ModalUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import {
    createRequest,
    getRequestRole,
    uploadStandaloneDocument,
    type LegalRequest,
    type RequestKind,
    type RequestUrgency,
} from "@/app/lib/mikeApi";
import { KIND_OPTIONS, URGENCY_OPTIONS } from "@/app/lib/requests";
import { notifyError } from "@/app/lib/userFacingError";

const FIELD =
    "w-full rounded-lg border border-gray-200 bg-app-surface px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40";

/**
 * "Pedir ao Legal" in thirty seconds: what you need, with whom, why, by when,
 * and the file if there is one. No legal field; the triage agent does the
 * rest.
 */
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
    const [counterparty, setCounterparty] = useState("");
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

    function reset() {
        setKind(null);
        setCounterparty("");
        setContext("");
        setUrgency("normal");
        setNeededBy("");
        setFiles([]);
        setError(null);
        setChangingArea(false);
    }

    async function submit(event?: FormEvent) {
        event?.preventDefault();
        if (!kind) return setError("Escolha o que você precisa.");
        if (askArea && !area) return setError("Diga de qual área você é.");
        if (!context.trim() && !counterparty.trim()) return setError("Conte em uma frase o que você precisa.");
        setBusy(true);
        setError(null);
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
            });
            if (area) setKnownArea(area);
            reset();
            onCreated(request);
        } catch (err) {
            notifyError(err, { lang: "pt", action: "enviar seu pedido", onRetry: () => submit() });
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
                <PillButtonUI tone="white" onClick={onClose}>
                    Cancelar
                </PillButtonUI>
            }
            primaryAction={
                <PillButtonUI tone="black" type="submit" form="request-form" loading={busy}>
                    Enviar pedido
                </PillButtonUI>
            }
        >
            <form id="request-form" onSubmit={submit} className="space-y-5 px-1 pb-2">
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

                <label className="block">
                    <span className="mb-1 block text-xs font-medium text-gray-700">Com quem?</span>
                    <input
                        className={FIELD}
                        value={counterparty}
                        onChange={(e) => setCounterparty(e.target.value)}
                        placeholder="Empresa ou pessoa do outro lado (se houver)"
                        maxLength={200}
                    />
                </label>

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
            </form>
        </ModalUI>
    );
}
