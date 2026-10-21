import { describe, expect, it } from "vitest";
import type { LegalDashboard } from "./mikeApi";
import {
    agentTiles,
    clampMinutes,
    agentLabel,
    costTile,
    fichaTile,
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
    ficha: { contracts: 5, fields: 80, verified: 60, rate: 75 },
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
        expect(late[3]).toMatchObject({ tone: "critico", hint: "1 perdido no período" });
        const one = headlineTiles({
            ...base,
            volume: { ...base.volume, closed: 1 },
            cycle: { ...base.cycle, closed_measured: 1 },
            sla: { ...base.sla, open_overdue: 1 },
        });
        expect(one[0].hint).toBe("1 concluído · 7 em aberto");
        expect(one[1].hint).toBe("1 pedido medido");
        expect(one[2].hint).toBe("1 em aberto já passou do prazo");
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
        const tiles = agentTiles(base);
        expect(tiles.map((t) => t.id)).toEqual(["agentes", "horas", "ficha", "regulatorio"]);
        const [agentes, horas, ficha, regulatorio] = tiles;
        expect(agentes).toMatchObject({ value: "6", hint: "75% das revisões · 2 só por pessoas" });
        expect(horas).toMatchObject({ value: "14,5 h", hint: "6 revisões × 90 min" });
        expect(ficha).toMatchObject({ value: "75%", hint: "60 de 80 campos em 5 contratos", tone: "default" });
        expect(regulatorio).toMatchObject({ value: "14", hint: "3 viraram pedido ou prazo" });
        expect(costTile(base)).toMatchObject({ value: "—", hint: "nenhuma execução com custo registrado" });
        expect(agentTiles({ ...base, agents: { ...base.agents, regulatory_turned_into_work: 1 } })[3].hint).toBe(
            "1 virou pedido ou prazo",
        );
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
        expect(costTile({ ...base, ai_cost: { total_usd: 1, runs: 1, per_contract_usd: 1, by_agent: [] } }).hint).toMatch(/1 execução$/);
    });

    it("explains a Ficha tile with nothing to count", () => {
        expect(fichaTile({ ...base, ficha: null })).toMatchObject({ value: "—", hint: "aparece quando a Ficha estiver ativa" });
        expect(fichaTile({ ...base, ficha: { contracts: 0, fields: 0, verified: 0, rate: null } })).toMatchObject({
            hint: "nenhuma Ficha preenchida ainda",
        });
        expect(fichaTile({ ...base, ficha: { contracts: 1, fields: 1, verified: 0, rate: 0 } })).toMatchObject({
            value: "0%",
            hint: "0 de 1 campo em 1 contrato",
            tone: "atencao",
        });
    });

    it("names agents in Portuguese, never by id", () => {
        expect(agentLabel("revisor@1")).toBe("Agente de revisão");
        expect(agentLabel("regulatorio")).toBe("Agente regulatório");
        expect(agentLabel("desconhecido")).toBe("Agente");
    });
});

describe("stages", () => {
    it("combines time per stage with what is stuck now", () => {
        expect(stageRows(base)).toEqual([
            { label: "Entrada", value: 2, note: "4 passagens · 2 parados agora" },
            { label: "Revisão", value: null, note: "0 passagens · 3 parados agora" },
        ]);
        const one = { ...base, cycle: { ...base.cycle, stage_age: [{ lane: "entrada" as const, open: 1, median_days: 1 }], per_stage_history: [{ lane: "entrada" as const, moves: 1, median_days: 1 }] } };
        expect(stageRows(one)).toEqual([{ label: "Entrada", value: 1, note: "1 passagem · 1 parado agora" }]);
        expect(stageRows(base).length).toBe(2);
        expect(stuckRows(base)).toEqual([
            { label: "Entrada", value: 1.5, note: "2 em aberto" },
            { label: "Revisão", value: null, note: "3 em aberto" },
        ]);
    });
});
