"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ExternalLink, Loader2 } from "lucide-react";
import {
    getIntegrationStatus,
    getPipeline,
    listProjects,
    updatePipelineCard,
    PIPELINE_LANES,
    type PipelineCard,
    type PipelineLane,
} from "@/app/lib/mikeApi";
import type { Project } from "@/app/components/shared/types";
import { PageHeader } from "@/app/components/shared/PageHeader";

// The team's own vocabulary — same words they use on the Notion board.
const LANE_LABELS: Record<PipelineLane, string> = {
    entrada: "Entrada",
    triagem: "Triagem",
    revisao: "Revisão",
    negociacao: "Negociação",
    assinatura: "Assinatura",
    arquivado: "Arquivado",
};

const RISK_STYLES: Record<string, string> = {
    critico: "bg-red-100 text-red-700",
    atencao: "bg-amber-100 text-amber-700",
    ok: "bg-emerald-100 text-emerald-700",
};

export default function PipelinePage() {
    const router = useRouter();
    const [cards, setCards] = useState<PipelineCard[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [dragging, setDragging] = useState<string | null>(null);
    const [overLane, setOverLane] = useState<PipelineLane | null>(null);
    const [adding, setAdding] = useState(false);
    const [candidates, setCandidates] = useState<Project[]>([]);
    const [notionBoardUrl, setNotionBoardUrl] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const data = await getPipeline();
            setCards(data.cards ?? []);
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to load the pipeline");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    useEffect(() => {
        void getIntegrationStatus()
            .then((s) => setNotionBoardUrl(s.notion?.board_url ?? null))
            .catch(() => setNotionBoardUrl(null));
    }, []);

    // Projects not on the board yet — the only way to add a contract to the
    // pipeline from the UI.
    async function openAddMenu() {
        setAdding(true);
        try {
            const all = await listProjects();
            const onBoard = new Set(cards.map((c) => c.id));
            setCandidates(all.filter((p) => !onBoard.has(p.id)));
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not load projects");
            setAdding(false);
        }
    }

    async function addToBoard(projectId: string) {
        setAdding(false);
        try {
            await updatePipelineCard(projectId, { lane: "entrada" });
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not add the contract");
        }
    }

    async function moveCard(cardId: string, lane: PipelineLane) {
        const previous = cards;
        // optimistic: the card jumps immediately, rolls back if the API fails
        setCards((cs) => cs.map((c) => (c.id === cardId ? { ...c, lane } : c)));
        try {
            await updatePipelineCard(cardId, { lane });
        } catch (e) {
            setCards(previous);
            setError(e instanceof Error ? e.message : "Could not move the card");
        }
    }

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center text-gray-400">
                <Loader2 className="h-5 w-5 animate-spin" />
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            <PageHeader>Pipeline</PageHeader>

            <div className="relative px-6 pb-3">
                <button
                    onClick={() => (adding ? setAdding(false) : void openAddMenu())}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 shadow-sm transition hover:border-gray-300"
                >
                    + Add contract
                </button>
                {notionBoardUrl && (
                    <a
                        href={notionBoardUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-2 inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 shadow-sm transition hover:border-gray-300"
                    >
                        Open board in Notion
                        <ExternalLink className="h-3 w-3" />
                    </a>
                )}
                {adding && (
                    <>
                        <div className="fixed inset-0 z-40" onClick={() => setAdding(false)} />
                        <div className="absolute left-6 z-50 mt-1 max-h-72 w-80 overflow-y-auto rounded-xl border border-gray-200 bg-white p-1 shadow-lg">
                            {candidates.length === 0 ? (
                                <div className="px-3 py-6 text-center text-xs text-gray-400">
                                    Every project is already on the board.
                                </div>
                            ) : (
                                candidates.map((p) => (
                                    <button
                                        key={p.id}
                                        onClick={() => void addToBoard(p.id)}
                                        className="block w-full truncate rounded-lg px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                                    >
                                        {p.name}
                                    </button>
                                ))
                            )}
                        </div>
                    </>
                )}
            </div>

            {error && (
                <div className="mx-6 mb-3 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {error}
                </div>
            )}

            <div className="flex flex-1 gap-4 overflow-x-auto px-6 pb-6">
                {PIPELINE_LANES.map((lane) => {
                    const laneCards = cards.filter((c) => c.lane === lane);
                    return (
                        <div
                            key={lane}
                            onDragOver={(e) => {
                                e.preventDefault();
                                setOverLane(lane);
                            }}
                            onDragLeave={() => setOverLane((l) => (l === lane ? null : l))}
                            onDrop={(e) => {
                                e.preventDefault();
                                setOverLane(null);
                                const id = dragging ?? e.dataTransfer.getData("text/plain");
                                setDragging(null);
                                if (id) void moveCard(id, lane);
                            }}
                            className={`flex w-72 shrink-0 flex-col rounded-xl border p-3 transition-colors ${
                                overLane === lane
                                    ? "border-gray-400 bg-gray-50"
                                    : "border-gray-200 bg-white/60"
                            }`}
                        >
                            <div className="mb-3 flex items-center justify-between">
                                <span className="text-[11px] font-medium uppercase tracking-wider text-gray-500">
                                    {LANE_LABELS[lane]}
                                </span>
                                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500">
                                    {laneCards.length}
                                </span>
                            </div>

                            <div className="flex flex-1 flex-col gap-2">
                                {laneCards.map((card) => (
                                    <div
                                        key={card.id}
                                        role="button"
                                        tabIndex={0}
                                        draggable
                                        onDragStart={(e) => {
                                            setDragging(card.id);
                                            e.dataTransfer.setData("text/plain", card.id);
                                            e.dataTransfer.effectAllowed = "move";
                                        }}
                                        onDragEnd={() => setDragging(null)}
                                        onClick={() => router.push(`/projects/${card.id}`)}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter" || e.key === " ") {
                                                e.preventDefault();
                                                router.push(`/projects/${card.id}`);
                                            }
                                        }}
                                        className={`cursor-pointer rounded-lg border border-gray-200 bg-white p-3 text-left shadow-sm transition hover:border-gray-300 hover:shadow ${
                                            dragging === card.id ? "opacity-50" : ""
                                        }`}
                                    >
                                        <div className="line-clamp-2 text-sm font-medium text-gray-800">
                                            {card.name}
                                        </div>
                                        {card.counterparty && (
                                            <div className="mt-1 line-clamp-1 text-xs text-gray-500">
                                                {card.counterparty}
                                            </div>
                                        )}
                                        <div className="mt-2 flex items-center gap-2">
                                            {card.risk_level && (
                                                <span
                                                    className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${
                                                        RISK_STYLES[card.risk_level] ??
                                                        "bg-gray-100 text-gray-600"
                                                    }`}
                                                >
                                                    {card.risk_level}
                                                </span>
                                            )}
                                            {card.requester_name && (
                                                <span className="truncate text-[10px] text-gray-400">
                                                    {card.requester_name}
                                                </span>
                                            )}
                                        </div>

                                        {/* Keyboard/touch path for moving a card — dragging
                                            alone would leave the board unusable on a tablet
                                            and unreachable by keyboard. */}
                                        <select
                                            aria-label="Move to lane"
                                            value={card.lane}
                                            onClick={(e) => e.stopPropagation()}
                                            onChange={(e) => {
                                                e.stopPropagation();
                                                void moveCard(card.id, e.target.value as PipelineLane);
                                            }}
                                            className="mt-2 w-full cursor-pointer rounded border border-gray-200 bg-gray-50 px-1.5 py-1 text-[11px] text-gray-600"
                                        >
                                            {PIPELINE_LANES.map((l) => (
                                                <option key={l} value={l}>
                                                    {LANE_LABELS[l]}
                                                </option>
                                            ))}
                                        </select>

                                        {card.notion_url && (
                                            <a
                                                href={card.notion_url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                onClick={(e) => e.stopPropagation()}
                                                className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-700 hover:underline"
                                            >
                                                Notion
                                                <ExternalLink className="h-2.5 w-2.5" />
                                            </a>
                                        )}
                                    </div>
                                ))}

                                {laneCards.length === 0 && (
                                    <div className="rounded-lg border border-dashed border-gray-200 px-3 py-6 text-center text-xs text-gray-400">
                                        Drop a contract here
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
