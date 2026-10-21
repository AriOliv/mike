// How the contract review screen orders, filters and words a review's
// clauses. Kept out of the component so the rules (diverge first, what counts
// as decidable, the precedent sentence) are tested on their own.

import type { ContractReview, ReviewClause, ReviewVerdict } from "./mikeApi";
import { toActivityItems, type ActivityItem, type CardEventRow } from "./activityFeed";

export type VerdictFilter = Exclude<ReviewVerdict, "nao_aplica"> | null;

/** "1 contrato", "3 contratos": the count and the noun that agrees with it. */
export function plural(n: number, one: string, many: string): string {
    return `${n.toLocaleString("pt-BR")} ${n === 1 ? one : many}`;
}

const SAO_PAULO = "America/Sao_Paulo";
const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: SAO_PAULO, year: "numeric", month: "2-digit", day: "2-digit" });

/** Calendar days between two instants, as a person in São Paulo counts them. */
function calendarDaysBetween(then: number, now: number): number {
    const day = (t: number) => Date.parse(`${DAY.format(t)}T00:00:00Z`);
    return Math.round((day(now) - day(then)) / 86_400_000);
}

const URGENCY: Record<ReviewVerdict, number> = { diverge: 0, precisa_revisao: 1, alinhado: 2, nao_aplica: 3 };

/** Diverge first, then what needs review, then what is aligned; ties keep the playbook's order. */
export function orderClauses(clauses: readonly ReviewClause[]): ReviewClause[] {
    return clauses
        .map((clause, index) => ({ clause, index }))
        .sort((a, b) => URGENCY[a.clause.verdict] - URGENCY[b.clause.verdict] || a.index - b.index)
        .map(({ clause }) => clause);
}

export function visibleClauses(clauses: readonly ReviewClause[], filter: VerdictFilter): ReviewClause[] {
    const ordered = orderClauses(clauses);
    return filter ? ordered.filter((clause) => clause.verdict === filter) : ordered;
}

export function verdictCounts(clauses: readonly ReviewClause[]) {
    const counts = { alinhado: 0, precisa_revisao: 0, diverge: 0 };
    for (const clause of clauses) if (clause.verdict !== "nao_aplica") counts[clause.verdict] += 1;
    return counts;
}

/** A clause carries a decision when it proposes wording or has its own tracked change. */
export function isDecidable(clause: ReviewClause): boolean {
    return !!clause.suggestedText.trim() || !!clause.edit;
}

/** Aligned suggestions still waiting for a decision: "Aceitar todos os alinhados". */
export function pendingAligned(clauses: readonly ReviewClause[]): ReviewClause[] {
    return clauses.filter((clause) => clause.verdict === "alinhado" && isDecidable(clause) && !clause.decision);
}

/** "Igual a 3 de 5 contratos assinados", or null when there is nothing to compare with. */
export function precedentSentence(precedent: ReviewClause["precedent"]): string | null {
    if (!precedent || precedent.of === 0) return null;
    const signed = plural(precedent.of, "contrato assinado", "contratos assinados");
    if (precedent.same === 0)
        return precedent.of === 1
            ? "Diferente do único contrato assinado com este tema verificado"
            : `Diferente de todos os ${signed} com este tema verificado`;
    return `Igual a ${precedent.same.toLocaleString("pt-BR")} de ${signed}`;
}

/**
 * "há 5 min", "há 3 h", "ontem", "há 3 d", or the date — the PT-BR relative
 * time of the parity rules. "ontem" is the previous calendar day in São Paulo,
 * not "24 hours ago".
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return "";
    const minutes = Math.max(0, Math.floor((now - then) / 60_000));
    if (minutes < 1) return "agora";
    if (minutes < 60) return `há ${minutes} min`;
    const days = calendarDaysBetween(then, now);
    if (days < 1) return `há ${Math.floor(minutes / 60)} h`;
    if (days === 1) return "ontem";
    if (days < 7) return `há ${days} d`;
    return new Date(then).toLocaleDateString("pt-BR", { timeZone: SAO_PAULO });
}

export function sourceCount(clause: ReviewClause): number {
    return clause.sources.length + (clause.precedent && clause.precedent.of > 0 ? 1 : 0);
}

/** The review is still drafting its edits. */
export function isRunning(review: Pick<ContractReview, "status"> | null): boolean {
    return review?.status === "running";
}

/** The next index for j/k, kept inside the list. */
export function stepFocus(current: number, delta: number, length: number): number {
    if (length === 0) return -1;
    if (current < 0) return delta > 0 ? 0 : length - 1;
    return Math.min(length - 1, Math.max(0, current + delta));
}

/** The Ficha's state of a field, in words, for a source chip. */
export function fichaStateLabel(state: string): string {
    switch (state) {
        case "confirmado":
            return "verificado";
        case "corrigido":
            return "corrigido";
        case "nao_encontrado":
            return "o contrato não trata disso";
        default:
            return "a conferir";
    }
}

const URL_VERDICTS = new Set(["diverge", "precisa_revisao", "alinhado"]);

/** ?veredito= → the filter; an unknown value is ignored, never an error. */
export function verdictFromParam(value: string | null | undefined): VerdictFilter {
    return value && URL_VERDICTS.has(value) ? (value as VerdictFilter) : null;
}

/**
 * The review's URL for the current run and filter, keeping any other
 * parameter (such as ?quote=). The shared contract: ?run=<runId> and
 * ?veredito=diverge|precisa_revisao|alinhado.
 */
export function reviewSearch(current: string, runId: string | null, filter: VerdictFilter): string {
    const params = new URLSearchParams(current);
    if (runId) params.set("run", runId);
    else params.delete("run");
    if (filter) params.set("veredito", filter);
    else params.delete("veredito");
    const text = params.toString();
    return text ? `?${text}` : "";
}

/** "18:02" in São Paulo, for a decision's line. */
export function clockTime(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
        ? ""
        : date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: SAO_PAULO });
}

const CLAUSE_VERBS: Record<string, string> = {
    "review.clause_aceito": "aceitou a sugestão em",
    "review.clause_editado": "editou a sugestão em",
    "review.clause_rejeitado": "rejeitou a sugestão em",
};

/**
 * The contract's activity feed. Clause decisions are this module's own
 * events, so they are worded here ("aceitou a sugestão em Cessão") and the
 * rest is left to the shared feed.
 */
export function reviewActivity(events: CardEventRow[]): ActivityItem[] {
    const items = toActivityItems(events);
    const byId = new Map(events.map((event) => [String(event.id), event]));
    return items.map((item) => {
        const event = byId.get(item.id);
        const verb = event && CLAUSE_VERBS[event.action];
        return verb ? { ...item, verb, object: event.field ?? undefined } : item;
    });
}

