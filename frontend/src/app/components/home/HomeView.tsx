"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronUp, Diamond, FolderInput, Upload } from "lucide-react";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { ActivityFeed } from "@/app/components/shared/ActivityFeed";
import { StatTiles } from "@/app/components/ui/stat-tiles";
import { EmptyState } from "@/app/components/ui/empty-state";
import { TableEmptyState } from "@/app/components/shared/TablePrimitive";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import { showToast } from "@/app/components/ui/toast";
import { useAuth } from "@/app/contexts/AuthContext";
import { useAssignLatest } from "@/app/hooks/useLatestRef";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { toActivityItems } from "@/app/lib/activityFeed";
import { brDate, filterReviews, greeting, isMine, noticeHint, type HomeFilter, type HomeTab } from "@/app/lib/home";
import {
    getHomeSummary,
    requestContractReview,
    updateContractReview,
    type HomeReview,
    type HomeSummary,
} from "@/app/lib/mikeApi";
import { describeError, notifyError } from "@/app/lib/userFacingError";
import { HomeReviewTable, NoticeBadge } from "./HomeReviewTable";
import { ReviewPanel } from "./ReviewPanel";
import { SendContractsModal } from "./SendContractsModal";

// While an agent is working, the screen refreshes itself.
const POLL_MS = 5_000;

export function HomeView() {
    const router = useRouter();
    const params = useSearchParams();
    const { user } = useAuth();
    const { workspaceId } = useWorkspace();
    const me = user?.email?.toLowerCase() ?? null;

    const [home, setHome] = useState<HomeSummary | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [tab, setTab] = useState<HomeTab>("todas");
    const [filter, setFilter] = useState<HomeFilter>(null);
    const [query, setQuery] = useState("");
    const [briefOpen, setBriefOpen] = useState(false);
    const [sending, setSending] = useState(false);
    const selectedId = params.get("doc");
    const tabChosen = useRef(false);

    const hasData = useRef(false);
    const load = useCallback(async () => {
        try {
            const next = await getHomeSummary(workspaceId);
            // Someone outside the legal team has no queue here: their home is their requests.
            if (next.audience === "requester") return void router.replace("/pedidos");
            hasData.current = true;
            setHome(next);
            setError(null);
            // Open on "Minhas revisões" when the person has some.
            if (!tabChosen.current && next.reviews.some((r) => isMine(r, me))) {
                tabChosen.current = true;
                setTab("minhas");
            }
        } catch (e) {
            // With the queue already on screen, a failed refresh keeps it and says so once.
            if (hasData.current)
                notifyError(e, { lang: "pt", action: "atualizar o Início", dedupeKey: "home-refresh" });
            else setError(describeError(e, { lang: "pt", action: "carregar o Início" }).message);
        }
    }, [me, router, workspaceId]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- the first read of an external store; load() sets state when the request settles
        void load();
    }, [load]);

    const working = !!home?.reviews.some((r) => r.status === "queued" || r.status === "running");
    useEffect(() => {
        if (!working) return;
        const timer = setInterval(() => void load(), POLL_MS);
        return () => clearInterval(timer);
    }, [working, load]);

    const rows = useMemo(
        () => (home ? filterReviews(home.reviews, { tab, filter, me, query }) : []),
        [home, tab, filter, me, query],
    );
    const selected = home?.reviews.find((r) => r.id === selectedId) ?? null;

    const open = useCallback(
        (review: HomeReview | null) => {
            const next = new URLSearchParams(params.toString());
            if (review) next.set("doc", review.id);
            else next.delete("doc");
            router.replace(`?${next.toString()}`.replace(/\?$/, "/"), { scroll: false });
        },
        [params, router],
    );

    // What the keyboard acts on, current as of the last committed render.
    const keys = useRef<{
        rows: HomeReview[];
        selectedId: string | null;
        sending: boolean;
        open: (review: HomeReview | null) => void;
        accept: (review: HomeReview) => void;
        retry: (review: HomeReview) => void;
    } | null>(null);

    // j/k move through the queue, a accepts, r reviews again; Enter opens and
    // Escape closes are the row's and the panel's. Never while typing or with
    // the send dialog open. One listener for the page's lifetime, reading the
    // latest state through `keys`, so a key pressed right after a render never
    // sees the render before it.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const state = keys.current;
            if (!state) return;
            const { rows, selectedId, sending, open } = state;
            const target = event.target as HTMLElement | null;
            if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
            if (event.metaKey || event.ctrlKey || event.altKey || sending) return;
            const current = rows.find((r) => r.id === selectedId) ?? null;
            if (event.key === "a" && current?.status === "ready") return state.accept(current);
            if (event.key === "r" && current && (current.status === "ready" || current.status === "done" || current.status === "failed"))
                return state.retry(current);
            if (event.key !== "j" && event.key !== "k") return;
            if (rows.length === 0) return;
            const index = rows.findIndex((r) => r.id === selectedId);
            const nextIndex =
                index === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, index + (event.key === "j" ? 1 : -1)));
            open(rows[nextIndex]);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const patchReview = useCallback((id: string, patch: Partial<HomeReview>) => {
        setHome((current) =>
            current
                ? { ...current, reviews: current.reviews.map((r) => (r.id === id ? { ...r, ...patch } : r)) }
                : current,
        );
    }, []);

    const accept = useCallback(
        async (review: HomeReview) => {
            patchReview(review.id, { status: "done" });
            try {
                await updateContractReview(review.id, { status: "done" });
                showToast({
                    tone: "success",
                    message: "Revisão aceita.",
                    durationMs: 10_000,
                    actions: [
                        {
                            label: "Desfazer",
                            onClick: async () => {
                                patchReview(review.id, { status: "ready" });
                                try {
                                    await updateContractReview(review.id, { status: "ready" });
                                } catch (e) {
                                    notifyError(e, { lang: "pt", action: "desfazer o aceite" });
                                }
                                void load();
                            },
                        },
                    ],
                });
                void load();
            } catch (e) {
                patchReview(review.id, { status: review.status });
                notifyError(e, { lang: "pt", action: "aceitar a revisão" });
            }
        },
        [load, patchReview],
    );

    /** Set the owner; true when the server took it. Rolls back on failure. */
    const writeAssignee = useCallback(
        async (id: string, email: string | null, previous: string | null) => {
            patchReview(id, { assignee_email: email });
            try {
                await updateContractReview(id, { assignee_email: email });
                void load();
                return true;
            } catch (e) {
                patchReview(id, { assignee_email: previous });
                notifyError(e, { lang: "pt", action: "atribuir a revisão" });
                return false;
            }
        },
        [load, patchReview],
    );

    const assign = useCallback(
        async (review: HomeReview, email: string | null) => {
            const previous = review.assignee_email;
            if (!(await writeAssignee(review.id, email, previous))) return;
            showToast({
                tone: "success",
                message: email ? `Atribuído a ${email.split("@")[0]}.` : "Responsável removido.",
                durationMs: 10_000,
                actions: [{ label: "Desfazer", onClick: () => void writeAssignee(review.id, previous, email) }],
            });
        },
        [writeAssignee],
    );

    const retry = useCallback(
        async (review: HomeReview) => {
            patchReview(review.id, { status: "queued", error: null });
            try {
                await requestContractReview(review.project_id);
                void load();
            } catch (e) {
                notifyError(e, { lang: "pt", action: "revisar de novo" });
                void load();
            }
        },
        [load, patchReview],
    );
    useAssignLatest(keys, { rows, selectedId, sending, open, accept, retry });

    const loading = home === null && error === null;
    const hello = home ? greeting(home) : null;
    const emptyAll = !!home && home.reviews.length === 0;

    const tiles = [
        { id: "prontos", value: home?.counters.ready ?? 0, label: "Prontos p/ revisar" },
        { id: "meus", value: home?.counters.mine ?? 0, label: "Atribuídos a você" },
        {
            id: "avisos",
            value: home?.counters.notices_30d ?? 0,
            label: "Avisos em 30 dias",
            tone: (home?.counters.notices_30d ?? 0) > 0 ? ("atencao" as const) : ("default" as const),
            hint: home ? noticeHint(home) : undefined,
        },
        { id: "pastas", value: home?.counters.folders ?? 0, label: "Pastas monitoradas" },
    ];

    const emptyTable = emptyAll ? (
        <TableEmptyState className="max-w-sm">
            <EmptyState
                icon={<FolderInput />}
                title="Nenhum contrato revisado ainda"
                description="Envie contratos ou monitore uma pasta e eu leio cada um assim que chegar: Ficha preenchida, desvios do playbook e prazos de aviso."
                action={
                    <PillButtonUI tone="black" onClick={() => setSending(true)}>
                        <Upload aria-hidden="true" className="h-3.5 w-3.5" />
                        Enviar contratos
                    </PillButtonUI>
                }
            />
        </TableEmptyState>
    ) : (
        <TableEmptyState>
            <EmptyState
                title={tab === "minhas" && !filter ? "Nada atribuído a você" : "Nada neste filtro"}
                description={
                    tab === "minhas" && !filter
                        ? "Veja todas as revisões e assuma uma."
                        : "Limpe o filtro para ver todas as revisões."
                }
                action={
                    <PillButtonUI
                        tone="white"
                        onClick={() => {
                            setFilter(null);
                            setQuery("");
                            setTab("todas");
                        }}
                    >
                        Ver todas
                    </PillButtonUI>
                }
            />
        </TableEmptyState>
    );

    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                // Only once the screen is known to be the team's: a requester is on their way to /pedidos.
                actions={
                    home
                        ? [
                              {
                                  icon: <Upload aria-hidden="true" className="h-3.5 w-3.5" />,
                                  label: "Enviar contratos",
                                  onClick: () => setSending(true),
                              },
                          ]
                        : []
                }
            >
                Início
            </PageHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 md:px-8">
                {error ? (
                    <div className="py-16">
                        <EmptyState
                            tone="error"
                            title="Não consegui carregar o Início"
                            description={error}
                            action={
                                <PillButtonUI tone="white" onClick={() => void load()}>
                                    Tentar de novo
                                </PillButtonUI>
                            }
                        />
                    </div>
                ) : (
                    <>
                        <section aria-label="Resumo" className="pt-2">
                            {loading ? (
                                <div className="h-6 w-80 animate-pulse rounded bg-gray-100" />
                            ) : hello ? (
                                <div>
                                    <button
                                        type="button"
                                        onClick={() => setBriefOpen((v) => !v)}
                                        aria-expanded={briefOpen}
                                        className="group flex items-start gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                    >
                                        <Diamond
                                            aria-hidden="true"
                                            className="mt-1 h-3.5 w-3.5 shrink-0 fill-violet-600 text-violet-600"
                                        />
                                        <span className="font-serif text-xl text-gray-900">
                                            {hello.lead}
                                            {hello.detail ? (
                                                <span className="text-gray-500"> {hello.detail}</span>
                                            ) : null}
                                        </span>
                                        {home && home.activity.length > 0 ? (
                                            briefOpen ? (
                                                <ChevronUp aria-hidden="true" className="mt-1.5 h-4 w-4 text-gray-400" />
                                            ) : (
                                                <ChevronDown aria-hidden="true" className="mt-1.5 h-4 w-4 text-gray-400" />
                                            )
                                        ) : null}
                                    </button>
                                    {briefOpen && home ? (
                                        <div className="mt-3 max-w-2xl pl-5">
                                            <ActivityFeed
                                                items={toActivityItems(home.activity)}
                                                limit={8}
                                                emptyText="Nada aconteceu ainda."
                                            />
                                        </div>
                                    ) : null}
                                </div>
                            ) : null}
                        </section>

                        <StatTiles
                            className="mt-5"
                            tiles={tiles}
                            loading={loading}
                            selected={filter}
                            onSelect={(id) => setFilter(id as HomeFilter)}
                        />

                        <section aria-label="Revisões" className="mt-6">
                            <div className="mb-2 flex flex-wrap items-center gap-2">
                                <TabPillButtonUI active={tab === "minhas"} onClick={() => setTab("minhas")}>
                                    Minhas revisões ({home?.reviews.filter((r) => isMine(r, me)).length ?? 0})
                                </TabPillButtonUI>
                                <TabPillButtonUI active={tab === "todas"} onClick={() => setTab("todas")}>
                                    Todas ({home?.reviews.length ?? 0})
                                </TabPillButtonUI>
                                <input
                                    type="search"
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    placeholder="Buscar contrato, contraparte ou pessoa"
                                    aria-label="Buscar revisões"
                                    className="ml-auto h-7 w-full min-w-0 rounded-full border border-gray-200 bg-app-surface px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 sm:w-72"
                                />
                            </div>
                            <div className="flex max-h-[min(30rem,65vh)] flex-col">
                                <HomeReviewTable
                                    onRetry={retry}
                                    reviews={rows}
                                    loading={loading}
                                    selectedId={selectedId}
                                    onOpen={open}
                                    empty={emptyTable}
                                />
                            </div>
                        </section>

                        <div className="mt-8 grid gap-8 lg:grid-cols-2">
                            <section aria-label="Prazos de aviso">
                                <h2 className="mb-3 text-xs font-medium text-gray-500">Prazos de aviso · próximos 90 dias</h2>
                                {loading ? (
                                    <div className="h-16 animate-pulse rounded-xl bg-gray-100" />
                                ) : home && home.deadlines.length > 0 ? (
                                    <ul className="divide-y divide-gray-100">
                                        {home.deadlines.slice(0, 6).map((d) => (
                                            <li key={d.project_id}>
                                                <button
                                                    type="button"
                                                    onClick={() => router.push(`/projects/${d.project_id}`)}
                                                    className="flex w-full items-center gap-3 py-2 text-left text-xs hover:bg-app-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                                >
                                                    <span className="w-16 shrink-0">
                                                        <NoticeBadge review={d} />
                                                    </span>
                                                    <span className="min-w-0 flex-1">
                                                        <span className="block truncate text-gray-900">{d.project_name}</span>
                                                        <span className="block truncate text-gray-500">
                                                            avisar até {brDate(d.notice_deadline)}
                                                            {d.auto_renewal ? " · renova sozinho" : ""}
                                                        </span>
                                                    </span>
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                ) : (
                                    <p className="text-xs text-gray-400">
                                        Nenhum aviso prévio nos próximos 90 dias. Os prazos aparecem aqui assim que eu
                                        ler a Ficha de cada contrato.
                                    </p>
                                )}
                            </section>
                            <section aria-label="Atividade">
                                <h2 className="mb-3 text-xs font-medium text-gray-500">Atividade · pessoas e agentes</h2>
                                <ActivityFeed
                                    loading={loading}
                                    items={toActivityItems(home?.activity ?? [])}
                                    limit={8}
                                    emptyText="Nada aconteceu ainda. Quando eu revisar um contrato ou alguém mover um card, aparece aqui."
                                />
                            </section>
                        </div>
                    </>
                )}
            </div>

            {selected ? (
                <ReviewPanel
                    key={selected.id}
                    review={selected}
                    me={me}
                    onClose={() => open(null)}
                    onAccept={accept}
                    onAssign={assign}
                    onRetry={retry}
                />
            ) : null}
            {sending ? (
                <SendContractsModal
                    onClose={() => setSending(false)}
                    onSent={() => {
                        setSending(false);
                        void load();
                    }}
                />
            ) : null}
        </div>
    );
}
