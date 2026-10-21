"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Diamond, Inbox, Plus } from "lucide-react";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { StatTiles } from "@/app/components/ui/stat-tiles";
import { StatusChip } from "@/app/components/ui/status-chip";
import { EmptyState } from "@/app/components/ui/empty-state";
import { UserAvatar } from "@/app/components/ui/user-avatar";
import { SearchBar } from "@/app/components/ui/search-bar";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import {
    TableBody,
    TableCell,
    TableEmptyState,
    TableHeaderCell,
    TableHeaderRow,
    TableRow,
    TableScrollArea,
    SkeletonLine,
} from "@/app/components/shared/TablePrimitive";
import { RequestForm } from "@/app/components/requests/RequestForm";
import { RequestPanel } from "@/app/components/requests/RequestPanel";
import { RequestSteps } from "@/app/components/requests/RequestSteps";
import { ExternalChip } from "@/app/components/requests/ExternalChip";
import { useAuth } from "@/app/contexts/AuthContext";
import { listRequests, type RequestList, type RequestListItem } from "@/app/lib/mikeApi";
import {
    CHANNEL_LABEL,
    filterQueue,
    formatDate,
    slaText,
    slaTone,
    sortQueue,
    requestChip,
    type QueueFilter,
    type QueueTab,
} from "@/app/lib/requests";
import { notifyError } from "@/app/lib/userFacingError";
import { cn } from "@/app/lib/utils";

const SLA_TONE_CLASS = { default: "text-gray-500", atencao: "text-amber-700", critico: "text-red-700" } as const;

/** Pedidos: the team's queue, or — for anyone else — "Meus pedidos". */
export default function PedidosPage() {
    const router = useRouter();
    const params = useSearchParams();
    const { user } = useAuth();
    const [data, setData] = useState<RequestList | null>(null);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);
    const [formOpen, setFormOpen] = useState(params.get("novo") === "1");
    const [tab, setTab] = useState<QueueTab>("abertos");
    const [filter, setFilter] = useState<QueueFilter | null>(null);
    const [query, setQuery] = useState("");
    const [cursor, setCursor] = useState(0);
    const openId = params.get("pedido");

    const [reloadKey, setReloadKey] = useState(0);
    const load = useCallback(() => setReloadKey((k) => k + 1), []);

    useEffect(() => {
        let cancelled = false;
        listRequests()
            .then((list) => {
                if (cancelled) return;
                setData(list);
                setFailed(false);
            })
            .catch((err) => {
                if (cancelled) return;
                setFailed(true);
                notifyError(err, {
                    lang: "pt",
                    action: "carregar os pedidos",
                    onRetry: () => setReloadKey((k) => k + 1),
                    dedupeKey: "requests-list",
                });
            })
            .finally(() => !cancelled && setLoading(false));
        return () => {
            cancelled = true;
        };
    }, [reloadKey]);

    const isTeam = data?.scope === "team";
    const rows = useMemo(() => {
        if (!data) return [];
        if (!isTeam) return sortQueue(data.items);
        return sortQueue(filterQueue(data.items, { tab, filter, userId: user?.id ?? null, query }));
    }, [data, isTeam, tab, filter, query, user?.id]);

    const openPanel = useCallback(
        (id: string | null) => {
            const next = new URLSearchParams(params.toString());
            if (id) next.set("pedido", id);
            else next.delete("pedido");
            next.delete("novo");
            router.replace(`/pedidos${next.size ? `?${next}` : ""}`, { scroll: false });
        },
        [params, router],
    );

    // j/k move, Enter opens, n starts a new request.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT"))
                return;
            if (event.metaKey || event.ctrlKey || event.altKey || formOpen || openId) return;
            if (event.key === "n") {
                event.preventDefault();
                setFormOpen(true);
            } else if (event.key === "j") setCursor((c) => Math.min(c + 1, Math.max(rows.length - 1, 0)));
            else if (event.key === "k") setCursor((c) => Math.max(c - 1, 0));
            else if (event.key === "Enter" && rows[cursor]) {
                if (isTeam) openPanel(rows[cursor].id);
                else router.push(`/pedidos/${rows[cursor].id}`);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [rows, cursor, formOpen, openId, isTeam, openPanel, router]);

    const newButton = (
        <PillButtonUI tone="black" onClick={() => setFormOpen(true)} aria-keyshortcuts="n">
            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            Pedir ao Legal
        </PillButtonUI>
    );

    const form = (
        <RequestForm
            open={formOpen}
            onClose={() => setFormOpen(false)}
            onCreated={(request) => {
                setFormOpen(false);
                load();
                if (isTeam) openPanel(request.id);
                else router.push(`/pedidos/${request.id}?criado=1`);
            }}
        />
    );

    if (!loading && data && !isTeam) {
        return (
            <div className="flex h-full flex-col">
                <PageHeader actions={[{ type: "custom", render: newButton }]}>Meus pedidos</PageHeader>
                <div className="mx-3 min-h-0 flex-1 overflow-y-auto pb-8 md:mx-6.5">
                    {data.items.length === 0 ? (
                        <div className="py-16">
                            <EmptyState
                                icon={<Inbox />}
                                title="Precisa do Legal?"
                                description="Conte em uma frase o que você precisa e anexe o contrato, se houver. Em 30 segundos o pedido chega ao time, com prazo e alguém responsável."
                                action={newButton}
                            />
                        </div>
                    ) : (
                        <ul className="divide-y divide-gray-100">
                            {rows.map((item, i) => (
                                <li key={item.id}>
                                    <button
                                        type="button"
                                        onClick={() => router.push(`/pedidos/${item.id}`)}
                                        className={cn(
                                            "flex w-full flex-col gap-1.5 rounded-lg px-2 py-3 text-left hover:bg-app-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40",
                                            i === cursor && "bg-app-surface-hover",
                                        )}
                                    >
                                        <span className="flex flex-wrap items-baseline gap-x-2">
                                            <span className="font-mono text-[11px] text-gray-500">{item.code}</span>
                                            <span className="break-words text-sm text-gray-900">{item.title}</span>
                                        </span>
                                        <RequestSteps step={stepOf(item)} cancelled={item.status === "cancelado"} />
                                        <span className="text-[11px] text-gray-500">
                                            {item.status === "aguardando_solicitante" ? (
                                                <span className="font-medium text-amber-700">O Legal fez uma pergunta · </span>
                                            ) : null}
                                            {item.assignee_name ? `${item.assignee_name} · ` : ""}
                                            {item.status === "entregue"
                                                ? "entregue"
                                                : item.status === "cancelado"
                                                  ? "cancelado"
                                                  : `prazo ${formatDate(item.due_at)}`}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                {form}
            </div>
        );
    }

    const counts = data?.counts;
    return (
        <div className="flex h-full flex-col">
            <PageHeader actions={[{ type: "custom", render: newButton }]}>Pedidos</PageHeader>
            <div className="mx-3 md:mx-6.5">
                <StatTiles
                    loading={loading}
                    selected={filter}
                    onSelect={(id) => {
                        setFilter(id as QueueFilter | null);
                        setCursor(0);
                        if (id) setTab(id === "concluidos_semana" ? "todos" : "abertos");
                    }}
                    tiles={[
                        { id: "sem_dono", value: counts?.sem_dono ?? 0, label: "Sem dono", tone: counts?.sem_dono ? "atencao" : "default" },
                        {
                            id: "sla_estourando",
                            value: counts?.sla_estourando ?? 0,
                            label: "Prazo estourando",
                            tone: counts?.sla_estourando ? "critico" : "default",
                        },
                        { id: "aguardando_solicitante", value: counts?.aguardando_solicitante ?? 0, label: "Aguardando solicitante" },
                        { id: "concluidos_semana", value: counts?.concluidos_semana ?? 0, label: "Entregues na semana" },
                    ]}
                />
                <div className="mt-4 flex flex-wrap items-center gap-2">
                    {(
                        [
                            ["abertos", "Abertos"],
                            ["meus", `Meus pedidos${counts ? ` (${counts.meus})` : ""}`],
                            ["todos", "Todos"],
                        ] as [QueueTab, string][]
                    ).map(([id, label]) => (
                        <TabPillButtonUI
                            key={id}
                            active={tab === id}
                            onClick={() => {
                                setTab(id);
                                setFilter(null);
                                setCursor(0);
                            }}
                        >
                            {label}
                        </TabPillButtonUI>
                    ))}
                    <div className="ml-auto w-full sm:w-64">
                        <SearchBar
                            size="sm"
                            value={query}
                            onValueChange={setQuery}
                            label="Buscar pedidos"
                            clearLabel="Limpar busca"
                            placeholder="Buscar LEG, contraparte, pessoa"
                        />
                    </div>
                </div>
            </div>

            <TableScrollArea
                className="mt-3"
                header={
                    <TableHeaderRow className="pl-3">
                        <TableHeaderCell className="w-24">ID</TableHeaderCell>
                        <TableHeaderCell className="w-72">Pedido</TableHeaderCell>
                        <TableHeaderCell className="w-44">Solicitante</TableHeaderCell>
                        {openId ? null : <TableHeaderCell className="w-24">Canal</TableHeaderCell>}
                        <TableHeaderCell className="w-36">Prazo</TableHeaderCell>
                        <TableHeaderCell className="w-44">Status</TableHeaderCell>
                        <TableHeaderCell className="w-48">Responsável</TableHeaderCell>
                    </TableHeaderRow>
                }
            >
                <TableBody>
                    {loading ? (
                        [0, 1, 2, 3, 4].map((i) => (
                            <TableRow key={i} interactive={false} className="h-11 pl-3">
                                {["w-16", "w-56", "w-32", "w-14", "w-24", "w-28", "w-32"].map((w, j) =>
                                    openId && j === CHANNEL_COLUMN ? null : (
                                        <TableCell key={j} className={cn(["w-24", "w-72", "w-44", "w-24", "w-36", "w-44", "w-48"][j])}>
                                            <SkeletonLine className={w} />
                                        </TableCell>
                                    ),
                                )}
                            </TableRow>
                        ))
                    ) : failed ? (
                        <TableEmptyState>
                            <EmptyState
                                tone="error"
                                title="Não consegui carregar os pedidos"
                                description="Pode ser a conexão. Tente de novo."
                                action={
                                    <PillButtonUI tone="white" onClick={load}>
                                        Tentar de novo
                                    </PillButtonUI>
                                }
                            />
                        </TableEmptyState>
                    ) : rows.length === 0 ? (
                        <TableEmptyState>
                            {data?.items.length ? (
                                <EmptyState
                                    icon={<Inbox />}
                                    title="Nada aqui"
                                    description={
                                        filter
                                            ? "Nenhum pedido neste filtro. Clique de novo no contador para limpar."
                                            : "Nenhum pedido nesta aba."
                                    }
                                    action={
                                        <PillButtonUI
                                            tone="white"
                                            onClick={() => {
                                                setFilter(null);
                                                setTab("todos");
                                                setQuery("");
                                            }}
                                        >
                                            Ver todos
                                        </PillButtonUI>
                                    }
                                />
                            ) : (
                                <EmptyState
                                    icon={<Inbox />}
                                    title="Nenhum pedido ainda"
                                    description="Quando alguém da empresa pedir algo ao Legal, aparece aqui com ID, prazo e a triagem do agente. Compartilhe o link de Pedidos com as áreas ou faça o primeiro pedido."
                                    action={newButton}
                                />
                            )}
                        </TableEmptyState>
                    ) : (
                        rows.map((item, i) => (
                            <QueueRow
                                key={item.id}
                                item={item}
                                focused={i === cursor}
                                selected={item.id === openId}
                                compact={!!openId}
                                onOpen={() => {
                                    setCursor(i);
                                    openPanel(item.id);
                                }}
                            />
                        ))
                    )}
                </TableBody>
            </TableScrollArea>

            {openId && data ? (
                <RequestPanel requestId={openId} team={data.team} onClose={() => openPanel(null)} onChanged={load} />
            ) : null}
            {form}
        </div>
    );
}

function RowChip({ item }: { item: RequestListItem }) {
    const chip = requestChip(item.status, { triaged: item.triaged, pending: item.triage_pending });
    return <StatusChip status={chip.status} label={chip.label} />;
}

function stepOf(item: RequestListItem) {
    if (item.status === "entregue" || item.status === "cancelado") return "concluido" as const;
    if (item.status === "novo" || item.status === "em_triagem") return "recebido" as const;
    return "em_analise" as const;
}

/** Canal is the column that gives way when the panel is open, so Prazo stays whole. */
const CHANNEL_COLUMN = 3;

function QueueRow({
    item,
    focused,
    selected,
    compact,
    onOpen,
}: {
    item: RequestListItem;
    focused: boolean;
    selected: boolean;
    /** The request panel is open beside the queue. */
    compact: boolean;
    onOpen: () => void;
}) {
    const tone = slaTone(item.sla);
    return (
        <TableRow
            selected={selected}
            onClick={onOpen}
            onKeyDown={(e) => e.key === "Enter" && onOpen()}
            role="button"
            tabIndex={0}
            aria-label={`${item.code} ${item.title}`}
            className={cn("h-11 pl-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40", focused && !selected && "bg-app-surface-hover")}
        >
            <TableCell className="w-24 font-mono text-[11px] text-gray-600">{item.code}</TableCell>
            <TableCell className="w-72 pr-3">
                <span className="block truncate text-gray-900">{item.title}</span>
                <span className="block truncate text-[11px] text-gray-500">
                    {item.kind_label}
                    {item.external ? (
                        <>
                            {" · "}
                            <ExternalChip />
                        </>
                    ) : null}
                </span>
            </TableCell>
            <TableCell className="w-44 pr-3">
                <span className="block truncate text-gray-700">{item.requester_name ?? item.requester_email}</span>
                {item.requester_area ? (
                    <span className="block truncate text-[11px] text-gray-500">{item.requester_area}</span>
                ) : null}
            </TableCell>
            {compact ? null : <TableCell className="w-24">{CHANNEL_LABEL[item.channel] ?? item.channel}</TableCell>}
            <TableCell className={cn("w-36", SLA_TONE_CLASS[tone], tone !== "default" && "font-medium")}>
                {slaText(item.sla, item.due_at)}
            </TableCell>
            <TableCell className="w-44">
                <RowChip item={item} />
            </TableCell>
            <TableCell className="w-48">
                {item.assignee_name ? (
                    <span className="inline-flex min-w-0 items-center gap-1.5 text-gray-700">
                        <UserAvatar size="sm" name={item.assignee_name} />
                        <span className="truncate">{item.assignee_name}</span>
                    </span>
                ) : item.suggested_assignee_name ? (
                    <span className="inline-flex min-w-0 items-center gap-1 text-violet-700" title="Sugerido pelo agente de atribuição">
                        <Diamond aria-hidden="true" className="h-2.5 w-2.5 fill-current" />
                        <span className="truncate">{item.suggested_assignee_name}</span>
                        <span className="text-[11px] text-gray-500">sugerido</span>
                    </span>
                ) : (
                    <span className="text-gray-400">sem dono</span>
                )}
            </TableCell>
        </TableRow>
    );
}
