import { describe, expect, it } from "vitest";
import type { ReviewClause } from "./mikeApi";
import {
    fichaStateLabel,
    isDecidable,
    isRunning,
    orderClauses,
    pendingAligned,
    precedentSentence,
    relativeTime,
    sourceCount,
    stepFocus,
    verdictCounts,
    visibleClauses,
} from "./contractReviewView";

function clause(id: string, verdict: ReviewClause["verdict"], extra: Partial<ReviewClause> = {}): ReviewClause {
    return {
        id,
        topicId: null,
        ruleId: id,
        ruleName: id,
        status: "acceptable",
        quote: "",
        location: "",
        analysis: "",
        suggestedText: "",
        verdict,
        playbook_status: "acceptable",
        covered: true,
        sources: [],
        rule_findings: [],
        precedent: null,
        decision: null,
        ...extra,
    };
}

const CLAUSES = [
    clause("a", "alinhado", { suggestedText: "x" }),
    clause("n", "nao_aplica"),
    clause("d1", "diverge"),
    clause("p", "precisa_revisao"),
    clause("d2", "diverge"),
];

describe("contract review view", () => {
    it("reads the most urgent first and keeps the playbook order within a verdict", () => {
        expect(orderClauses(CLAUSES).map((c) => c.id)).toEqual(["d1", "d2", "p", "a", "n"]);
        expect(visibleClauses(CLAUSES, "diverge").map((c) => c.id)).toEqual(["d1", "d2"]);
        expect(visibleClauses(CLAUSES, null)).toHaveLength(5);
    });

    it("counts the three lights", () => {
        expect(verdictCounts(CLAUSES)).toEqual({ alinhado: 1, precisa_revisao: 1, diverge: 2 });
    });

    it("knows which aligned suggestions still wait for a decision", () => {
        const decided = clause("a2", "alinhado", {
            suggestedText: "y",
            decision: { decision: "aceito", edited_text: null, reason: null, decided_by: "x", decided_at: "t", edit: null },
        });
        const tracked = clause("a3", "alinhado", { edit: { edit_id: "e" } as ReviewClause["edit"] });
        expect(pendingAligned([...CLAUSES, decided, tracked]).map((c) => c.id)).toEqual(["a", "a3"]);
        expect(isDecidable(clause("z", "diverge", { suggestedText: "  " }))).toBe(false);
    });

    it("words precedent as a count of signed contracts", () => {
        expect(precedentSentence(null)).toBeNull();
        expect(precedentSentence({ same: 0, of: 0, projects: [] })).toBeNull();
        expect(precedentSentence({ same: 3, of: 5, projects: [] })).toBe("Igual a 3 de 5 contratos assinados");
        expect(precedentSentence({ same: 1, of: 1, projects: [] })).toBe("Igual a 1 de 1 contrato assinado");
        expect(precedentSentence({ same: 0, of: 4, projects: [] })).toBe("Diferente dos 4 contratos assinados com este tema validado");
    });

    it("says how long ago in PT-BR", () => {
        const now = Date.parse("2026-10-20T12:00:00Z");
        expect(relativeTime("x", now)).toBe("");
        expect(relativeTime("2026-10-20T12:00:20Z", now)).toBe("agora");
        expect(relativeTime("2026-10-20T11:55:00Z", now)).toBe("há 5 min");
        expect(relativeTime("2026-10-20T09:00:00Z", now)).toBe("há 3 h");
        expect(relativeTime("2026-10-19T10:00:00Z", now)).toBe("ontem");
        expect(relativeTime("2026-10-17T12:00:00Z", now)).toBe("há 3 d");
        expect(relativeTime(new Date().toISOString())).toBe("agora");
    });

    it("counts the sources a suggestion stands on", () => {
        expect(sourceCount(clause("s", "diverge", { sources: [{ kind: "playbook", label: "", position: "", criteria: "" }] }))).toBe(1);
        expect(sourceCount(clause("s", "diverge", { precedent: { same: 1, of: 2, projects: [] } }))).toBe(1);
        expect(sourceCount(clause("s", "diverge", { precedent: { same: 0, of: 0, projects: [] } }))).toBe(0);
    });

    it("tells a running review apart", () => {
        expect(isRunning({ status: "running" })).toBe(true);
        expect(isRunning({ status: "completed" })).toBe(false);
        expect(isRunning(null)).toBe(false);
    });

    it("moves the focus with j/k inside the list", () => {
        expect(stepFocus(0, 1, 0)).toBe(-1);
        expect(stepFocus(-1, 1, 3)).toBe(0);
        expect(stepFocus(-1, -1, 3)).toBe(2);
        expect(stepFocus(2, 1, 3)).toBe(2);
        expect(stepFocus(0, -1, 3)).toBe(0);
        expect(stepFocus(1, 1, 3)).toBe(2);
    });

    it("words the Ficha's state of a field", () => {
        expect(fichaStateLabel("confirmado")).toBe("verificado");
        expect(fichaStateLabel("corrigido")).toBe("corrigido");
        expect(fichaStateLabel("nao_encontrado")).toBe("o contrato não trata disso");
        expect(fichaStateLabel("pendente")).toBe("a conferir");
    });
});
