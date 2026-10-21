"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Download, FileText, History, Loader2, Play, Share2, Sparkles } from "lucide-react";
import { clsx } from "clsx";
import {
    decideFichaField,
    decideReviewClause,
    extractContractFicha,
    getContractFicha,
    getContractReview,
    getDocumentFile,
    listContractReviews,
    startContractReview,
    type ContractFicha,
    type ContractReview,
    type ContractReviewSummary,
    type ReviewClause,
} from "@/app/lib/mikeApi";
import {
    isRunning,
    pendingAligned,
    relativeTime,
    stepFocus,
    verdictCounts,
    visibleClauses,
    type VerdictFilter,
} from "@/app/lib/contractReviewView";
import { describeError, notifyError } from "@/app/lib/userFacingError";
import { dismissToast, showToast } from "@/shared/ui/ToastUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import { VerdictCountsUI } from "@/shared/ui/VerdictUI";
import {
    Dropdown,
    DropdownContent,
    DropdownRadioGroup,
    DropdownRadioItem,
    DropdownTrigger,
} from "@/shared/ui/dropdown";
import { EmptyState } from "@/app/components/ui/empty-state";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import { DocxView } from "@/app/components/shared/views/DocxView";
import { EDITOR_SURFACE_CLASS } from "@/app/components/ui/liquid-surface";
import { ContractFichaPanel } from "./ContractFichaPanel";
import { ReviewClauseCard } from "./ReviewClauseCard";

const UNDO_MS = 10_000;

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
    const next = { ...record };
    delete next[key];
    return next;
}

type Pending = {
    timer: ReturnType<typeof setTimeout>;
    toastId: string;
    /** Enough to send the decision without the component, when it unmounts. */
    send: () => Promise<unknown>;
};

/**
 * The contract review: the Word document with the suggested redline as
 * tracked changes on the left; on the right the first review, one card per
 * clause with its verdict, sources and the suggestion to accept, edit or
 * reject, and the Ficha whose verified fields feed the verdicts.
 *
 * A decision shows at once and is sent after the 10-second undo window, so
 * "Desfazer" never has to reverse a change already made in the document.
 * Decisions are sent one at a time: each one writes a new version of the
 * same Word document, and two at once could lose one.
 */
export function ContractReviewWorkspace({
    projectId,
    projectName,
    canEdit,
    onShare,
    initialQuote = null,
    initialRunId = null,
    initialVerdict = null,
    onUrlStateChange,
}: {
    projectId: string;
    projectName: string;
    canEdit: boolean;
    onShare: () => void;
    /** A clause to show on arrival, e.g. from a cited answer in Perguntar. */
    initialQuote?: string | null;
    /** ?run=: the review to open, e.g. from the Início table. */
    initialRunId?: string | null;
    /** ?veredito=: the traffic-light filter to open with. */
    initialVerdict?: VerdictFilter;
    /** Keeps ?run= and ?veredito= in step with what is on screen. */
    onUrlStateChange?: (state: { runId: string | null; filter: VerdictFilter }) => void;
}) {
    const [reviews, setReviews] = useState<ContractReviewSummary[] | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(initialRunId);
    const [review, setReview] = useState<ContractReview | null>(null);
    const [ficha, setFicha] = useState<ContractFicha | null>(null);
    const [fichaLoading, setFichaLoading] = useState(true);
    const [extracting, setExtracting] = useState(false);
    const [starting, setStarting] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [tab, setTab] = useState<"revisao" | "ficha">("revisao");
    const [filter, setFilter] = useState<VerdictFilter>(initialVerdict);
    const [focus, setFocus] = useState(-1);
    const [busy, setBusy] = useState<string | null>(null);
    const [optimistic, setOptimistic] = useState<Record<string, ReviewClause["decision"]>>({});
    const [docRevision, setDocRevision] = useState(0);
    const [highlight, setHighlight] = useState<{ quote: string; key: number } | null>(
        initialQuote ? { quote: initialQuote, key: 0 } : null,
    );
    const pending = useRef(new Map<string, Pending>());
    // Every send waits for the previous one.
    const sendQueue = useRef<Promise<unknown>>(Promise.resolve());
    const enqueue = useCallback((send: () => Promise<unknown>) => {
        const next = sendQueue.current.then(send, send);
        sendQueue.current = next.catch(() => undefined);
        return next;
    }, []);
    // The review on screen: a slow answer for another one is dropped.
    const shownRun = useRef<string | null>(null);

    // ── loading ──────────────────────────────────────────────────────────────
    useEffect(() => {
        let current = true;
        listContractReviews(projectId).then(
            (items) => {
                if (!current) return;
                setReviews(items);
                setLoadError(null);
                // A linked run that is not this contract's falls back to the newest.
                setSelectedId((id) => (id && items.some((item) => item.id === id) ? id : (items[0]?.id ?? null)));
            },
            (error) => {
                if (!current) return;
                setLoadError(describeError(error, { action: "carregar as revisões" }).message);
                setReviews((existing) => existing ?? []);
            },
        );
        getContractFicha(projectId)
            .then((value) => current && setFicha(value))
            .catch(() => current && setFicha(null))
            .finally(() => current && setFichaLoading(false));
        return () => {
            current = false;
        };
    }, [projectId, attempt]);

    const [polls, setPolls] = useState(0);
    const loadReview = useCallback(
        async (runId: string) => {
            try {
                const loaded = await getContractReview(projectId, runId);
                if (shownRun.current === runId) setReview(loaded);
            } catch (error) {
                if (shownRun.current === runId)
                    setLoadError(describeError(error, { action: "abrir a revisão" }).message);
            } finally {
                setPolls((n) => n + 1);
            }
        },
        [projectId],
    );
    useEffect(() => {
        shownRun.current = selectedId;
        if (selectedId) void loadReview(selectedId);
    }, [selectedId, loadReview]);

    // A review drafts its edits on the server: poll until it is done. Each
    // load, failed or not, re-arms the timer, so one network error does not
    // leave the screen on "Redigindo edições…".
    const running = isRunning(review);
    useEffect(() => {
        if (!running || !selectedId) return;
        const timer = setTimeout(() => void loadReview(selectedId), 3000);
        return () => clearTimeout(timer);
    }, [running, selectedId, polls, loadReview]);
    const wasRunning = useRef(false);
    useEffect(() => {
        if (wasRunning.current && !running) {
            setDocRevision((n) => n + 1);
            setAttempt((n) => n + 1);
        }
        wasRunning.current = running;
    }, [running]);

    useEffect(() => {
        onUrlStateChange?.({ runId: selectedId, filter });
    }, [selectedId, filter, onUrlStateChange]);

    // ── derived ──────────────────────────────────────────────────────────────
    const clauses = useMemo(
        () =>
            (review?.clauses ?? []).map((clause) =>
                clause.id in optimistic ? { ...clause, decision: optimistic[clause.id] } : clause,
            ),
        [review, optimistic],
    );
    const shown = useMemo(() => visibleClauses(clauses, filter), [clauses, filter]);
    const counts = useMemo(() => verdictCounts(clauses), [clauses]);
    const aligned = useMemo(() => pendingAligned(clauses), [clauses]);

    // ── actions ──────────────────────────────────────────────────────────────
    async function startReview() {
        setStarting(true);
        try {
            const run = await startContractReview(projectId);
            setSelectedId(run.id);
            setReview(null);
            setAttempt((n) => n + 1);
            setTab("revisao");
        } catch (error) {
            notifyError(error, { action: "iniciar a revisão", onRetry: startReview });
        } finally {
            setStarting(false);
        }
    }

    async function extract() {
        setExtracting(true);
        try {
            setFicha(await extractContractFicha(projectId));
            if (selectedId) void loadReview(selectedId);
        } catch (error) {
            notifyError(error, { action: "extrair a Ficha", onRetry: extract });
        } finally {
            setExtracting(false);
        }
    }

    async function decideField(path: string, action: "confirmar" | "corrigir", value?: unknown) {
        try {
            setFicha(
                await decideFichaField(projectId, {
                    path,
                    action,
                    ...(action === "corrigir" ? { value: value ?? null } : {}),
                }),
            );
            if (selectedId) void loadReview(selectedId);
        } catch (error) {
            notifyError(error, { action: "salvar o campo" });
        }
    }

    function locate(clause: Pick<ReviewClause, "quote" | "edit">) {
        const quote = clause.edit?.inserted_text || clause.quote;
        if (quote) setHighlight((current) => ({ quote, key: (current?.key ?? 0) + 1 }));
    }

    const commit = useCallback(
        (clause: ReviewClause, input: Parameters<typeof decideReviewClause>[3]) => {
            const runId = review?.id;
            if (!runId) return Promise.resolve();
            setBusy(clause.id);
            return enqueue(async () => {
                try {
                    await decideReviewClause(projectId, runId, clause.id, input);
                    setDocRevision((n) => n + 1);
                } catch (error) {
                    notifyError(error, { action: "registrar a decisão" });
                } finally {
                    await loadReview(runId);
                    setOptimistic((current) => without(current, clause.id));
                    setBusy((id) => (id === clause.id ? null : id));
                }
            });
        },
        [projectId, review, loadReview, enqueue],
    );

    /** Drops a decision still in its undo window; true when there was one. */
    function cancelPending(clauseId: string): boolean {
        const queued = pending.current.get(clauseId);
        if (!queued) return false;
        clearTimeout(queued.timer);
        dismissToast(queued.toastId);
        pending.current.delete(clauseId);
        setOptimistic((current) => without(current, clauseId));
        return true;
    }

    function decide(clause: ReviewClause, input: { decision: "aceito" | "editado" | "rejeitado"; edited_text?: string; reason?: string }) {
        cancelPending(clause.id);
        setOptimistic((current) => ({
            ...current,
            [clause.id]: {
                decision: input.decision,
                edited_text: input.edited_text ?? null,
                reason: input.reason ?? null,
                decided_by: "você",
                decided_at: new Date().toISOString(),
                edit: null,
            },
        }));
        const label = input.decision === "aceito" ? "Aceito" : input.decision === "editado" ? "Editado" : "Rejeitado";
        const runId = review?.id;
        const entry: Pending = {
            timer: setTimeout(() => {
                if (pending.current.get(clause.id) !== entry) return;
                pending.current.delete(clause.id);
                void commit(clause, input);
            }, UNDO_MS),
            toastId: "",
            send: () => (runId ? decideReviewClause(projectId, runId, clause.id, input) : Promise.resolve()),
        };
        entry.toastId = showToast({
            tone: "success",
            message: `${label}: ${clause.ruleName}`,
            durationMs: UNDO_MS,
            actions: [
                {
                    label: "Desfazer",
                    // Only this toast's own decision, and only while it is still queued.
                    onClick: () => {
                        if (pending.current.get(clause.id) === entry) cancelPending(clause.id);
                    },
                },
            ],
        });
        pending.current.set(clause.id, entry);
        setFocus((index) => stepFocus(index, 1, shown.length));
    }

    function reopen(clause: ReviewClause) {
        if (cancelPending(clause.id) || busy === clause.id) return;
        if (clause.decision && clause.decision.decision !== "aceito") {
            showToast({
                tone: "info",
                message: "Esta decisão já foi aplicada ao documento. Ajuste a alteração direto no documento, na aba Documentos.",
            });
            return;
        }
        void commit(clause, { decision: "desfeito" });
    }

    function acceptAligned() {
        for (const clause of aligned) decide(clause, { decision: "aceito" });
    }

    // Leaving the page sends what is still in its undo window, one at a
    // time, so no decision is lost and none overwrites another.
    useEffect(() => {
        const queue = pending.current;
        return () => {
            for (const item of queue.values()) {
                clearTimeout(item.timer);
                dismissToast(item.toastId);
                enqueue(item.send).catch((error: unknown) => notifyError(error, { action: "registrar a decisão" }));
            }
            queue.clear();
        };
    }, [enqueue]);

    async function exportDocx() {
        const documentId = review?.document.id;
        if (!documentId) return;
        try {
            const { blob, filename } = await getDocumentFile(documentId);
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = filename ?? review?.document.name ?? "contrato-revisado.docx";
            link.click();
            URL.revokeObjectURL(url);
        } catch (error) {
            notifyError(error, { action: "exportar o .docx", onRetry: exportDocx });
        }
    }

    // j/k move between clauses, Enter on a focused card shows it in the document.
    function onListKey(event: React.KeyboardEvent<HTMLDivElement>) {
        const target = event.target as HTMLElement;
        if (target.closest("input, textarea, select") || target.isContentEditable) return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key === "j" || event.key === "k") {
            event.preventDefault();
            setFocus((index) => stepFocus(index, event.key === "j" ? 1 : -1, shown.length));
        } else if (event.key === "Enter" && target.tagName === "ARTICLE" && focus >= 0 && shown[focus]) {
            event.preventDefault();
            locate(shown[focus]);
        }
    }

    // ── render ───────────────────────────────────────────────────────────────
    const documentId = review?.document.id ?? ficha?.document_id ?? null;
    const header = (
        <div className="flex flex-wrap items-center gap-2 px-1 pb-3">
            <h1 className="min-w-0 flex-1 truncate font-serif text-xl text-gray-900" title={projectName}>
                Revisão · {projectName}
            </h1>
            {reviews && reviews.length > 0 && (
                <Dropdown>
                    <DropdownTrigger asChild>
                        <TextButtonUI size="sm" aria-label="Versões da revisão">
                            <History aria-hidden="true" className="h-3.5 w-3.5" />
                            Versões ({reviews.length})
                            <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
                        </TextButtonUI>
                    </DropdownTrigger>
                    <DropdownContent align="end">
                        <DropdownRadioGroup value={selectedId ?? ""} onValueChange={(id) => setSelectedId(id)}>
                            {reviews.map((item, index) => (
                                <DropdownRadioItem key={item.id} value={item.id}>
                                    <span className="flex flex-col">
                                        <span>
                                            Revisão {reviews.length - index} · {relativeTime(item.started_at)}
                                        </span>
                                        <span className="text-xs text-gray-500">
                                            {item.playbook_name} · {item.counts.diverge} divergem · {item.counts.precisa_revisao} a revisar
                                        </span>
                                    </span>
                                </DropdownRadioItem>
                            ))}
                        </DropdownRadioGroup>
                    </DropdownContent>
                </Dropdown>
            )}
            <TextButtonUI size="sm" onClick={onShare}>
                <Share2 aria-hidden="true" className="h-3.5 w-3.5" />
                Compartilhar
            </TextButtonUI>
            <TextButtonUI size="sm" onClick={exportDocx} disabled={!review?.document.id}>
                <Download aria-hidden="true" className="h-3.5 w-3.5" />
                Exportar .docx
            </TextButtonUI>
            {canEdit && (
                <PillButtonUI tone="black" size="sm" loading={starting} disabled={running} onClick={startReview}>
                    <Play aria-hidden="true" className="h-3.5 w-3.5" />
                    {reviews?.length ? "Revisar de novo" : "Revisar com o playbook"}
                </PillButtonUI>
            )}
        </div>
    );

    const documentPane = (
        <section
            aria-label="Contrato com a redline"
            className={clsx("flex min-h-[28rem] min-w-0 flex-col overflow-hidden lg:min-h-0", EDITOR_SURFACE_CLASS)}
        >
            {documentId ? (
                <DocxView
                    documentId={documentId}
                    refetchKey={docRevision}
                    filename={review?.document.name ?? undefined}
                    canEdit={false}
                    defaultMode="view"
                    toolbarVisible={false}
                    quotes={highlight ? [{ quote: highlight.quote }] : undefined}
                    quoteFocusKey={highlight?.key}
                    rounded={false}
                />
            ) : reviews === null ? (
                <div aria-hidden="true" className="space-y-3 p-6">
                    {["w-3/4", "w-full", "w-5/6", "w-2/3"].map((width) => (
                        <SkeletonLine key={width} className={width} />
                    ))}
                </div>
            ) : (
                <div className="flex flex-1 items-center justify-center p-6">
                    <EmptyState
                        icon={<FileText className="text-gray-300" />}
                        title="O contrato aparece aqui"
                        description="Envie o contrato em Word (.docx) na aba Documentos. A revisão marca as edições sugeridas como alterações controladas, prontas para a contraparte."
                    />
                </div>
            )}
        </section>
    );

    const reviewBody = !review ? (
        reviews === null || (selectedId && !loadError) ? (
            <div aria-hidden="true" className="space-y-3">
                <SkeletonLine className="h-16 w-full" />
                {["w-full", "w-5/6", "w-2/3"].map((width) => (
                    <SkeletonLine key={width} className={width} />
                ))}
            </div>
        ) : loadError ? (
            <EmptyState
                tone="error"
                title="Não consegui carregar a revisão"
                description={loadError}
                action={
                    <PillButtonUI tone="black" onClick={() => setAttempt((n) => n + 1)}>
                        Tentar de novo
                    </PillButtonUI>
                }
            />
        ) : (
            <EmptyState
                icon={<Sparkles className="text-violet-500" />}
                title="Nenhuma revisão ainda"
                description="Eu reviso o contrato com o Playbook Avenia v1 (cessão, mudança de controle, LGPD, limitação de responsabilidade, multas, foro, renovação e aviso prévio), marco as edições no documento e digo, cláusula por cláusula, o que está alinhado e o que diverge. Você aceita, edita ou rejeita cada sugestão."
                action={
                    canEdit && (
                        <PillButtonUI tone="black" loading={starting} onClick={startReview}>
                            Revisar com o playbook
                        </PillButtonUI>
                    )
                }
            />
        )
    ) : running ? (
        <div role="status" className="flex flex-col items-start gap-2 py-6">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                Redigindo edições…
            </span>
            <p className="text-sm text-gray-600">
                Estou lendo o contrato contra o playbook. Pode sair desta página: a revisão continua e aparece aqui quando terminar.
            </p>
        </div>
    ) : review.error ? (
        <EmptyState
            tone="error"
            title="A revisão não terminou"
            description={review.error}
            action={
                canEdit && (
                    <PillButtonUI tone="black" onClick={startReview}>
                        Tentar de novo
                    </PillButtonUI>
                )
            }
        />
    ) : (
        <div className="space-y-3" onKeyDown={onListKey}>
            <VerdictCountsUI variant="tiles" {...counts} selected={filter} onSelect={setFilter} />
            {review.summary && <p className="text-sm leading-relaxed text-gray-700">{review.summary}</p>}
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                <span>
                    {review.playbook.name} · {relativeTime(review.completed_at ?? review.started_at)}
                </span>
                {canEdit && aligned.length > 0 && (
                    <TextButtonUI size="xs" className="ml-auto" onClick={acceptAligned}>
                        Aceitar todos os alinhados ({aligned.length})
                    </TextButtonUI>
                )}
            </div>
            {!ficha?.ficha && (
                <p className="rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-700">
                    Sem a Ficha, o semáforo usa só o playbook.{" "}
                    <button type="button" className="underline" onClick={() => setTab("ficha")}>
                        Extrair a Ficha
                    </button>{" "}
                    para somar as regras de risco e os precedentes.
                </p>
            )}
            {shown.length === 0 ? (
                <p className="py-6 text-sm text-gray-500">
                    {filter ? "Nada com este semáforo." : "O playbook não encontrou cláusulas para revisar."}
                </p>
            ) : (
                shown.map((clause, index) => (
                    <ReviewClauseCard
                        key={clause.id}
                        clause={clause}
                        reviewedAt={review.completed_at ?? review.started_at}
                        canDecide={canEdit}
                        busy={busy === clause.id}
                        focused={index === focus}
                        onFocus={() => setFocus(index)}
                        onLocate={() => locate(clause)}
                        onAccept={() => decide(clause, { decision: "aceito" })}
                        onEdit={(text) => decide(clause, { decision: "editado", edited_text: text })}
                        onReject={(reason) => decide(clause, { decision: "rejeitado", reason: reason || undefined })}
                        onReopen={() => reopen(clause)}
                    />
                ))
            )}
            {review.uncovered.length > 0 && (
                <section aria-label="Riscos sem regra no playbook" className="space-y-1.5 rounded-xl bg-gray-100/70 p-3">
                    <h3 className="text-xs font-medium text-gray-700">Riscos da Ficha sem regra no playbook</h3>
                    <ul className="space-y-1 text-xs text-gray-600">
                        {review.uncovered.map((finding) => (
                            <li key={finding.rule_id}>
                                <span className="font-medium text-gray-700">{finding.rule_id}</span> · {finding.titulo}
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </div>
    );

    return (
        <div className="flex h-full min-h-0 flex-col px-4 pb-4 md:px-6 md:pb-6">
            {header}
            <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,58fr)_minmax(0,42fr)]">
                {documentPane}
                <section
                    aria-label="Primeira revisão"
                    className={clsx("flex min-h-[24rem] min-w-0 flex-col overflow-hidden lg:min-h-0", EDITOR_SURFACE_CLASS)}
                >
                    <div role="tablist" aria-label="Painel da revisão" className="flex items-center gap-1.5 border-b border-gray-100 px-3 py-2">
                        <TabPillButtonUI role="tab" aria-selected={tab === "revisao"} active={tab === "revisao"} onClick={() => setTab("revisao")}>
                            Primeira revisão
                        </TabPillButtonUI>
                        <TabPillButtonUI role="tab" aria-selected={tab === "ficha"} active={tab === "ficha"} onClick={() => setTab("ficha")}>
                            Ficha
                            {ficha?.ficha && (
                                <span className="ml-1 text-gray-500">
                                    {ficha.progress.verified}/{ficha.progress.total}
                                </span>
                            )}
                        </TabPillButtonUI>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto p-3 md:p-4">
                        {tab === "revisao" ? (
                            reviewBody
                        ) : (
                            <ContractFichaPanel
                                ficha={ficha}
                                loading={fichaLoading}
                                extracting={extracting}
                                canEdit={canEdit}
                                onExtract={extract}
                                onConfirm={(path) => void decideField(path, "confirmar")}
                                onCorrect={(path, value) => void decideField(path, "corrigir", value)}
                                onLocate={(quote) => setHighlight((current) => ({ quote, key: (current?.key ?? 0) + 1 }))}
                            />
                        )}
                    </div>
                </section>
            </div>
        </div>
    );
}
