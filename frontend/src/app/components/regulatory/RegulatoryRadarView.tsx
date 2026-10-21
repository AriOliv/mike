"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Diamond, Pause, Play, Plus, Radar, RefreshCw, Star } from "lucide-react";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { EmptyState } from "@/app/components/ui/empty-state";
import { StatTiles } from "@/app/components/ui/stat-tiles";
import { StatusChip } from "@/app/components/ui/status-chip";
import { DeadlineBadge } from "@/app/components/ui/deadline-badge";
import { showToast } from "@/app/components/ui/toast";
import {
    SkeletonLine,
    TableBody,
    TableCell,
    TableEmptyState,
    TableHeaderCell,
    TableHeaderRow,
    TableRow,
    TableScrollArea,
} from "@/app/components/shared/TablePrimitive";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import { VerdictLabelUI } from "@/shared/ui/VerdictUI";
import { useWorkspaceOrgId } from "@/app/contexts/WorkspaceContext";
import {
    createObligationFromRegulatoryChange,
    createRegulatoryScan,
    createRequestFromRegulatoryChange,
    getRegulatoryCatalog,
    listRegulatoryRuleSuggestions,
    suggestRuleFromRegulatoryChange,
    updatePipelineCard,
    listRegulatoryChanges,
    listRegulatoryScans,
    runRegulatoryScan,
    updateRegulatoryChange,
    updateRegulatoryScan,
    type RegulatoryCatalog,
    type RegulatoryChange,
    type RegulatoryChangeList,
    type RegulatoryScan,
    type RegulatoryTab,
} from "@/app/lib/mikeApi";
import {
    IMPACT_LABEL,
    TABS,
    affectedLabel,
    changeMeta,
    impactVerdict,
    relativeRun,
    plural,
} from "@/app/lib/regulatoryRadar";
import { describeError, notifyError } from "@/app/lib/userFacingError";
import { cn } from "@/app/lib/utils";
import { ChangePanel } from "./ChangePanel";

const COLUMNS = {
    change: "w-[22rem] min-w-[22rem] pl-3",
    impact: "w-36",
    affected: "w-44",
    effective: "w-24",
    status: "w-32",
};

const IMPACT_SHORT = { alto: "Alto", medio: "Médio", baixo: "Baixo" } as const;

/**
 * The screen's shortcuts stay out of the way while someone types or picks in
 * a field, and while an agent's suggestion card has the focus (its own a/e/r
 * win there).
 */
export function isTyping(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || typeof el.closest !== "function") return false;
    return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], article") || el.isContentEditable === true;
}

const PT = (action: string) => ({ lang: "pt" as const, action });

export function RegulatoryRadarView() {
    const router = useRouter();
    const params = useSearchParams();
    const orgId = useWorkspaceOrgId() ?? null;

    const [catalog, setCatalog] = useState<RegulatoryCatalog | null>(null);
    const [scans, setScans] = useState<RegulatoryScan[] | null>(null);
    const [list, setList] = useState<RegulatoryChangeList | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [scanId, setScanId] = useState<string | null>(null);
    const [tab, setTab] = useState<RegulatoryTab>("todas");
    const [query, setQuery] = useState("");
    const [busy, setBusy] = useState(false);
    const [creating, setCreating] = useState<string | null>(null);
    const [ruleChangeIds, setRuleChangeIds] = useState<Set<string>>(new Set());
    const selectedId = params.get("mudanca");
    const rowsRef = useRef<HTMLDivElement>(null);

    const load = useCallback(async () => {
        try {
            const [nextScans, nextList, nextRules] = await Promise.all([
                listRegulatoryScans(),
                listRegulatoryChanges({ scanId, tab, q: query.trim() || undefined }),
                listRegulatoryRuleSuggestions("pendente"),
            ]);
            setScans(nextScans);
            setList(nextList);
            setRuleChangeIds(new Set(nextRules.map((r) => r.change_id)));
            setError(null);
        } catch (e) {
            setError(describeError(e, PT("carregar o radar")).message);
        }
    }, [scanId, tab, query]);

    // The preset catalog never changes while the page is open: read it once.
    useEffect(() => {
        getRegulatoryCatalog()
            .then(setCatalog)
            .catch(() => setCatalog({ presets: [], sources: [], topics: [] }));
    }, []);

    useEffect(() => {
        const t = setTimeout(() => void load(), query ? 250 : 0);
        return () => clearTimeout(t);
    }, [load, query]);

    // A scan created or re-run fills in within seconds: keep looking while one
    // has never run.
    const pending = scans?.some((s) => s.enabled && !s.last_run_at);
    useEffect(() => {
        if (!pending) return;
        const t = setInterval(() => void load(), 4_000);
        return () => clearInterval(t);
    }, [pending, load]);

    const changes = list?.changes ?? [];
    const selected = changes.find((c) => c.id === selectedId) ?? null;
    const scanName = useCallback((id: string) => scans?.find((s) => s.id === id)?.name ?? null, [scans]);

    const open = useCallback(
        (change: RegulatoryChange | null) => {
            const next = new URLSearchParams(params.toString());
            if (change) next.set("mudanca", change.id);
            else next.delete("mudanca");
            router.replace(`?${next.toString()}`, { scroll: false });
            if (change && change.status === "nova") {
                // Opening a change reads it; no click to "mark as read".
                setList((cur) =>
                    cur
                        ? {
                              ...cur,
                              changes: cur.changes.map((c) => (c.id === change.id ? { ...c, status: "lida" } : c)),
                              tabs: { ...cur.tabs, nao_lidas: Math.max(0, cur.tabs.nao_lidas - 1) },
                          }
                        : cur,
                );
                void updateRegulatoryChange(change.id, { status: "lida" }).catch(() => undefined);
            }
        },
        [params, router],
    );

    const replace = (next: RegulatoryChange) =>
        setList((cur) => (cur ? { ...cur, changes: cur.changes.map((c) => (c.id === next.id ? next : c)) } : cur));

    async function star(change: RegulatoryChange) {
        replace({ ...change, starred: !change.starred });
        try {
            replace(await updateRegulatoryChange(change.id, { starred: !change.starred }));
        } catch (e) {
            replace(change);
            notifyError(e, PT("favoritar a mudança"));
        }
    }

    async function archive(change: RegulatoryChange, status: "arquivada" | "lida") {
        setBusy(true);
        try {
            await updateRegulatoryChange(change.id, { status });
            if (status === "arquivada") {
                open(null);
                showToast({
                    tone: "success",
                    message: "Mudança arquivada.",
                    durationMs: 10_000,
                    actions: [
                        {
                            label: "Desfazer",
                            onClick: async () => {
                                try {
                                    await updateRegulatoryChange(change.id, {
                                        status: change.status === "arquivada" ? "lida" : change.status,
                                    });
                                    await load();
                                } catch (e) {
                                    notifyError(e, PT("desfazer o arquivamento"));
                                }
                            },
                        },
                    ],
                });
            }
            await load();
        } catch (e) {
            notifyError(e, PT(status === "arquivada" ? "arquivar a mudança" : "restaurar a mudança"));
        } finally {
            setBusy(false);
        }
    }

    async function request(change: RegulatoryChange) {
        setBusy(true);
        try {
            const result = await createRequestFromRegulatoryChange(change.id);
            replace(result.change);
            showToast({
                tone: "success",
                message: "Pedido criado na Entrada da esteira.",
                durationMs: 10_000,
                actions: [
                    { label: "Abrir", onClick: () => router.push(`/projects/${result.project_id}`) },
                    {
                        // Takes the card off the pipeline; the project stays, so nothing is lost.
                        label: "Desfazer",
                        onClick: async () => {
                            try {
                                await updatePipelineCard(result.project_id, { lane: null });
                                showToast({ tone: "info", message: "Pedido tirado da esteira." });
                            } catch (e) {
                                notifyError(e, PT("desfazer o pedido"));
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            notifyError(e, PT("criar o pedido"));
        } finally {
            setBusy(false);
        }
    }

    async function obligation(change: RegulatoryChange, dueDate?: string) {
        setBusy(true);
        try {
            const result = await createObligationFromRegulatoryChange(change.id, dueDate ? { due_date: dueDate } : {});
            replace(result.change);
            showToast({
                tone: "success",
                message: "Vigência adicionada aos Prazos.",
                actions: [{ label: "Ver Prazos", onClick: () => router.push("/radar") }],
            });
        } catch (e) {
            notifyError(e, PT("criar a obrigação"));
        } finally {
            setBusy(false);
        }
    }

    async function suggestRule(change: RegulatoryChange, guidance?: string) {
        setBusy(true);
        try {
            await suggestRuleFromRegulatoryChange(change.id, guidance ? { guidance } : {});
            setRuleChangeIds((cur) => new Set(cur).add(change.id));
            showToast({ tone: "success", message: "Regra sugerida no playbook. A liderança do Legal aprova antes de valer." });
        } catch (e) {
            notifyError(e, PT("sugerir a regra"));
        } finally {
            setBusy(false);
        }
    }

    async function startPreset(key: string) {
        setCreating(key);
        try {
            const scan = await createRegulatoryScan({ preset: key, org_id: orgId });
            setScanId(null);
            showToast({ tone: "success", message: `Varredura “${scan.name}” criada. A primeira busca já começou.` });
            await load();
        } catch (e) {
            notifyError(e, PT("criar a varredura"));
        } finally {
            setCreating(null);
        }
    }

    async function toggleScan(scan: RegulatoryScan) {
        try {
            await updateRegulatoryScan(scan.id, { enabled: !scan.enabled });
            await load();
        } catch (e) {
            notifyError(e, PT(scan.enabled ? "pausar a varredura" : "retomar a varredura"));
        }
    }

    async function rerun(scan: RegulatoryScan) {
        try {
            await runRegulatoryScan(scan.id);
            showToast({ tone: "info", message: `Buscando agora em “${scan.name}”…` });
        } catch (e) {
            notifyError(e, PT("rodar a varredura"));
        }
    }

    // Keyboard triage: j/k move, Enter opens, s stars, e archives, c requests.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
            const index = changes.findIndex((c) => c.id === selectedId);
            if (event.key === "j" || event.key === "k") {
                if (changes.length === 0) return;
                const next = event.key === "j" ? Math.min(changes.length - 1, index + 1) : Math.max(0, index - 1);
                open(changes[next]);
                event.preventDefault();
                return;
            }
            if (!selected) return;
            if (event.key === "s") void star(selected);
            else if (event.key === "e" && selected.status !== "arquivada") void archive(selected, "arquivada");
            else if (event.key === "c" && !selected.request_project_id) void request(selected);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [changes, selectedId, selected, open]);

    const loading = scans === null && !error;
    const usedPresets = new Set((scans ?? []).map((s) => s.preset).filter(Boolean));
    const freshest = useMemo(() => {
        const withNew = (scans ?? []).filter((s) => s.counts.novas > 0);
        return withNew.sort((a, b) => b.counts.novas - a.counts.novas)[0] ?? null;
    }, [scans]);

    const presetPicker = (compact: boolean) => (
        <div className={cn("grid gap-2", compact ? "sm:grid-cols-2 lg:grid-cols-4" : "max-w-3xl sm:grid-cols-2")}>
            {(catalog?.presets ?? [])
                .filter((p) => !usedPresets.has(p.key))
                .map((p) => (
                    <button
                        key={p.key}
                        type="button"
                        disabled={creating !== null}
                        onClick={() => void startPreset(p.key)}
                        className="flex min-w-0 flex-col items-start gap-1 rounded-xl border border-gray-200 bg-app-surface p-3 text-left transition-colors hover:bg-app-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-60"
                    >
                        <span className="flex items-center gap-1.5 text-xs font-medium text-gray-900">
                            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                            {creating === p.key ? "Criando…" : p.name}
                        </span>
                        <span className="text-[11px] leading-snug text-gray-500">{p.description}</span>
                    </button>
                ))}
        </div>
    );

    const header = (
        <TableHeaderRow>
            <TableHeaderCell className={COLUMNS.change}>Mudança</TableHeaderCell>
            <TableHeaderCell className={COLUMNS.impact}>Impacto</TableHeaderCell>
            <TableHeaderCell className={COLUMNS.affected}>Contratos</TableHeaderCell>
            <TableHeaderCell className={COLUMNS.effective}>Vigência</TableHeaderCell>
            <TableHeaderCell className={COLUMNS.status}>Situação</TableHeaderCell>
        </TableHeaderRow>
    );

    const emptyTable = (
        <TableEmptyState>
            <EmptyState
                title={
                    tab === "arquivadas"
                        ? "Nada arquivado"
                        : tab === "favoritas"
                          ? "Nenhuma favorita"
                          : tab === "nao_lidas"
                            ? "Tudo lido"
                            : query
                              ? "Nada com esse termo"
                              : "Nenhuma mudança ainda"
                }
                description={
                    tab === "favoritas"
                        ? "Abra uma mudança e aperte s para guardá-la aqui."
                        : tab === "nao_lidas"
                          ? "As próximas mudanças aparecem aqui assim que a varredura encontrar."
                          : query
                            ? "Limpe a busca para ver todas."
                            : "A varredura busca a cada 6 horas. Rode agora se não quiser esperar."
                }
                action={
                    query || tab !== "todas" ? (
                        <PillButtonUI
                            tone="white"
                            onClick={() => {
                                setQuery("");
                                setTab("todas");
                            }}
                        >
                            Ver todas
                        </PillButtonUI>
                    ) : scans && scans.length > 0 ? (
                        <PillButtonUI tone="white" onClick={() => void Promise.all(scans.map((s) => rerun(s)))}>
                            <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
                            Buscar agora
                        </PillButtonUI>
                    ) : undefined
                }
            />
        </TableEmptyState>
    );

    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader>Radar regulatório</PageHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 md:px-8">
                {error ? (
                    <div className="py-16">
                        <EmptyState
                            tone="error"
                            title="Não consegui carregar o radar"
                            description={error}
                            action={
                                <PillButtonUI tone="white" onClick={() => void load()}>
                                    Tentar de novo
                                </PillButtonUI>
                            }
                        />
                    </div>
                ) : loading ? (
                    <div className="space-y-4 pt-2">
                        <div className="h-6 w-full max-w-96 animate-pulse rounded bg-gray-100" />
                        <StatTiles tiles={[0, 1, 2, 3].map((i) => ({ id: String(i), value: 0, label: "" }))} loading />
                    </div>
                ) : scans && scans.length === 0 ? (
                    <div className="py-10">
                        <EmptyState
                            icon={<Radar className="text-gray-400" />}
                            title="Escolha o que vigiar"
                            description="Eu leio o BCB, o Diário Oficial, a CVM e a Receita, separo o que mexe com pagamentos, cripto, câmbio e dados pessoais, e digo quais contratos nossos são afetados."
                            action={
                                catalog?.presets[0] ? (
                                    <PillButtonUI
                                        tone="black"
                                        disabled={creating !== null}
                                        onClick={() => void startPreset(catalog.presets[0].key)}
                                    >
                                        <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                                        Começar por {catalog.presets[0].name}
                                    </PillButtonUI>
                                ) : undefined
                            }
                        />
                        <div className="mt-6">{presetPicker(false)}</div>
                    </div>
                ) : (
                    <>
                        <section aria-label="Resumo" className="pt-2">
                            <p className="flex items-start gap-2 font-serif text-xl text-gray-900">
                                <Diamond aria-hidden="true" className="mt-1.5 h-3.5 w-3.5 shrink-0 fill-violet-600 text-violet-600" />
                                {freshest ? (
                                    <span>
                                        Sua varredura <strong className="font-semibold">{freshest.name}</strong> encontrou{" "}
                                        <strong className="font-semibold">
                                            {plural(freshest.counts.novas, "mudança", "mudanças")}
                                        </strong>
                                        .
                                    </span>
                                ) : (
                                    <span>Nenhuma mudança nova desde a sua última visita.</span>
                                )}
                            </p>
                        </section>

                        <StatTiles
                            className="mt-5"
                            selected={scanId}
                            onSelect={setScanId}
                            tiles={(scans ?? []).map((s) => ({
                                id: s.id,
                                value: s.counts.abertas,
                                label: s.name,
                                tone: s.counts.alto > 0 ? "critico" : s.counts.novas > 0 ? "atencao" : "default",
                                hint: s.last_error
                                    ? "fonte fora do ar"
                                    : !s.enabled
                                      ? "pausada"
                                      : `${s.counts.novas} não lidas · ${relativeRun(s.last_run_at)}`,
                            }))}
                        />
                        {scanId ? (
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                                {(() => {
                                    const s = scans?.find((x) => x.id === scanId);
                                    if (!s) return null;
                                    return (
                                        <>
                                            <span>Varredura “{s.name}”</span>
                                            <PillButtonUI tone="white" size="xs" onClick={() => void rerun(s)}>
                                                <RefreshCw aria-hidden="true" className="h-3 w-3" />
                                                Buscar agora
                                            </PillButtonUI>
                                            <PillButtonUI tone="white" size="xs" onClick={() => void toggleScan(s)}>
                                                {s.enabled ? (
                                                    <Pause aria-hidden="true" className="h-3 w-3" />
                                                ) : (
                                                    <Play aria-hidden="true" className="h-3 w-3" />
                                                )}
                                                {s.enabled ? "Pausar" : "Retomar"}
                                            </PillButtonUI>
                                            {s.last_error ? <span className="text-red-700">{s.last_error}</span> : null}
                                        </>
                                    );
                                })()}
                            </div>
                        ) : null}

                        <section aria-label="Mudanças" className="mt-6">
                            <div className="mb-2 flex flex-wrap items-center gap-2">
                                {TABS.map((t) => (
                                    <TabPillButtonUI key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>
                                        {t.label} ({list?.tabs[t.id] ?? 0})
                                    </TabPillButtonUI>
                                ))}
                                <input
                                    type="search"
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    placeholder="Buscar ato, órgão ou termo"
                                    aria-label="Buscar mudanças"
                                    className="ml-auto h-7 w-full min-w-0 rounded-full border border-gray-200 bg-app-surface px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 sm:w-72"
                                />
                            </div>
                            <div ref={rowsRef} className="flex h-[min(32rem,62vh)] min-h-64 flex-col">
                                <TableScrollArea header={header} className="mx-0 mb-0 md:mx-0 md:mb-0">
                                    <TableBody role="list" aria-label="Mudanças regulatórias" aria-busy={list === null || undefined}>
                                        {list === null
                                            ? [0, 1, 2].map((i) => (
                                                  <div key={i} className="flex h-12 items-center pr-3">
                                                      <div className={COLUMNS.change}>
                                                          <SkeletonLine className="w-56" />
                                                      </div>
                                                      <div className={COLUMNS.impact}>
                                                          <SkeletonLine className="w-20" />
                                                      </div>
                                                  </div>
                                              ))
                                            : changes.length === 0
                                              ? emptyTable
                                              : changes.map((change) => {
                                                    const isSel = change.id === selectedId;
                                                    const total = change.affected.length + change.affected_hidden;
                                                    return (
                                                        <TableRow
                                                            key={change.id}
                                                            role="listitem"
                                                            selected={isSel}
                                                            tabIndex={0}
                                                            aria-current={isSel || undefined}
                                                            data-change={change.id}
                                                            onClick={() => open(change)}
                                                            onKeyDown={(e) => {
                                                                if (e.key === "Enter") open(change);
                                                            }}
                                                            className="h-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40"
                                                        >
                                                            <div className={cn("flex min-w-0 items-center gap-2", COLUMNS.change)}>
                                                                {change.status === "nova" ? (
                                                                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-600">
                                                                        <span className="sr-only">Não lida.</span>
                                                                    </span>
                                                                ) : (
                                                                    <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0" />
                                                                )}
                                                                <div className="min-w-0">
                                                                    <p className={cn("truncate text-xs text-gray-900", change.status === "nova" && "font-medium")}>
                                                                        {change.starred ? (
                                                                            <>
                                                                                <Star aria-hidden="true" className="mr-1 inline h-3 w-3 fill-amber-400 text-amber-500" />
                                                                                <span className="sr-only">Favorita. </span>
                                                                            </>
                                                                        ) : null}
                                                                        {change.title}
                                                                    </p>
                                                                    <p className="truncate text-[11px] text-gray-500">{changeMeta(change)}</p>
                                                                </div>
                                                            </div>
                                                            <TableCell className={COLUMNS.impact}>
                                                                <VerdictLabelUI
                                                                    verdict={impactVerdict(change.impact)}
                                                                    label={IMPACT_SHORT[change.impact]}
                                                                />
                                                                <span className="sr-only">{IMPACT_LABEL[change.impact]}</span>
                                                            </TableCell>
                                                            <TableCell className={COLUMNS.affected}>
                                                                {total > 0 ? (
                                                                    <span className="text-gray-700">{affectedLabel(change.affected.length, change.affected_hidden)}</span>
                                                                ) : (
                                                                    <span className="text-gray-300">—</span>
                                                                )}
                                                            </TableCell>
                                                            <TableCell className={COLUMNS.effective}>
                                                                {change.effective_date ? (
                                                                    <DeadlineBadge date={change.effective_date} kind="vigencia" />
                                                                ) : (
                                                                    <span className="text-gray-300">—</span>
                                                                )}
                                                            </TableCell>
                                                            <TableCell className={COLUMNS.status}>
                                                                {change.request_project_id ? (
                                                                    <StatusChip status="em_andamento" label="Virou pedido" />
                                                                ) : change.obligation_id ? (
                                                                    <StatusChip status="a_fazer" label="Nos Prazos" />
                                                                ) : change.status === "arquivada" ? (
                                                                    <StatusChip status="concluido" label="Arquivada" />
                                                                ) : change.status === "nova" ? (
                                                                    <StatusChip status="pronto" label="Nova" />
                                                                ) : (
                                                                    <StatusChip status="a_fazer" label="Lida" />
                                                                )}
                                                            </TableCell>
                                                        </TableRow>
                                                    );
                                                })}
                                    </TableBody>
                                </TableScrollArea>
                            </div>
                            <p className="mt-2 text-[11px] text-gray-400">
                                Teclado: <kbd>j</kbd>/<kbd>k</kbd> navega · <kbd>Enter</kbd> abre · <kbd>s</kbd> favorita ·{" "}
                                <kbd>e</kbd> arquiva · <kbd>c</kbd> cria pedido · <kbd>Esc</kbd> fecha
                            </p>
                        </section>

                        {catalog && catalog.presets.some((p) => !usedPresets.has(p.key)) ? (
                            <section aria-label="Mais varreduras" className="mt-8">
                                <h2 className="mb-3 text-xs font-medium text-gray-500">Vigiar também</h2>
                                {presetPicker(true)}
                            </section>
                        ) : null}
                    </>
                )}
            </div>

            {selected ? (
                <ChangePanel
                    key={selected.id}
                    change={selected}
                    scanName={scanName(selected.scan_id)}
                    busy={busy}
                    ruleSuggested={ruleChangeIds.has(selected.id)}
                    onSuggestRule={(guidance) => void suggestRule(selected, guidance)}
                    onClose={() => open(null)}
                    onStar={() => void star(selected)}
                    onArchive={() => void archive(selected, "arquivada")}
                    onRestore={() => void archive(selected, "lida")}
                    onRequest={() => void request(selected)}
                    onObligation={(due) => void obligation(selected, due)}
                />
            ) : null}
        </div>
    );
}
