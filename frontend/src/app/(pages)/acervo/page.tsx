"use client";

// "Perguntar": a question across the contract corpus. Scope is chosen before
// sending; the answer carries numbered citations whose quotes the server
// checked against the contract text, and list-like questions also get a
// per-contract table ("7 de 52 contratos").

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
    CircleAlert,
    CircleCheck,
    CircleDashed,
    ExternalLink,
    Grid3x3,
    Landmark,
    MessageCircleQuestion,
    Minus,
    Search,
} from "lucide-react";
import {
    askAcervo,
    getPipeline,
    type AcervoAnswer,
    type AcervoScope,
    type AcervoSource,
} from "@/app/lib/mikeApi";
import {
    coverageNotes,
    failureCopy,
    hitSummary,
    matchStatus,
    MATCH_STATUS_LABEL,
    readSummary,
    reviewHref,
    splitCitations,
    type MatchStatus,
} from "@/app/lib/perguntar";
import { describeError, notifyError } from "@/app/lib/userFacingError";
import { PageHeader } from "@/app/components/shared/PageHeader";
import {
    SkeletonLine,
    TableCell,
    TableHeaderCell,
    TableHeaderRow,
    TableRow,
} from "@/app/components/shared/TablePrimitive";
import { EmptyState } from "@/app/components/ui/empty-state";
import { TABLE_SURFACE_CLASS } from "@/app/components/ui/liquid-surface";
import { cn } from "@/app/lib/utils";
import { CitationPillUI } from "@/shared/ui/CitationPillUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import { TextSlabUI } from "@/shared/ui/TextSlabUI";

const EXAMPLES = [
    "Quais contratos têm cláusula de mudança de controle?",
    "Quais contratos têm renovação automática?",
    "Qual é o foro de eleição nos NDAs?",
    "Algum contrato limita a nossa responsabilidade?",
];

const NOT_FOUND = "Não encontrei na base.";

type ScopeMode = "todos" | "contraparte" | "tipo";

function scopeOf(mode: ScopeMode, counterparty: string, type: string): AcervoScope {
    if (mode === "contraparte" && counterparty.trim()) return { counterparty: counterparty.trim() };
    if (mode === "tipo" && type) return { contract_type: type };
    return "todos";
}

const STATUS_ICON: Record<MatchStatus, ReactNode> = {
    tem: <CircleCheck aria-hidden="true" className="h-3.5 w-3.5 text-emerald-600" />,
    nao_tem: <Minus aria-hidden="true" className="h-3.5 w-3.5 text-gray-400" />,
    indexando: <CircleDashed aria-hidden="true" className="h-3.5 w-3.5 text-amber-600" />,
    nao_buscado: <CircleDashed aria-hidden="true" className="h-3.5 w-3.5 text-gray-400" />,
};

export default function PerguntarPage() {
    const inputId = useId();
    const inputRef = useRef<HTMLInputElement>(null);
    const [question, setQuestion] = useState("");
    const [mode, setMode] = useState<ScopeMode>("todos");
    const [counterparty, setCounterparty] = useState("");
    const [contractType, setContractType] = useState("");
    const [types, setTypes] = useState<string[]>([]);
    const [includeLaw, setIncludeLaw] = useState(false);
    const [answer, setAnswer] = useState<AcervoAnswer | null>(null);
    const [asking, setAsking] = useState(false);
    const [failed, setFailed] = useState<string | null>(null);
    const [activeSource, setActiveSource] = useState<number | null>(null);

    // The contract types seen on the pipeline feed the "Este tipo" choice.
    // Not loading them only hides that option, so a failure stays quiet.
    useEffect(() => {
        let alive = true;
        getPipeline()
            .then((board) => {
                if (!alive) return;
                const seen = new Set<string>();
                for (const card of board.cards) if (card.contract_type) seen.add(card.contract_type);
                setTypes([...seen].sort((a, b) => a.localeCompare(b, "pt-BR")));
            })
            .catch(() => undefined);
        return () => {
            alive = false;
        };
    }, []);

    async function ask(text: string) {
        const q = text.trim();
        if (!q || asking) return;
        setAsking(true);
        setFailed(null);
        setAnswer(null);
        setActiveSource(null);
        try {
            setAnswer(
                await askAcervo(q, {
                    scope: scopeOf(mode, counterparty, contractType),
                    includeLaw: includeLaw || undefined,
                }),
            );
        } catch (error) {
            const described = describeError(error, { action: "responder à pergunta" });
            setFailed(failureCopy(described));
            notifyError(error, {
                action: "responder à pergunta",
                onRetry: described.retryable ? () => void ask(q) : undefined,
            });
        } finally {
            setAsking(false);
        }
    }

    const scopeReady = mode !== "contraparte" || counterparty.trim().length > 0;

    return (
        <div className="flex h-full flex-col">
            <PageHeader>Perguntar</PageHeader>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-10 md:px-6.5">
                <div className="max-w-3xl">
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            void ask(question);
                        }}
                    >
                        <label htmlFor={inputId} className="mb-2 block text-sm text-gray-500">
                            Pergunte sobre os contratos. Toda resposta cita o trecho de onde veio.
                        </label>
                        <div className="flex gap-2">
                            <div className="relative flex-1">
                                <Search
                                    aria-hidden="true"
                                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
                                />
                                <input
                                    id={inputId}
                                    ref={inputRef}
                                    value={question}
                                    onChange={(e) => setQuestion(e.target.value)}
                                    placeholder="Ex.: quais contratos exigem aviso prévio de 90 dias?"
                                    maxLength={2000}
                                    className="h-9 w-full rounded-xl border border-gray-200 bg-white pl-9 pr-3 text-sm text-gray-900 outline-none focus-visible:border-gray-400 focus-visible:ring-2 focus-visible:ring-blue-500/30"
                                />
                            </div>
                            <PillButtonUI
                                type="submit"
                                tone="black"
                                size="normal"
                                loading={asking}
                                disabled={!question.trim() || !scopeReady}
                            >
                                Perguntar
                            </PillButtonUI>
                        </div>

                        <fieldset className="mt-3 flex flex-wrap items-center gap-2">
                            <legend className="sr-only">Escopo da pergunta</legend>
                            <TabPillButtonUI active={mode === "todos"} onClick={() => setMode("todos")}>
                                Todo o acervo
                            </TabPillButtonUI>
                            <TabPillButtonUI
                                active={mode === "contraparte"}
                                onClick={() => setMode("contraparte")}
                            >
                                Esta contraparte
                            </TabPillButtonUI>
                            {types.length > 0 && (
                                <TabPillButtonUI
                                    active={mode === "tipo"}
                                    onClick={() => {
                                        setMode("tipo");
                                        if (!contractType) setContractType(types[0]);
                                    }}
                                >
                                    Este tipo
                                </TabPillButtonUI>
                            )}
                            {mode === "contraparte" && (
                                <input
                                    aria-label="Contraparte"
                                    value={counterparty}
                                    onChange={(e) => setCounterparty(e.target.value)}
                                    placeholder="Nome da contraparte"
                                    maxLength={200}
                                    className="h-7 w-48 rounded-full border border-gray-200 bg-white px-3 text-xs text-gray-900 outline-none focus-visible:border-gray-400 focus-visible:ring-2 focus-visible:ring-blue-500/30"
                                />
                            )}
                            {mode === "tipo" && (
                                <select
                                    aria-label="Tipo de contrato"
                                    value={contractType}
                                    onChange={(e) => setContractType(e.target.value)}
                                    className="h-7 rounded-full border border-gray-200 bg-white px-2.5 text-xs text-gray-700 outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
                                >
                                    {types.map((t) => (
                                        <option key={t} value={t}>
                                            {t}
                                        </option>
                                    ))}
                                </select>
                            )}
                            <span className="mx-1 hidden h-4 w-px bg-gray-200 sm:inline-block" aria-hidden="true" />
                            <TabPillButtonUI active={includeLaw} onClick={() => setIncludeLaw((v) => !v)}>
                                <Landmark aria-hidden="true" className="h-3.5 w-3.5" />
                                Incluir legislação
                            </TabPillButtonUI>
                        </fieldset>
                    </form>

                    {!answer && !asking && !failed && (
                        <EmptyState
                            className="mt-10"
                            icon={<MessageCircleQuestion className="text-gray-300" />}
                            title="Pergunte ao acervo inteiro de uma vez"
                            description="Eu busco o trecho em cada contrato, cito a cláusula e confiro que a citação está mesmo no texto."
                            action={
                                <div className="flex flex-col items-start gap-2">
                                    {EXAMPLES.map((example, i) => (
                                        <PillButtonUI
                                            key={example}
                                            tone={i === 0 ? "black" : "white"}
                                            size="sm"
                                            onClick={() => {
                                                setQuestion(example);
                                                void ask(example);
                                            }}
                                        >
                                            {example}
                                        </PillButtonUI>
                                    ))}
                                </div>
                            }
                        />
                    )}

                    {failed && !asking && (
                        <EmptyState
                            className="mt-10"
                            tone="error"
                            icon={<CircleAlert className="text-red-400" />}
                            title="Não consegui responder"
                            description={failed}
                            action={
                                <PillButtonUI tone="white" size="sm" onClick={() => void ask(question)}>
                                    Tentar de novo
                                </PillButtonUI>
                            }
                        />
                    )}

                    {asking && <AnswerSkeleton />}

                    {answer && (
                        <AnswerView
                            answer={answer}
                            activeSource={activeSource}
                            onCite={(n) => {
                                setActiveSource(n);
                                document
                                    .getElementById(`fonte-${n}`)
                                    ?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
                            }}
                            includeLaw={includeLaw}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}

function AnswerSkeleton() {
    return (
        <div className="mt-8" aria-busy="true" aria-label="Lendo os contratos">
            <p className="mb-3 text-xs text-gray-400">Lendo os contratos… Conferindo citações…</p>
            <SkeletonLine className="w-full" />
            <SkeletonLine className="mt-2 w-11/12" />
            <SkeletonLine className="mt-2 w-2/3" />
            <div className="mt-6 space-y-2">
                {[0, 1].map((i) => (
                    <TextSlabUI key={i} className="animate-pulse">
                        <div className="h-3 w-28 rounded bg-gray-200" />
                        <div className="mt-2.5 h-3 w-full rounded bg-gray-200" />
                        <div className="mt-2 h-3 w-3/4 rounded bg-gray-200" />
                    </TextSlabUI>
                ))}
            </div>
        </div>
    );
}

function AnswerView({
    answer,
    activeSource,
    onCite,
    includeLaw,
}: {
    answer: AcervoAnswer;
    activeSource: number | null;
    onCite: (n: number) => void;
    includeLaw: boolean;
}) {
    const sources = answer.sources;
    const lawSources = answer.law_sources;
    const known = useMemo(
        () => new Set([...sources.map((s) => s.n), ...lawSources.map((s) => s.n)]),
        [sources, lawSources],
    );
    const segments = answer.found ? splitCitations(answer.answer, known) : [];
    const notes = coverageNotes(answer);
    const showMatches = answer.aggregate && answer.matches.length > 0;

    return (
        <div className="mt-8">
            {answer.found && segments.length > 0 ? (
                <p className="font-serif text-base leading-7 text-gray-900">
                    {segments.map((segment, i) =>
                        segment.kind === "text" ? (
                            <span key={i}>{segment.text}</span>
                        ) : (
                            <CitationPillUI
                                key={i}
                                className="mx-0.5 align-[2px]"
                                active={activeSource === segment.n}
                                aria-label={`Ver fonte ${segment.n}`}
                                onClick={() => onCite(segment.n)}
                            >
                                {segment.n}
                            </CitationPillUI>
                        ),
                    )}
                </p>
            ) : (
                <p className="font-serif text-base leading-7 text-gray-900">{NOT_FOUND}</p>
            )}

            {notes.length > 0 && (
                <ul className="mt-3 space-y-1">
                    {notes.map((note) => (
                        <li key={note} className="flex items-start gap-1.5 text-xs text-amber-700">
                            <CircleDashed aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            {note}
                        </li>
                    ))}
                </ul>
            )}

            {includeLaw && !answer.law_available && (
                <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-500">
                    <Landmark aria-hidden="true" className="h-3.5 w-3.5" />
                    Legislação: em breve (sem fonte configurada)
                </p>
            )}

            {showMatches && <MatchesTable answer={answer} />}

            {(sources.length > 0 || lawSources.length > 0) && (
                <section className="mt-8" aria-labelledby="fontes-titulo">
                    <h2 id="fontes-titulo" className="mb-2 text-xs font-medium text-gray-500">
                        Fontes · {sources.length + lawSources.length}
                    </h2>
                    <ol className="space-y-2">
                        {sources.map((source) => (
                            <SourceItem key={`c${source.n}`} source={source} active={activeSource === source.n} />
                        ))}
                        {lawSources.map((law) => (
                            <li key={`l${law.n}`} id={`fonte-${law.n}`}>
                                <a
                                    href={law.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="block rounded-xl p-2 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                >
                                    <SourceHeader n={law.n} title={law.title} verified={law.verified}>
                                        <ExternalLink aria-hidden="true" className="h-3 w-3 text-gray-400" />
                                    </SourceHeader>
                                    <TextSlabUI selected={activeSource === law.n} className="mt-1.5">
                                        <p className="font-serif text-sm leading-6 text-gray-700">{law.quote}</p>
                                    </TextSlabUI>
                                </a>
                            </li>
                        ))}
                    </ol>
                </section>
            )}

            <p className="mt-6 text-xs text-gray-400">{readSummary(answer.searched)}</p>
        </div>
    );
}

function SourceHeader({
    n,
    title,
    detail,
    verified,
    children,
}: {
    n: number;
    title: string;
    detail?: string | null;
    verified: boolean;
    children?: ReactNode;
}) {
    return (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-serif text-xs text-gray-500">[{n}]</span>
            <span className="text-sm text-gray-900 [overflow-wrap:anywhere]">{title}</span>
            {detail && <span className="text-xs text-gray-500">{detail}</span>}
            {verified ? (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                    <CircleCheck aria-hidden="true" className="h-3 w-3" />
                    verificada
                </span>
            ) : (
                <span className="inline-flex items-center gap-1 text-xs text-amber-700">
                    <CircleAlert aria-hidden="true" className="h-3 w-3" />
                    não verificada
                </span>
            )}
            {children}
        </div>
    );
}

function SourceItem({ source, active }: { source: AcervoSource; active: boolean }) {
    const body = (
        <>
            <SourceHeader n={source.n} title={source.contract} detail={source.ref} verified={source.verified} />
            <TextSlabUI selected={active} className="mt-1.5">
                <p className="font-serif text-sm leading-6 text-gray-700">{source.quote}</p>
            </TextSlabUI>
        </>
    );
    return (
        <li id={`fonte-${source.n}`}>
            {source.project_id ? (
                <Link
                    href={reviewHref(source.project_id, source.verified ? source.quote : null)}
                    className="block rounded-xl p-2 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500/40"
                >
                    {body}
                </Link>
            ) : (
                <div className="p-2">{body}</div>
            )}
        </li>
    );
}

function MatchesTable({ answer }: { answer: AcervoAnswer }) {
    return (
        <section className="mt-8" aria-labelledby="contratos-titulo">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2 id="contratos-titulo" className="font-serif text-lg text-gray-900">
                    {hitSummary(answer)}
                </h2>
                <Link
                    href="/tabular-reviews"
                    className="inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs text-gray-700 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500/40"
                >
                    <Grid3x3 aria-hidden="true" className="h-3.5 w-3.5" />
                    Abrir como grade
                </Link>
            </div>
            <div className={cn("overflow-x-auto rounded-2xl", TABLE_SURFACE_CLASS)} role="table" aria-label="Contratos">
                <TableHeaderRow role="row" className="min-w-full pl-3">
                    <TableHeaderCell role="columnheader" className="w-56">
                        Contrato
                    </TableHeaderCell>
                    <TableHeaderCell role="columnheader" className="w-36">
                        Resultado
                    </TableHeaderCell>
                    <TableHeaderCell role="columnheader" className="w-72">
                        Trecho
                    </TableHeaderCell>
                </TableHeaderRow>
                {answer.matches.map((match) => {
                    const status = matchStatus(match);
                    return (
                        <TableRow key={match.project_id} role="row" interactive={false} className="min-w-full pl-3">
                            <TableCell role="cell" className="w-56 pr-3 text-gray-800">
                                <Link
                                    href={reviewHref(match.project_id, match.verified ? match.quote : null)}
                                    className="rounded outline-none hover:underline focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                >
                                    {match.contract}
                                </Link>
                                {match.counterparty && (
                                    <span className="ml-1 text-gray-400">· {match.counterparty}</span>
                                )}
                            </TableCell>
                            <TableCell role="cell" className="w-36">
                                <span className="inline-flex items-center gap-1.5">
                                    {STATUS_ICON[status]}
                                    {MATCH_STATUS_LABEL[status]}
                                </span>
                            </TableCell>
                            <TableCell role="cell" className="w-72 font-serif" title={match.quote ?? undefined}>
                                {match.quote ?? "—"}
                            </TableCell>
                        </TableRow>
                    );
                })}
            </div>
        </section>
    );
}
