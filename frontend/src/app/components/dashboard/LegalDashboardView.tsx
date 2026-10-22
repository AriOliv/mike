"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BarChart3 } from "lucide-react";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { EmptyState } from "@/app/components/ui/empty-state";
import { StatTiles } from "@/app/components/ui/stat-tiles";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import { getLegalDashboard, type DashboardAssumptions, type LegalDashboard } from "@/app/lib/mikeApi";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import {
    PERIODS,
    agentLabel,
    agentTiles,
    clampMinutes,
    costTile,
    money,
    headlineTiles,
    personLabel,
    stageRows,
    stuckRows,
} from "@/app/lib/legalDashboard";
import { describeError } from "@/app/lib/userFacingError";
import { cn } from "@/app/lib/utils";
import { HorizontalBars, VIZ_STYLE, WeeklyColumns } from "./charts";

const ASSUMPTION_FIELDS: { key: keyof DashboardAssumptions; label: string }[] = [
    { key: "minutes_per_review", label: "min por revisão de contrato" },
    { key: "minutes_per_terms", label: "min por extração de prazos" },
    { key: "minutes_per_regulatory_triage", label: "min por mudança regulatória" },
];

export function LegalDashboardView() {
    const router = useRouter();
    // The Início's cut: the active workspace, so "Revisei N" and the reviewed tile agree.
    const { workspaceId } = useWorkspace();
    const [period, setPeriod] = useState<30 | 90 | 365>(90);
    const [assumptions, setAssumptions] = useState<DashboardAssumptions | null>(null);
    const [data, setData] = useState<LegalDashboard | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [refetching, setRefetching] = useState(false);

    const load = useCallback(async () => {
        setRefetching(true);
        try {
            const next = await getLegalDashboard({ period, assumptions: assumptions ?? undefined, workspace: workspaceId });
            setData(next);
            setError(null);
        } catch (e) {
            setError(describeError(e, { lang: "pt", action: "carregar o painel" }).message);
        } finally {
            setRefetching(false);
        }
    }, [period, assumptions, workspaceId]);

    useEffect(() => {
        void load();
    }, [load]);

    const a = data?.hours_saved.assumptions;
    const empty = data && data.volume.opened === 0 && data.volume.open === 0 && data.volume.closed === 0;

    return (
        <div className="flex h-full min-h-0 flex-col">
            <style>{VIZ_STYLE}</style>
            <PageHeader>Painel do Legal</PageHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 md:px-8">
                {/* One filter row, above everything it scopes. */}
                <div className="flex flex-wrap items-center gap-2 pt-2" role="group" aria-label="Período">
                    {PERIODS.map((p) => (
                        <TabPillButtonUI key={p.days} active={period === p.days} onClick={() => setPeriod(p.days)}>
                            Últimos {p.label}
                        </TabPillButtonUI>
                    ))}
                </div>

                {error ? (
                    <div className="py-16">
                        <EmptyState
                            tone="error"
                            title="Não consegui carregar o painel"
                            description={error}
                            action={
                                <PillButtonUI tone="white" onClick={() => void load()}>
                                    Tentar de novo
                                </PillButtonUI>
                            }
                        />
                    </div>
                ) : !data ? (
                    <div className="mt-5 space-y-4">
                        <StatTiles loading tiles={[0, 1, 2, 3].map((i) => ({ id: String(i), value: 0, label: "" }))} />
                        <StatTiles loading tiles={[0, 1, 2, 3].map((i) => ({ id: String(i), value: 0, label: "" }))} />
                        <div className="h-56 animate-pulse rounded-xl bg-gray-100" />
                    </div>
                ) : empty ? (
                    <div className="py-12">
                        <EmptyState
                            icon={<BarChart3 className="text-gray-400" />}
                            title="Ainda não há pedidos na esteira"
                            description="O painel mede o trabalho do Legal: pedidos que entram, quanto tempo levam, prazos cumpridos e o que os agentes fizeram. Coloque o primeiro contrato na esteira e os números aparecem aqui."
                            action={
                                <PillButtonUI tone="black" onClick={() => router.push("/pipeline")}>
                                    Abrir a esteira
                                </PillButtonUI>
                            }
                        />
                    </div>
                ) : (
                    // Refetch keeps the frame: the previous numbers stay, dimmed.
                    <div className={cn("transition-opacity", refetching && "opacity-60")}>
                        <section aria-label="Trabalho do Legal" className="mt-5">
                            <h2 className="mb-2 text-xs font-medium text-gray-500">Trabalho do Legal</h2>
                            <StatTiles tiles={headlineTiles(data)} />
                        </section>

                        <section aria-label="Agentes" className="mt-6">
                            <h2 className="mb-2 text-xs font-medium text-gray-500">O que os agentes fizeram</h2>
                            <StatTiles tiles={agentTiles(data)} />
                        </section>

                        <div className="mt-6 grid gap-4 lg:grid-cols-2">
                            <WeeklyColumns data={data.volume.weekly} />
                            <HorizontalBars
                                title="Tempo por etapa"
                                subtitle={`Mediana de dias em cada etapa · ${data.cycle.per_stage_moves} passagens registradas`}
                                rows={stageRows(data)}
                                unit="d"
                                empty="O tempo por etapa aparece conforme os cards andam na esteira (cada mudança de etapa passa a ser registrada)."
                            />
                            <HorizontalBars
                                title="Parados agora"
                                subtitle="Há quantos dias os pedidos em aberto estão na etapa atual (mediana)"
                                rows={stuckRows(data)}
                                unit="d"
                                empty="Nenhum pedido em aberto."
                            />
                            <HorizontalBars
                                title="Pedidos por área"
                                subtitle="Área que pediu, no período"
                                rows={data.volume.by_requester.slice(0, 7).map((r) => ({ label: r.label, value: r.count }))}
                                unit="ped."
                                empty="Nenhum pedido no período."
                            />
                        </div>

                        <section aria-label="Horas poupadas" className="mt-6 rounded-xl border border-gray-200 bg-app-surface p-4">
                            <h2 className="text-sm font-medium text-gray-900">Como calculei as horas poupadas</h2>
                            <p className="mt-1 text-xs text-gray-600">
                                {data.hours_saved.formula} = <strong className="text-gray-900">{data.hours_saved.hours} h</strong>
                            </p>
                            <p className="mt-1 text-[11px] text-gray-400">
                                É uma estimativa: troque as premissas pelo tempo real do seu time e a conta refaz sozinha.
                            </p>
                            {a ? (
                                <form
                                    className="mt-3 flex flex-wrap items-end gap-3"
                                    onSubmit={(e) => {
                                        e.preventDefault();
                                        const form = new FormData(e.currentTarget);
                                        setAssumptions({
                                            minutes_per_review: clampMinutes(String(form.get("minutes_per_review")), a.minutes_per_review),
                                            minutes_per_terms: clampMinutes(String(form.get("minutes_per_terms")), a.minutes_per_terms),
                                            minutes_per_regulatory_triage: clampMinutes(
                                                String(form.get("minutes_per_regulatory_triage")),
                                                a.minutes_per_regulatory_triage,
                                            ),
                                        });
                                    }}
                                >
                                    {ASSUMPTION_FIELDS.map((f) => (
                                        <label key={f.key} className="flex items-center gap-1.5 text-xs text-gray-600">
                                            <input
                                                name={f.key}
                                                type="number"
                                                min={1}
                                                max={1440}
                                                defaultValue={a[f.key]}
                                                className="h-7 w-16 rounded-md border border-gray-200 bg-app-surface px-2 text-right tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                            />
                                            {f.label}
                                        </label>
                                    ))}
                                    <PillButtonUI tone="white" size="xs" type="submit">
                                        Recalcular
                                    </PillButtonUI>
                                </form>
                            ) : null}
                        </section>

                        <section aria-label="Adoção por pessoa" className="mt-6">
                            <h2 className="mb-2 text-xs font-medium text-gray-500">Adoção por pessoa</h2>
                            {data.adoption.people.length === 0 ? (
                                <p className="text-xs text-gray-400">
                                    Ninguém tem pedido atribuído ainda. Atribua um responsável na esteira e o trabalho de cada pessoa aparece aqui.
                                </p>
                            ) : (
                                <table className="w-full max-w-2xl text-xs">
                                    <thead>
                                        <tr className="text-left text-gray-500">
                                            <th className="py-1.5 font-normal">Pessoa</th>
                                            <th className="py-1.5 text-right font-normal">Em aberto</th>
                                            <th className="py-1.5 text-right font-normal">Concluídos no período</th>
                                        </tr>
                                    </thead>
                                    <tbody className="tabular-nums text-gray-800">
                                        {data.adoption.people.map((p) => (
                                            <tr key={p.email} className="border-t border-gray-100">
                                                <td className="py-1.5 break-all">{personLabel(p.email)}</td>
                                                <td className="py-1.5 text-right">{p.assigned_open}</td>
                                                <td className="py-1.5 text-right">{p.closed}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </section>

                        <section aria-label="Custo de IA" className="mt-6 max-w-2xl">
                            <h2 className="mb-2 text-xs font-medium text-gray-500">Custo de IA</h2>
                            {data.ai_cost ? (
                                <HorizontalBars
                                    title={`${money(data.ai_cost.total_usd)} no período`}
                                    subtitle={costTile(data).hint}
                                    rows={data.ai_cost.by_agent.map((r) => ({ label: agentLabel(r.agent), value: r.usd }))}
                                    unit="US$"
                                />
                            ) : (
                                <p className="text-xs text-gray-400">
                                    Nenhuma execução de agente registrou custo no período. O custo aparece aqui assim que os agentes rodarem com o provedor que informa o gasto.
                                </p>
                            )}
                        </section>
                    </div>
                )}
            </div>
        </div>
    );
}
