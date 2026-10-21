// The Legal dashboard's wording: tiles, stage names, the hours-saved formula
// and the cost line. React-free so every branch is tested.

import type { LegalDashboard, PipelineLane } from "./mikeApi";
import { actorLabel } from "./activityFeed";
import { plural } from "./regulatoryRadar";

export const LANE_LABEL: Record<PipelineLane, string> = {
    entrada: "Entrada",
    triagem: "Triagem",
    revisao: "Revisão",
    negociacao: "Negociação",
    assinatura: "Assinatura",
    arquivado: "Arquivado",
};

export const PERIODS = [
    { days: 30, label: "30 dias" },
    { days: 90, label: "90 dias" },
    { days: 365, label: "12 meses" },
] as const;

const nf = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export function fmt(n: number | null | undefined, suffix = ""): string {
    if (n === null || n === undefined) return "—";
    return `${nf.format(n)}${suffix}`;
}

export function money(n: number): string {
    return usd.format(n);
}

export type Tile = {
    id: string;
    value: string;
    label: string;
    hint?: string;
    tone?: "default" | "atencao" | "critico";
};

/** The four numbers the Head reads first. */
export function headlineTiles(d: LegalDashboard): Tile[] {
    const late = d.sla.open_overdue;
    const missed = d.notice.missed_in_period;
    return [
        {
            id: "volume",
            value: fmt(d.volume.opened),
            label: "Pedidos recebidos",
            hint: `${plural(d.volume.closed, "concluído", "concluídos")} · ${fmt(d.volume.open)} em aberto`,
        },
        {
            id: "ciclo",
            value: fmt(d.cycle.median_days_to_close, " d"),
            label: "Tempo até concluir (mediana)",
            hint: d.cycle.closed_measured
                ? plural(d.cycle.closed_measured, "pedido medido", "pedidos medidos")
                : "nenhum pedido concluído no período",
        },
        {
            id: "sla",
            value: d.sla.rate === null ? "—" : `${fmt(d.sla.rate)}%`,
            label: "Prazo cumprido",
            hint: late
                ? `${plural(late, "em aberto já passou", "em aberto já passaram")} do prazo`
                : `${d.sla.on_time} de ${d.sla.closed_with_deadline} no prazo`,
            tone: late > 0 ? "critico" : d.sla.rate !== null && d.sla.rate < 80 ? "atencao" : "default",
        },
        {
            id: "aviso",
            value: fmt(d.notice.due_in_30_days),
            label: "Avisos prévios em 30 dias",
            hint: missed ? `${plural(missed, "perdido", "perdidos")} no período` : "nenhum aviso perdido no período",
            tone: missed > 0 ? "critico" : d.notice.due_in_30_days > 0 ? "atencao" : "default",
        },
    ];
}

/** Agents vs. people, in one sentence each; at most four in a row. AI cost has its own section. */
export function agentTiles(d: LegalDashboard): Tile[] {
    const a = d.agents;
    const total = a.contracts_reviewed_by_agents + a.contracts_reviewed_by_people;
    const share = total ? Math.round((a.contracts_reviewed_by_agents / total) * 100) : null;
    return [
        {
            id: "agentes",
            value: fmt(a.contracts_reviewed_by_agents),
            label: "Contratos revisados por agentes",
            hint: share === null ? "nenhuma revisão no período" : `${share}% das revisões · ${fmt(a.contracts_reviewed_by_people)} só por pessoas`,
        },
        {
            id: "horas",
            value: fmt(d.hours_saved.hours, " h"),
            label: "Horas poupadas (estimativa)",
            hint: d.hours_saved.formula,
        },
        fichaTile(d),
        {
            id: "regulatorio",
            value: fmt(a.regulatory_changes_triaged),
            label: "Mudanças regulatórias triadas",
            hint: `${plural(a.regulatory_turned_into_work, "virou", "viraram")} pedido ou prazo`,
        },
    ];
}

export function costTile(d: LegalDashboard): Tile {
    if (!d.ai_cost) {
        return {
            id: "custo",
            value: "—",
            label: "Custo de IA",
            hint: "nenhuma execução com custo registrado",
        };
    }
    return {
        id: "custo",
        value: money(d.ai_cost.total_usd),
        label: "Custo de IA",
        hint: `${money(d.ai_cost.per_contract_usd)} por contrato · ${plural(d.ai_cost.runs, "execução", "execuções")}`,
    };
}

export function fichaTile(d: LegalDashboard): Tile {
    if (!d.ficha || d.ficha.rate === null) {
        return {
            id: "ficha",
            value: "—",
            label: "Campos da Ficha verificados",
            hint: d.ficha ? "nenhuma Ficha preenchida ainda" : "aparece quando a Ficha estiver ativa",
        };
    }
    return {
        id: "ficha",
        value: `${fmt(d.ficha.rate)}%`,
        label: "Campos da Ficha verificados",
        hint: `${fmt(d.ficha.verified)} de ${plural(d.ficha.fields, "campo", "campos")} em ${plural(d.ficha.contracts, "contrato", "contratos")}`,
        tone: d.ficha.rate < 50 ? "atencao" : "default",
    };
}

/** "revisor@1" → "Agente de revisão": never an internal id on screen. */
export function agentLabel(agent: string): string {
    return actorLabel({ actor_type: "agent", actor_id: agent, actor_name: null });
}

export function stageRows(d: LegalDashboard) {
    const history = new Map(d.cycle.per_stage_history.map((s) => [s.lane, s]));
    return d.cycle.stage_age.map((s) => {
        const h = history.get(s.lane);
        return {
            label: LANE_LABEL[s.lane],
            value: h?.median_days ?? null,
            note: `${plural(h?.moves ?? 0, "passagem", "passagens")} · ${plural(s.open, "parado", "parados")} agora`,
        };
    });
}

export function stuckRows(d: LegalDashboard) {
    return d.cycle.stage_age.map((s) => ({
        label: LANE_LABEL[s.lane],
        value: s.median_days,
        note: `${fmt(s.open)} em aberto`,
    }));
}

/** "joana.silva@avenia.io" → "joana.silva". */
export function personLabel(email: string): string {
    return email.split("@")[0];
}

export function clampMinutes(raw: string, fallback: number): number {
    const n = Math.round(Number(raw));
    return Number.isFinite(n) && n > 0 && n <= 1440 ? n : fallback;
}
