import { describe, expect, it } from "vitest";
import {
    affectedLabel,
    brDate,
    changeMeta,
    daysUntil,
    deadlineLabel,
    deadlineTone,
    deadlineTooltip,
    impactVerdict,
    plural,
    relativeRun,
    scanHeadline,
} from "./regulatoryRadar";

describe("plural", () => {
    it("agrees the word with the count", () => {
        expect(plural(1, "dia", "dias")).toBe("1 dia");
        expect(plural(0, "dia", "dias")).toBe("0 dias");
        expect(plural(3, "mudança", "mudanças")).toBe("3 mudanças");
    });
});

describe("impact", () => {
    it("maps onto the traffic light", () => {
        expect(impactVerdict("alto")).toBe("diverge");
        expect(impactVerdict("medio")).toBe("precisa_revisao");
        expect(impactVerdict("baixo")).toBe("alinhado");
    });
});

describe("dates", () => {
    it("formats Brazilian dates", () => {
        expect(brDate("2026-10-20")).toBe("20/10/2026");
        expect(brDate("2026-10-20T12:00:00Z")).toBe("20/10/2026");
        expect(brDate(null)).toBeNull();
        expect(brDate("ontem")).toBeNull();
    });

    it("counts whole days from today", () => {
        const now = new Date(2026, 9, 20, 23, 30);
        expect(daysUntil("2026-10-20", now)).toBe(0);
        expect(daysUntil("2026-10-27", now)).toBe(7);
        expect(daysUntil("2026-10-19", now)).toBe(-1);
        expect(typeof daysUntil("2026-10-20")).toBe("number");
    });
});

describe("deadline badge", () => {
    it("steps through the tones", () => {
        expect([-1, 0, 7, 8, 30, 31, 60, 61, 90, 91].map((d) => deadlineTone(d))).toEqual([
            "vencido", "d7", "d7", "d30", "d30", "d60", "d60", "d90", "d90", "longe",
        ]);
    });

    it("calls a rule already in effect 'em vigor', in grey, never overdue", () => {
        expect(deadlineTone(-5, "vigencia")).toBe("em_vigor");
        expect(deadlineLabel(-5, "vigencia")).toBe("em vigor");
        expect(deadlineTone(-5, "prazo")).toBe("vencido");
        expect(deadlineTooltip({ date: "2026-01-02", kind: "vigencia", past: true })).toBe("em vigor desde 02/01/2026");
    });

    it("labels the count", () => {
        expect(deadlineLabel(-3)).toBe("vencido");
        expect(deadlineLabel(0)).toBe("hoje");
        expect(deadlineLabel(21)).toBe("D-21");
    });

    it("shows the arithmetic in the tooltip", () => {
        expect(deadlineTooltip({ date: "2026-10-11", endDate: "2026-11-10", noticeDays: 30 })).toBe(
            "aviso até 11/10/2026 (vencimento 10/11/2026 − 30 dias de aviso)",
        );
        expect(deadlineTooltip({ date: "2026-10-11" })).toBe("aviso até 11/10/2026");
        expect(deadlineTooltip({ date: "2026-10-11", endDate: "2026-10-12", noticeDays: 1 })).toBe(
            "aviso até 11/10/2026 (vencimento 12/10/2026 − 1 dia de aviso)",
        );
        expect(deadlineTooltip({ date: "2027-02-02", kind: "vigencia" })).toBe("entra em vigor em 02/02/2027");
        expect(deadlineTooltip({ date: "2026-12-01", kind: "prazo" })).toBe("prazo até 01/12/2026");
    });
});

describe("copy", () => {
    it("says what a scan found", () => {
        expect(scanHeadline("LGPD", 3)).toEqual({ lead: "Sua varredura", name: "LGPD", tail: "encontrou 3 mudanças." });
        expect(scanHeadline("LGPD", 1).tail).toBe("encontrou 1 mudança.");
        expect(scanHeadline("LGPD", 0).tail).toBe("não encontrou mudanças novas.");
    });

    it("summarises where a change came from", () => {
        expect(changeMeta({ source: "bcb_normativos", act_type: "Resolução BCB", published_at: "2026-10-19" })).toBe(
            "BCB · Resolução BCB · 19/10/2026",
        );
        expect(changeMeta({ source: "dou", act_type: null, published_at: null })).toBe("DOU");
    });

    it("counts affected contracts without naming the hidden ones", () => {
        expect(affectedLabel(0, 0)).toBe("nenhum contrato afetado");
        expect(affectedLabel(1, 0)).toBe("1 contrato afetado");
        expect(affectedLabel(3, 1)).toBe("4 contratos afetados (1 sem acesso)");
    });

    it("says when a scan last ran", () => {
        const now = Date.parse("2026-10-20T12:00:00Z");
        expect(relativeRun(null, now)).toBe("ainda não rodou");
        expect(relativeRun("2026-10-20T11:59:40Z", now)).toBe("varrido agora");
        expect(relativeRun("2026-10-20T11:50:00Z", now)).toBe("varrido há 10 min");
        expect(relativeRun("2026-10-20T07:00:00Z", now)).toBe("varrido há 5 h");
        expect(relativeRun("2026-10-17T12:00:00Z", now)).toBe("varrido há 3 d");
        expect(relativeRun("2026-10-20T12:00:00Z")).toMatch(/^varrido/);
    });
});
