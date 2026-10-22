"use client";

// "Algo errado? Conte" (doc 13 §2): one step, thirty seconds. The person says
// what happened, sees what goes with it, and sends. Esc closes without losing
// the draft. No image in this phase.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { ModalUI } from "@/shared/ui/ModalUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { sendFeedback, type FeedbackReceipt } from "@/app/lib/mikeApi";
import { checkBody, EMPTY_DRAFT, feedbackStore, technicalContext, type FeedbackDraft } from "@/app/lib/feedback";
import { describeError } from "@/app/lib/userFacingError";

const FIELD =
    "w-full rounded-lg border border-gray-200 bg-app-surface px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40";

export function FeedbackModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { workspaceId } = useWorkspace();
    const [draft, setDraft] = useState<FeedbackDraft>(() => feedbackStore.getDraft());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [receipt, setReceipt] = useState<FeedbackReceipt | null>(null);
    const bodyRef = useRef<HTMLTextAreaElement>(null);

    // Reopening brings the draft back (or the error the toast pre-filled).
    useEffect(() => {
        if (!open) return;
        setDraft(feedbackStore.getDraft());
        setReceipt(null);
        setError(null);
        const t = setTimeout(() => bodyRef.current?.focus(), 0);
        return () => clearTimeout(t);
    }, [open]);

    const update = (patch: Partial<FeedbackDraft>) => {
        const next = { ...draft, ...patch };
        setDraft(next);
        feedbackStore.setDraft(next);
    };

    const check = checkBody(draft.body);
    const context = open ? technicalContext() : null;
    const canSend = !!draft.kind && check.ok && !busy;

    async function submit(event?: FormEvent) {
        event?.preventDefault();
        if (!draft.kind) return setError("Escolha o que você quer contar.");
        if (!check.ok) return setError(check.hint ?? "Conte um pouco mais, pelo menos uma frase.");
        setBusy(true);
        setError(null);
        try {
            const ctx = technicalContext();
            const sent = await sendFeedback({
                kind: draft.kind,
                body: draft.body.trim(),
                ...(draft.kind === "bug" && draft.expected.trim() ? { expected: draft.expected.trim() } : {}),
                ...ctx,
                org_id: workspaceId && workspaceId !== "personal" ? workspaceId : null,
            });
            feedbackStore.clearDraft();
            setDraft(EMPTY_DRAFT);
            setReceipt(sent);
        } catch (e) {
            setError(describeError(e, { lang: "pt", action: "enviar o relato" }).message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <ModalUI
            open={open}
            onClose={onClose}
            size="md"
            ariaLabel="Algo errado? Conte"
            breadcrumbs={["Algo errado? Conte"]}
            footerStatus={
                error ? (
                    <span role="alert" className="text-xs text-red-600">
                        {error}
                    </span>
                ) : (
                    <span className="text-xs text-gray-500">
                        Seu relato vai para o time de tecnologia da Avenia. Não escreva dados de pessoas, como nome, e-mail e CPF, nem trechos de contrato.
                    </span>
                )
            }
            cancelAction={
                <PillButtonUI tone="white" onClick={onClose}>
                    {receipt ? "Fechar" : "Cancelar"}
                </PillButtonUI>
            }
            primaryAction={
                receipt ? undefined : (
                    <PillButtonUI tone="black" type="submit" form="feedback-form" loading={busy} disabled={!canSend}>
                        Enviar
                    </PillButtonUI>
                )
            }
        >
            {receipt ? (
                <div className="flex items-start gap-3 px-1 py-6" role="status">
                    <Check className="mt-0.5 h-5 w-5 shrink-0 text-green-600" aria-hidden="true" />
                    <div className="space-y-1">
                        <p className="text-sm font-medium text-gray-900">Recebemos seu relato.</p>
                        <p className="text-sm text-gray-600">
                            Guarde este número para falar sobre ele: <strong className="font-mono text-gray-900">{receipt.label}</strong>
                        </p>
                        {receipt.redacted ? (
                            <p className="text-xs text-gray-500">Apagamos do texto o que parecia e-mail, CPF, CNPJ ou telefone.</p>
                        ) : null}
                    </div>
                </div>
            ) : (
                <form id="feedback-form" onSubmit={submit} className="space-y-4 px-1 pb-2">
                    <fieldset>
                        <legend className="mb-2 text-xs font-medium text-gray-700">O que você quer contar?</legend>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <TabPillButtonUI active={draft.kind === "bug"} onClick={() => update({ kind: "bug" })}>
                                Algo deu errado
                            </TabPillButtonUI>
                            <TabPillButtonUI active={draft.kind === "feature"} onClick={() => update({ kind: "feature" })}>
                                Tenho uma ideia
                            </TabPillButtonUI>
                        </div>
                    </fieldset>

                    <label className="block">
                        <span className="mb-1 block text-xs font-medium text-gray-700">
                            {draft.kind === "feature" ? "Qual é a ideia?" : "O que aconteceu?"}
                        </span>
                        <textarea
                            ref={bodyRef}
                            className={`${FIELD} min-h-28`}
                            value={draft.body}
                            onChange={(e) => update({ body: e.target.value })}
                            aria-describedby="feedback-body-hint"
                        />
                        <span id="feedback-body-hint" className="mt-1 flex justify-between text-[11px] text-gray-500">
                            <span>{check.hint}</span>
                            <span>{check.counter}</span>
                        </span>
                    </label>

                    {draft.kind === "bug" ? (
                        <label className="block">
                            <span className="mb-1 block text-xs font-medium text-gray-700">O que deveria ter acontecido? (opcional)</span>
                            <input className={FIELD} value={draft.expected} onChange={(e) => update({ expected: e.target.value })} maxLength={1000} />
                        </label>
                    ) : null}

                    {context ? (
                        <details className="text-xs text-gray-500">
                            <summary className="cursor-pointer select-none">O que vai junto com o relato</summary>
                            <ul className="mt-1 space-y-0.5">
                                <li>Página: {context.route}</li>
                                <li>Versão do Mike: {context.app_version}</li>
                                <li>Navegador: {context.browser}</li>
                                <li>Espaço: {workspaceId && workspaceId !== "personal" ? "da organização" : "pessoal"}</li>
                            </ul>
                        </details>
                    ) : null}
                </form>
            )}
        </ModalUI>
    );
}
