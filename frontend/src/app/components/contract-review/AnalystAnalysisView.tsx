"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Download, FileText, Info, Play } from "lucide-react";
import { AgentSuggestion } from "@/app/components/shared/AgentSuggestion";
import { EmptyState } from "@/app/components/ui/empty-state";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import { CitationPillUI } from "@/shared/ui/CitationPillUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { VerdictLabelUI, type Verdict } from "@/shared/ui/VerdictUI";
import { showToast } from "@/shared/ui/ToastUI";
import { notifyError } from "@/app/lib/userFacingError";
import { relativeTime } from "@/app/lib/contractReviewView";
import {
    decideAnalysisRedline,
    exportAnalysis,
    getLatestAnalysis,
    listAnalysisDecisions,
    startAnalystAnalysis,
    type AnalysisItem,
    type AnalysisLight,
    type AnalysisRedline,
    type AnalysisRedlineDecision,
    type AnalystAnalysis,
} from "@/app/lib/mikeApi";
import { Redline } from "./ReviewClauseCard";

const VERDICT: Record<AnalysisLight, Verdict> = { red: "diverge", yellow: "precisa_revisao", green: "alinhado" };
const DEPENDS_ON: Record<string, string> = {
    juridico_interno: "Jurídico interno",
    founder: "Founder",
    contraparte: "Contraparte",
    due_diligence: "Due diligence",
    outro: "Outro",
};
const POLL_MS = 4_000;

function Item({ item, onLocate }: { item: AnalysisItem; onLocate?: (quote: string) => void }) {
    return (
        <li className="space-y-1.5 rounded-lg border border-gray-100 p-3">
            <div className="flex flex-wrap items-center gap-1.5">
                <VerdictLabelUI verdict={VERDICT[item.light]} />
                <span className="text-sm font-medium text-gray-900">
                    {item.clause ? `${item.clause} · ` : ""}
                    {item.title}
                </span>
                {onLocate && (
                    <CitationPillUI aria-label="Ver o trecho no documento" title="Ver o trecho no documento" onClick={() => onLocate(item.quote)}>
                        1
                    </CitationPillUI>
                )}
            </div>
            <blockquote className="border-l-2 border-gray-200 pl-2 font-serif text-sm text-gray-700 [overflow-wrap:anywhere]">
                “{item.quote}”
            </blockquote>
            {item.rationale && <p className="text-sm leading-relaxed text-gray-700">{item.rationale}</p>}
            {item.suggestion && (
                <p className="text-sm text-gray-700">
                    <span className="font-medium">Ajuste sugerido:</span> {item.suggestion}
                </p>
            )}
        </li>
    );
}

function Section({ title, items, empty, onLocate }: { title: string; items: AnalysisItem[]; empty: string; onLocate?: (quote: string) => void }) {
    return (
        <section aria-label={title} className="space-y-2">
            <h3 className="text-sm font-semibold text-gray-900">
                {title} <span className="font-normal text-gray-500">({items.length})</span>
            </h3>
            {items.length ? (
                <ul className="space-y-2">
                    {items.map((item) => (
                        <Item key={item.id} item={item} onLocate={onLocate} />
                    ))}
                </ul>
            ) : (
                <p className="text-sm text-gray-500">{empty}</p>
            )}
        </section>
    );
}

/**
 * The analyst's analysis of a contract, for the legal team: summary, critical
 * risks, points of attention, favourable points (each quoting the contract,
 * with a citation that scrolls the document to it when `onLocate` is given),
 * redline suggestions to accept, edit or reject, compliance and open points.
 * Without `analysis` it loads the contract's latest and follows it while it
 * runs. Used on the contract page and inside a legal request.
 */
const PARTIAL_LABELS: Record<string, string> = {
    executive_summary: "resumo executivo",
    critical: "riscos críticos",
    attention: "pontos de atenção",
    favorable: "pontos favoráveis",
    redlines: "redlines",
    compliance: "compliance",
    open_points: "pontos abertos",
};

export function AnalystAnalysisView({
    projectId,
    analysis: given,
    canDecide = false,
    onChanged,
    onLocate,
}: {
    projectId: string;
    analysis?: AnalystAnalysis | null;
    canDecide?: boolean;
    onChanged?: () => void;
    onLocate?: (quote: string) => void;
}) {
    const [loaded, setLoaded] = useState<AnalystAnalysis | null | undefined>(given === undefined ? undefined : given);
    const [decisions, setDecisions] = useState<Map<string, AnalysisRedlineDecision>>(new Map());
    const [busy, setBusy] = useState<string | null>(null);
    const [starting, setStarting] = useState(false);
    const analysis = given !== undefined ? given : loaded;

    const load = useCallback(async () => {
        try {
            setLoaded(await getLatestAnalysis(projectId));
        } catch (error) {
            notifyError(error, { lang: "pt", action: "carregar a análise", dedupeKey: "analysis-load" });
            setLoaded(null);
        }
    }, [projectId]);

    useEffect(() => {
        if (given === undefined) void load();
    }, [given, load]);

    // Follow a queued or running analysis until it settles.
    const pending = analysis?.status === "queued" || analysis?.status === "running";
    useEffect(() => {
        if (given !== undefined || !pending) return;
        const timer = setInterval(() => void load(), POLL_MS);
        return () => clearInterval(timer);
    }, [given, pending, load]);

    const analysisId = analysis?.status === "done" ? analysis.id : null;
    useEffect(() => {
        if (!analysisId) return;
        let live = true;
        listAnalysisDecisions(projectId, analysisId)
            .then((rows) => live && setDecisions(new Map(rows.map((row) => [row.redline_id, row]))))
            .catch((error) => notifyError(error, { lang: "pt", action: "carregar as decisões", dedupeKey: "analysis-decisions" }));
        return () => {
            live = false;
        };
    }, [projectId, analysisId]);

    async function start() {
        setStarting(true);
        try {
            await startAnalystAnalysis(projectId);
            await load();
            onChanged?.();
        } catch (error) {
            notifyError(error, { lang: "pt", action: "pedir a análise", onRetry: start });
        } finally {
            setStarting(false);
        }
    }

    async function decide(redline: AnalysisRedline, input: Parameters<typeof decideAnalysisRedline>[3]) {
        if (!analysisId) return;
        setBusy(redline.id);
        try {
            const decided = await decideAnalysisRedline(projectId, analysisId, redline.id, input);
            setDecisions((current) => new Map(current).set(redline.id, decided));
            if (input.decision !== "rejeitado") onChanged?.();
        } catch (error) {
            const code = (error as { code?: unknown } | null)?.code;
            // The server's own sentence says what happened; the button is the way out.
            if (code === "analysis_text_changed") {
                notifyError(error, { lang: "pt", action: "decidir a sugestão", actions: [{ label: "Pedir nova análise", onClick: () => void start() }] });
            } else if (code === "analysis_text_ambiguous" && onLocate) {
                notifyError(error, { lang: "pt", action: "decidir a sugestão", actions: [{ label: "Ver na revisão", onClick: () => onLocate(redline.from) }] });
            } else {
                notifyError(error, {
                    lang: "pt",
                    action: "decidir a sugestão",
                    ...(code === "document_busy" ? { onRetry: () => decide(redline, input) } : {}),
                });
            }
        } finally {
            setBusy(null);
        }
    }

    async function download(format: "md" | "docx") {
        if (!analysisId) return;
        try {
            const { blob, filename } = await exportAnalysis(projectId, analysisId, format);
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = filename ?? `analise.${format}`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1_000);
        } catch (error) {
            notifyError(error, { lang: "pt", action: "exportar a análise", onRetry: () => download(format) });
        }
    }

    async function copyMarkdown() {
        if (!analysisId) return;
        try {
            const { blob } = await exportAnalysis(projectId, analysisId, "md");
            await navigator.clipboard.writeText(await blob.text());
            showToast({ tone: "success", message: "Análise copiada. Cole no chat do time." });
        } catch (error) {
            notifyError(error, { lang: "pt", action: "copiar a análise" });
        }
    }

    if (analysis === undefined)
        return (
            <div aria-hidden="true" className="space-y-3">
                {["w-3/4", "w-full", "w-5/6"].map((width) => (
                    <SkeletonLine key={width} className={width} />
                ))}
            </div>
        );

    if (!analysis || analysis.status === "failed")
        return (
            <EmptyState
                icon={<FileText className="text-gray-300" />}
                title={analysis ? "A análise falhou" : "Sem análise do analista"}
                description={
                    analysis?.error ??
                    "A análise lê o contrato como um analista jurídico: resumo, riscos críticos, pontos de atenção, redlines e pontos abertos, citando o contrato."
                }
                action={
                    canDecide ? (
                        <PillButtonUI tone="black" loading={starting} onClick={start}>
                            <Play aria-hidden="true" className="h-3.5 w-3.5" />
                            {analysis ? "Tentar de novo" : "Pedir a análise"}
                        </PillButtonUI>
                    ) : undefined
                }
            />
        );

    if (pending || !analysis.result)
        return (
            <div role="status" className="space-y-3">
                <p className="text-sm text-gray-600">O agente analista está lendo o contrato. Isso leva cerca de dois minutos.</p>
                {["w-3/4", "w-full", "w-5/6"].map((width) => (
                    <SkeletonLine key={width} className={width} />
                ))}
            </div>
        );

    const result = analysis.result;
    const summary = result.executive_summary;
    const compliance: [string, string][] = [
        ["Proteção de dados (LGPD)", result.compliance.data_protection],
        ["Confidencialidade", result.compliance.confidentiality],
        ["Lei aplicável e foro", result.compliance.governing_law_forum],
        ["Prazo, rescisão e penalidades", result.compliance.term_termination_penalties],
    ];
    const cost = analysis.usage?.estimated_cost_usd;

    return (
        <div className="space-y-5">
            <p role="note" className="flex gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {result.notice}
            </p>

            {result.partial && (
                <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
                    Análise parcial: {result.partial.missing.length} {result.partial.missing.length === 1 ? "seção não veio" : "seções não vieram"} (
                    {result.partial.missing.map((key) => PARTIAL_LABELS[key] ?? key).join(", ")}). Peça a análise de novo ou complete essas partes à mão.
                </p>
            )}

            <section aria-label="Resumo executivo" className="space-y-1.5">
                <h3 className="text-sm font-semibold text-gray-900">Resumo executivo</h3>
                <p className="text-sm leading-relaxed text-gray-700">{summary.text}</p>
                {(summary.parties.length > 0 || summary.value) && (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-gray-600">
                        {summary.parties.length > 0 && (
                            <>
                                <dt className="font-medium">Partes</dt>
                                <dd>{summary.parties.join(" · ")}</dd>
                            </>
                        )}
                        {summary.value && (
                            <>
                                <dt className="font-medium">Valor</dt>
                                <dd>{summary.value}</dd>
                            </>
                        )}
                    </dl>
                )}
            </section>

            <Section title="Riscos críticos" items={result.critical} empty="Nenhum risco crítico." onLocate={onLocate} />
            <Section title="Pontos de atenção" items={result.attention} empty="Nenhum ponto de atenção." onLocate={onLocate} />
            <Section title="Pontos favoráveis" items={result.favorable} empty="Nenhum ponto favorável destacado." onLocate={onLocate} />

            <section aria-label="Sugestões de redline" className="space-y-2">
                <h3 className="text-sm font-semibold text-gray-900">
                    Sugestões de redline <span className="font-normal text-gray-500">({result.redlines.length})</span>
                </h3>
                {result.redlines.length === 0 && <p className="text-sm text-gray-500">Nenhuma sugestão de redline.</p>}
                {result.redlines.map((redline) => {
                    const decided = decisions.get(redline.id);
                    return (
                        <AgentSuggestion
                            key={redline.id}
                            id={`redline-${redline.id}`}
                            agent="Agente analista"
                            meta={relativeTime(analysis.finished_at ?? analysis.created_at)}
                            title={
                                <span className="inline-flex flex-wrap items-baseline gap-1.5">
                                    {redline.clause ?? "Redline"}
                                    {onLocate && (
                                        <CitationPillUI aria-label="Ver o trecho no documento" title="Ver o trecho no documento" onClick={() => onLocate(redline.from)}>
                                            1
                                        </CitationPillUI>
                                    )}
                                </span>
                            }
                            preview={<Redline before={redline.from} after={redline.to} />}
                            editableText={redline.to}
                            decision={decided ? { kind: decided.decision, by: decided.decided_by, at: decided.decided_at, reason: decided.reason } : null}
                            canDecide={canDecide && !decided}
                            busy={busy === redline.id}
                            onAccept={() => void decide(redline, { decision: "aceito" })}
                            onEdit={(text) => void decide(redline, { decision: "editado", edited_text: text })}
                            onReject={(reason) => void decide(redline, { decision: "rejeitado", reason })}
                        >
                            {redline.why && <p className="text-sm text-gray-700">{redline.why}</p>}
                        </AgentSuggestion>
                    );
                })}
            </section>

            <section aria-label="Conformidade" className="space-y-1.5">
                <h3 className="text-sm font-semibold text-gray-900">Conformidade</h3>
                <dl className="space-y-1.5 text-sm">
                    {compliance.map(([label, text]) => (
                        <div key={label}>
                            <dt className="font-medium text-gray-800">{label}</dt>
                            <dd className="text-gray-700">{text || "—"}</dd>
                        </div>
                    ))}
                </dl>
            </section>

            <section aria-label="Pontos abertos" className="space-y-1.5">
                <h3 className="text-sm font-semibold text-gray-900">Pontos abertos</h3>
                {result.open_points.length ? (
                    <ul className="space-y-1 text-sm text-gray-700">
                        {result.open_points.map((point) => (
                            <li key={point.id}>
                                {point.text} <span className="text-xs text-gray-500">· depende de: {DEPENDS_ON[point.depends_on] ?? point.depends_on}</span>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="text-sm text-gray-500">Nenhum ponto aberto.</p>
                )}
            </section>

            {analysis.dropped_citations.length > 0 && (
                <details className="text-xs text-gray-600">
                    <summary className="cursor-pointer">
                        {analysis.dropped_citations.length === 1
                            ? "1 item descartado: o trecho citado não está no contrato"
                            : `${analysis.dropped_citations.length} itens descartados: o trecho citado não está no contrato`}
                    </summary>
                    <ul className="mt-1.5 space-y-1">
                        {analysis.dropped_citations.map((dropped, index) => (
                            <li key={index}>
                                <span className="font-medium">{dropped.title}</span>: {dropped.reason}
                            </li>
                        ))}
                    </ul>
                </details>
            )}

            <footer className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
                <TextButtonUI size="sm" onClick={() => void copyMarkdown()}>
                    <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                    Copiar para o chat
                </TextButtonUI>
                <TextButtonUI size="sm" onClick={() => void download("docx")}>
                    <Download aria-hidden="true" className="h-3.5 w-3.5" />
                    Baixar .docx
                </TextButtonUI>
                <TextButtonUI size="sm" onClick={() => void download("md")}>
                    <Download aria-hidden="true" className="h-3.5 w-3.5" />
                    Baixar .md
                </TextButtonUI>
                <span className="ml-auto text-xs text-gray-500">
                    {analysis.model ?? ""}
                    {cost != null ? ` · custo estimado US$ ${cost.toFixed(2)}` : ""}
                </span>
            </footer>
        </div>
    );
}
