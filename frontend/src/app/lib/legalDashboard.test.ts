import { describe, expect, it } from "vitest";
import type { LegalDashboard } from "./mikeApi";
import {
    agentTiles,
    clampMinutes,
    costTile,
    fmt,
    headlineTiles,
    money,
    personLabel,
    stageRows,
    stuckRows,
} from "./legalDashboard";

const base: LegalDashboard = {
    period_days: 90,
    generated_at: "2026-10-20T12:00:00Z",
    volume: { opened: 12, closed: 9, open: 7, weekly: [], by_type: [], by_requester: [] },
    cycle: {
        median_days_to_close: 6.5,
        closed_measured: 9,
        stage_age: [
            { lane: "entrada", open: 2, median_days: 1.5 },
            { lane: "revisao", open: 3, median_days: null },
        ],
        per_stage_history: [{ lane: "entrada", moves: 4, median_days: 2 }],
        per_stage_moves: 4,
    },
    sla: { closed_with_deadline: 8, on_time: 7, rate: 87.5, open_overdue: 0 },
    notice: { due_in_30_days: 0, missed_in_period: 0 },
    agents: {
        contracts_reviewed_by_agents: 6,
        contracts_reviewed_by_people: 2,
        playbook_runs: 5,
        terms_extracted: 8,
        regulatory_changes_triaged: 14,
        regulatory_turned_into_work: 3,
    },
    hours_saved: {
        hours: 14.5,
        formula: "6 revisões × 90 min",
        assumptions: { minutes_per_review: 90, minutes_per_terms: 20, minutes_per_regulatory_triage: 15 },
    },
    adoption: { people: [], reviews_by_user_id: [] },
    ai_cost: null,
};

describe("formatting", () => {
    it("formats numbers in Portuguese and dashes the missing ones", () => {
        expect(fmt(6.5, " d")).toBe("6,5 d");
        expect(fmt(null)).toBe("—");
        expect(fmt(undefined)).toBe("—");
        expect(money(1.5)).toMatch(/US\$\s?1,50/);
        expect(personLabel("joana.silva@avenia.io")).toBe("joana.silva");
    });

    it("accepts only sane minute assumptions", () => {
        expect(clampMinutes("45", 90)).toBe(45);
        expect(clampMinutes("0", 90)).toBe(90);
        expect(clampMinutes("abc", 90)).toBe(90);
        expect(clampMinutes("5000", 90)).toBe(90);
    });
});

describe("headline tiles", () => {
    it("reads calm when nothing is late", () => {
        const [volume, ciclo, sla, aviso] = headlineTiles(base);
        expect(volume).toMatchObject({ value: "12", hint: "9 concluídos · 7 em aberto" });
        expect(ciclo).toMatchObject({ value: "6,5 d", hint: "9 pedidos medidos" });
        expect(sla).toMatchObject({ value: "87,5%", hint: "7 de 8 no prazo", tone: "default" });
        expect(aviso).toMatchObject({ value: "0", hint: "nenhum aviso perdido no período", tone: "default" });
    });

    it("turns red for late work and lost notice periods, amber for a weak SLA", () => {
        const late = headlineTiles({
            ...base,
            sla: { ...base.sla, open_overdue: 2 },
            notice: { due_in_30_days: 3, missed_in_period: 1 },
        });
        expect(late[2]).toMatchObject({ tone: "critico", hint: "2 em aberto já passaram do prazo" });
        expect(late[3]).toMatchObject({ tone: "critico", hint: "1 perdidos no período" });
        const weak = headlineTiles({ ...base, sla: { ...base.sla, rate: 60 }, notice: { due_in_30_days: 3, missed_in_period: 0 } });
        expect(weak[2].tone).toBe("atencao");
        expect(weak[3].tone).toBe("atencao");
        const none = headlineTiles({
            ...base,
            cycle: { ...base.cycle, median_days_to_close: null, closed_measured: 0 },
            sla: { ...base.sla, rate: null },
        });
        expect(none[1]).toMatchObject({ value: "—", hint: "nenhum pedido concluído no período" });
        expect(none[2].value).toBe("—");
    });
});

describe("agent tiles", () => {
    it("shows the agents' share and what the radar produced", () => {
        const [agentes, horas, regulatorio, custo] = agentTiles(base);
        expect(agentes).toMatchObject({ value: "6", hint: "75% das revisões · 2 só por pessoas" });
        expect(horas.value).toBe("14,5 h");
        expect(regulatorio).toMatchObject({ value: "14", hint: "3 viraram pedido ou prazo" });
        expect(custo).toMatchObject({ value: "—", hint: "nenhuma execução com custo registrado" });
    });

    it("says when nothing was reviewed, and shows recorded cost", () => {
        const none = agentTiles({
            ...base,
            agents: { ...base.agents, contracts_reviewed_by_agents: 0, contracts_reviewed_by_people: 0 },
        });
        expect(none[0].hint).toBe("nenhuma revisão no período");
        const cost = costTile({ ...base, ai_cost: { total_usd: 3.2, runs: 12, per_contract_usd: 0.4, by_agent: [] } });
        expect(cost.value).toMatch(/3,20/);
        expect(cost.hint).toMatch(/0,40 por contrato · 12 execuções/);
    });
});

describe("stages", () => {
    it("combines time per stage with what is stuck now", () => {
        expect(stageRows(base)).toEqual([
            { label: "Entrada", value: 2, note: "4 passagens · 2 parados agora" },
            { label: "Revisão", value: null, note: "0 passagens · 3 parados agora" },
        ]);
        expect(stuckRows(base)).toEqual([
            { label: "Entrada", value: 1.5, note: "2 em aberto" },
            { label: "Revisão", value: null, note: "3 em aberto" },
        ]);
    });
});
