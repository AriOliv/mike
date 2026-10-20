// The Legal head's dashboard ("Painel do Legal"): what the team delivered,
// how fast, and what the agents took off its plate. Measures work, not
// clicks — volume of requests, time to close, SLA kept, notice deadlines
// kept, contracts reviewed by agents vs. people, hours saved with the formula
// on screen, and adoption per person.
//
// Every number is computed from rows that already exist (projects on the
// pipeline, dossiers, contract terms, playbook runs, regulatory changes), all
// scoped to the contracts the caller can see. Where a measure needs data the
// platform does not record yet, the payload says so instead of inventing it:
// time per stage waits for the card event log, and AI cost for the agent run
// ledger.

import type { Db } from "../../lib/supabase";
import { internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { LANES, listPipeline, type PipelineCard } from "../contracts/contracts.service";
import { visibleScanIds } from "../regulatory/regulatory.service";

export type Caller = { userId: string; userEmail?: string | null };

/** Minutes a person spends on the work an agent did, editable on screen. */
export const DEFAULT_ASSUMPTIONS = {
    /** Reading a contract and filling the Ficha by hand. */
    minutes_per_review: 90,
    /** Pulling notice period, renewal and penalties out of a contract. */
    minutes_per_terms: 20,
    /** Reading a regulatory act and deciding whether it affects the base. */
    minutes_per_regulatory_triage: 15,
};
export type Assumptions = typeof DEFAULT_ASSUMPTIONS;

const PERIODS = [30, 90, 365] as const;

type DossierRow = { project_id: string; source: string | null; created_at: string; user_id: string | null };
type TermsRow = { project_id: string; notice_deadline: string | null; extracted_at: string };
type RunRow = { document_id: string | null; user_id: string; status: string; started_at: string; completed_at: string | null };
type ChangeRow = { status: string; impact: string; request_project_id: string | null; obligation_id: string | null; created_at: string };

export type DashboardInputs = {
    cards: PipelineCard[];
    dossiers: DossierRow[];
    terms: TermsRow[];
    runs: RunRow[];
    changes: ChangeRow[];
    /** document id → project id, for runs over contract documents */
    documentProject: Map<string, string>;
};

const DAY = 86_400_000;

function daysBetween(fromIso: string, toIso: string): number {
    return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / DAY;
}

function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Monday (UTC) of the week a timestamp falls in, as YYYY-MM-DD. */
export function weekOf(iso: string): string {
    const d = new Date(iso);
    const day = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - day);
    return d.toISOString().slice(0, 10);
}

export type Dashboard = ReturnType<typeof computeDashboard>;

export function computeDashboard(
    input: DashboardInputs,
    opts: { now: Date; periodDays: number; assumptions: Assumptions },
) {
    const now = opts.now;
    const nowIso = now.toISOString();
    const today = nowIso.slice(0, 10);
    const since = new Date(now.getTime() - opts.periodDays * DAY).toISOString();
    const inPeriod = (iso: string | null | undefined) => !!iso && iso >= since && iso <= nowIso;

    // ── volume ──────────────────────────────────────────────────────────────
    const opened = input.cards.filter((c) => inPeriod(String(c.created_at ?? "")));
    const closedCards = input.cards.filter(
        (c) => c.status === "concluido" || c.lane === "arquivado",
    );
    const closed = closedCards.filter((c) =>
        inPeriod(String(c.completed_at ?? c.lane_updated_at ?? "")),
    );
    const open = input.cards.filter((c) => c.lane !== "arquivado" && c.status !== "concluido");

    // weekly intake vs. closed, for the trend chart
    const weeks = new Map<string, { opened: number; closed: number }>();
    const lastWeek = weekOf(nowIso);
    for (let w = weekOf(since); w <= lastWeek; w = new Date(Date.parse(`${w}T00:00:00Z`) + 7 * DAY).toISOString().slice(0, 10)) {
        weeks.set(w, { opened: 0, closed: 0 });
    }
    for (const c of opened) {
        const w = weeks.get(weekOf(String(c.created_at)));
        if (w) w.opened++;
    }
    for (const c of closed) {
        const w = weeks.get(weekOf(String(c.completed_at ?? c.lane_updated_at)));
        if (w) w.closed++;
    }

    const byType = new Map<string, number>();
    for (const c of opened) {
        const key = (c.contract_type as string | null) || "Sem tipo";
        byType.set(key, (byType.get(key) ?? 0) + 1);
    }
    const byRequester = new Map<string, number>();
    for (const c of opened) {
        const key = (c.requester_name as string | null) || "Sem solicitante";
        byRequester.set(key, (byRequester.get(key) ?? 0) + 1);
    }

    // ── cycle time ──────────────────────────────────────────────────────────
    const cycleDays = closed
        .map((c) => daysBetween(String(c.created_at), String(c.completed_at ?? c.lane_updated_at)))
        .filter((d) => Number.isFinite(d) && d >= 0);
    // Age in the current stage: what is stuck where, today.
    const stageAge = LANES.filter((l) => l !== "arquivado").map((lane) => {
        const here = open.filter((c) => c.lane === lane);
        const ages = here
            .map((c) => daysBetween(String(c.lane_updated_at ?? c.created_at), nowIso))
            .filter((d) => Number.isFinite(d) && d >= 0);
        return { lane, open: here.length, median_days: ages.length ? round1(median(ages)!) : null };
    });

    // ── SLA (the card's deadline) ───────────────────────────────────────────
    const withDeadline = closed.filter((c) => typeof c.deadline === "string");
    const onTime = withDeadline.filter((c) => String(c.completed_at ?? c.lane_updated_at).slice(0, 10) <= String(c.deadline));
    const overdueOpen = open.filter((c) => typeof c.deadline === "string" && String(c.deadline) < today);

    // ── notice deadlines (aviso prévio) — our first-class citizen ───────────
    const noticeWindow = input.terms.filter(
        (t) => t.notice_deadline && t.notice_deadline >= today && daysBetween(nowIso, `${t.notice_deadline}T00:00:00Z`) <= 30,
    );
    const noticeMissed = input.terms.filter(
        (t) => t.notice_deadline && t.notice_deadline < today && inPeriod(`${t.notice_deadline}T12:00:00Z`),
    );

    // ── agents vs. people ───────────────────────────────────────────────────
    const generated = input.dossiers.filter((d) => d.source === "generated" && inPeriod(d.created_at));
    const imported = input.dossiers.filter((d) => d.source !== "generated" && inPeriod(d.created_at));
    const runsDone = input.runs.filter(
        (r) => r.status === "completed" && inPeriod(r.completed_at ?? r.started_at),
    );
    const agentReviewed = new Set<string>();
    for (const d of generated) agentReviewed.add(d.project_id);
    for (const r of runsDone) {
        const p = r.document_id ? input.documentProject.get(r.document_id) : undefined;
        if (p) agentReviewed.add(p);
    }
    const humanReviewed = new Set<string>(imported.map((d) => d.project_id));
    for (const p of agentReviewed) humanReviewed.delete(p);
    const termsExtracted = input.terms.filter((t) => inPeriod(t.extracted_at));
    const triaged = input.changes.filter((c) => inPeriod(c.created_at));

    // ── hours saved, formula visible ────────────────────────────────────────
    const a = opts.assumptions;
    const savedMinutes =
        agentReviewed.size * a.minutes_per_review +
        termsExtracted.length * a.minutes_per_terms +
        triaged.length * a.minutes_per_regulatory_triage;

    // ── adoption per person ─────────────────────────────────────────────────
    const people = new Map<string, { assigned_open: number; closed: number; reviews_run: number }>();
    const person = (key: string) => {
        const p = people.get(key) ?? { assigned_open: 0, closed: 0, reviews_run: 0 };
        people.set(key, p);
        return p;
    };
    for (const c of open) if (c.assignee_email) person(String(c.assignee_email)).assigned_open++;
    for (const c of closed) if (c.assignee_email) person(String(c.assignee_email)).closed++;
    const runsByUser = new Map<string, number>();
    for (const r of runsDone) runsByUser.set(r.user_id, (runsByUser.get(r.user_id) ?? 0) + 1);

    return {
        period_days: opts.periodDays,
        generated_at: nowIso,
        volume: {
            opened: opened.length,
            closed: closed.length,
            open: open.length,
            weekly: [...weeks.entries()].map(([week, v]) => ({ week, ...v })),
            by_type: [...byType.entries()].map(([label, count]) => ({ label, count })).sort((x, y) => y.count - x.count),
            by_requester: [...byRequester.entries()]
                .map(([label, count]) => ({ label, count }))
                .sort((x, y) => y.count - x.count),
        },
        cycle: {
            median_days_to_close: cycleDays.length ? round1(median(cycleDays)!) : null,
            closed_measured: cycleDays.length,
            stage_age: stageAge,
            // Time spent per stage needs every lane change, not just the last.
            per_stage_history: null as null,
            per_stage_history_note: "O histórico por etapa chega com o registro de eventos do card.",
        },
        sla: {
            closed_with_deadline: withDeadline.length,
            on_time: onTime.length,
            rate: withDeadline.length ? round1((onTime.length / withDeadline.length) * 100) : null,
            open_overdue: overdueOpen.length,
        },
        notice: {
            due_in_30_days: noticeWindow.length,
            missed_in_period: noticeMissed.length,
        },
        agents: {
            contracts_reviewed_by_agents: agentReviewed.size,
            contracts_reviewed_by_people: humanReviewed.size,
            playbook_runs: runsDone.length,
            terms_extracted: termsExtracted.length,
            regulatory_changes_triaged: triaged.length,
            regulatory_turned_into_work: triaged.filter((c) => c.request_project_id || c.obligation_id).length,
        },
        hours_saved: {
            hours: round1(savedMinutes / 60),
            assumptions: a,
            formula:
                `${agentReviewed.size} revisões × ${a.minutes_per_review} min + ` +
                `${termsExtracted.length} extrações de prazos × ${a.minutes_per_terms} min + ` +
                `${triaged.length} mudanças regulatórias × ${a.minutes_per_regulatory_triage} min`,
        },
        adoption: {
            people: [...people.entries()]
                .map(([email, v]) => ({ email, ...v }))
                .sort((x, y) => y.closed + y.assigned_open - (x.closed + x.assigned_open)),
            reviews_by_user_id: [...runsByUser.entries()].map(([user_id, count]) => ({ user_id, count })),
        },
        // The provider registry does not persist token usage; the agent run
        // ledger will. Until then this stays null rather than a guess.
        ai_cost: null as null,
        ai_cost_note: "O custo de IA aparece quando o registro de execuções dos agentes estiver ativo.",
    };
}

function positiveMinutes(value: unknown, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 && n <= 24 * 60 ? Math.round(n) : fallback;
}

export function parseDashboardQuery(query: Record<string, unknown>): { periodDays: number; assumptions: Assumptions } {
    const p = Number(query.period);
    const periodDays = (PERIODS as readonly number[]).includes(p) ? p : 90;
    return {
        periodDays,
        assumptions: {
            minutes_per_review: positiveMinutes(query.min_review, DEFAULT_ASSUMPTIONS.minutes_per_review),
            minutes_per_terms: positiveMinutes(query.min_terms, DEFAULT_ASSUMPTIONS.minutes_per_terms),
            minutes_per_regulatory_triage: positiveMinutes(
                query.min_regulatory,
                DEFAULT_ASSUMPTIONS.minutes_per_regulatory_triage,
            ),
        },
    };
}

const ID_CHUNK = 200;

async function inChunks<T>(ids: string[], read: (slice: string[]) => Promise<T[]>): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += ID_CHUNK) out.push(...(await read(ids.slice(i, i + ID_CHUNK))));
    return out;
}

export async function getDashboard(
    db: Db,
    caller: Caller,
    query: Record<string, unknown>,
    now = new Date(),
): Promise<ServiceResult<Dashboard>> {
    const opts = parseDashboardQuery(query);
    const board = await listPipeline(db, caller);
    if (!board.ok) return board;
    const cards = board.data.cards;
    const ids = cards.map((c) => c.id);

    try {
        const dossiers = await inChunks(ids, async (slice) => {
            const { data, error } = await db
                .from("dossiers")
                .select("project_id, source, created_at, user_id")
                .in("project_id", slice);
            if (error) throw error;
            return (data ?? []) as DossierRow[];
        });
        const terms = await inChunks(ids, async (slice) => {
            const { data, error } = await db
                .from("contract_terms")
                .select("project_id, notice_deadline, extracted_at")
                .in("project_id", slice);
            if (error) throw error;
            return (data ?? []) as TermsRow[];
        });
        const docs = await inChunks(ids, async (slice) => {
            const { data, error } = await db.from("documents").select("id, project_id").in("project_id", slice);
            if (error) throw error;
            return (data ?? []) as { id: string; project_id: string }[];
        });
        const documentProject = new Map(docs.map((d) => [d.id, d.project_id]));
        const runs = await inChunks([...documentProject.keys()], async (slice) => {
            const { data, error } = await db
                .from("playbook_runs")
                .select("document_id, user_id, status, started_at, completed_at")
                .in("document_id", slice);
            if (error) throw error;
            return (data ?? []) as RunRow[];
        });
        const scanIds = await visibleScanIds(db, caller);
        const changes = await inChunks(scanIds, async (slice) => {
            const { data, error } = await db
                .from("regulatory_changes")
                .select("status, impact, request_project_id, obligation_id, created_at")
                .in("scan_id", slice);
            if (error) throw error;
            return (data ?? []) as ChangeRow[];
        });

        return ok(
            computeDashboard(
                { cards, dossiers, terms, runs, changes, documentProject },
                { now, periodDays: opts.periodDays, assumptions: opts.assumptions },
            ),
        );
    } catch (error) {
        return internalFailure(error);
    }
}
