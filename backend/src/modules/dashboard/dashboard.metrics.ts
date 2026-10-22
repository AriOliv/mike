// The Legal head's dashboard ("Painel do Legal"): what the team delivered,
// how fast, and what the agents took off its plate. Measures work, not
// clicks — volume of requests, time to close, SLA kept, notice deadlines
// kept, contracts reviewed by agents vs. people, hours saved with the formula
// on screen, and adoption per person.
//
// Every number is computed from rows that already exist (projects on the
// pipeline, dossiers, contract terms, playbook runs, regulatory changes), all
// scoped to the contracts the caller can see. Time per stage comes from the
// card event log (lane.changed), so it only covers moves made since the log
// existed; AI cost is what agent runs recorded, and the payload says when
// nothing was recorded instead of showing a zero that reads as "free".

import type { Db } from "../../lib/supabase";
import { internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { countAgentReviews, LANES, listPipeline, type PipelineCard } from "../contracts/contracts.service";
import { workspaceMatches, type WorkspaceFilter } from "../../lib/workspace";
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
type RequestAreaRow = { project_id: string | null; requester_area?: string | null; triage: { area?: unknown } | null };
type ProjectAreaRow = { id: string; requester_area: string | null };
type FichaRow = { project_id: string; ficha: Record<string, unknown> | null };
type LaneEventRow = { project_id: string; at: string; before: unknown; after: unknown };
type AgentRunRow = {
    project_id: string;
    agent: string;
    status: string;
    cost_usd: number | string | null;
    started_at: string;
    finished_at?: string | null;
};
type ChangeRow = { status: string; impact: string; request_project_id: string | null; obligation_id: string | null; created_at: string };

export type DashboardInputs = {
    cards: PipelineCard[];
    dossiers: DossierRow[];
    terms: TermsRow[];
    runs: RunRow[];
    changes: ChangeRow[];
    laneEvents: LaneEventRow[];
    /** null when the Ficha is not installed on this database yet. */
    fichas: FichaRow[] | null;
    /**
     * Contracts reviewed by agents in the period: countAgentReviews, the same
     * count as the home screen's "Revisei N contratos".
     */
    agentReviews: number;
    /** project id → the requesting area from intake triage; empty when not installed. */
    requestArea: Map<string, string>;
    agentRuns: AgentRunRow[];
    /** document id → project id, for runs over contract documents */
    documentProject: Map<string, string>;
};

const DAY = 86_400_000;

export const NO_AREA = "Área não informada";

/** The start of the period ending now: the same window everywhere. */
export function periodStart(now: Date, periodDays: number): string {
    return new Date(now.getTime() - periodDays * DAY).toISOString();
}


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
    const since = periodStart(now, opts.periodDays);
    const inPeriod = (iso: string | null | undefined) => !!iso && iso >= since && iso <= nowIso;

    // ── volume ──────────────────────────────────────────────────────────────
    const opened = input.cards.filter((c) => inPeriod(String(c.created_at ?? "")));
    const closedCards = input.cards.filter(
        (c) => c.status === "concluido" || c.lane === "arquivado",
    );
    // One definition of "concluído" and one date for it, shared by the volume
    // tile, the weekly chart, the cycle-time median and the SLA.
    const closedAt = (c: PipelineCard) => String(c.completed_at ?? c.lane_updated_at ?? "");
    const closed = closedCards.filter((c) => inPeriod(closedAt(c)));
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
        const w = weeks.get(weekOf(closedAt(c)));
        if (w) w.closed++;
    }

    const byType = new Map<string, number>();
    for (const c of opened) {
        const key = (c.contract_type as string | null) || "Sem tipo";
        byType.set(key, (byType.get(key) ?? 0) + 1);
    }
    // By the requesting AREA from intake triage, never by the person.
    const byRequester = new Map<string, number>();
    for (const c of opened) {
        const key = input.requestArea.get(c.id) || NO_AREA;
        byRequester.set(key, (byRequester.get(key) ?? 0) + 1);
    }

    // ── cycle time ──────────────────────────────────────────────────────────
    // completed_at is a date: a request opened and closed the same day is 0 d,
    // not dropped. Only a close date before the opening day is unmeasurable.
    const cycleDays = closed
        .filter((c) => closedAt(c).slice(0, 10) >= String(c.created_at ?? "").slice(0, 10))
        .map((c) => Math.max(0, daysBetween(String(c.created_at), closedAt(c))))
        .filter((d) => Number.isFinite(d));
    // Age in the current stage: what is stuck where, today.
    const stageAge = LANES.filter((l) => l !== "arquivado").map((lane) => {
        const here = open.filter((c) => c.lane === lane);
        const ages = here
            .map((c) => daysBetween(String(c.lane_updated_at ?? c.created_at), nowIso))
            .filter((d) => Number.isFinite(d) && d >= 0);
        return { lane, open: here.length, median_days: ages.length ? round1(median(ages)!) : null };
    });

    // Time spent in each stage, from every recorded lane move: a move out of
    // a lane closes the stay that the previous move (or the card's creation)
    // opened. Only stays that ended inside the period count.
    const stayDays = new Map<string, number[]>();
    const moves = [...input.laneEvents].sort((x, y) => x.at.localeCompare(y.at));
    const enteredAt = new Map<string, string>();
    const created = new Map(input.cards.map((c) => [c.id, String(c.created_at ?? "")]));
    for (const e of moves) {
        const from = typeof e.before === "string" ? e.before : null;
        const start = enteredAt.get(e.project_id) ?? created.get(e.project_id);
        if (from && from !== "arquivado" && start && inPeriod(e.at)) {
            const d = daysBetween(start, e.at);
            if (Number.isFinite(d) && d >= 0) stayDays.set(from, [...(stayDays.get(from) ?? []), d]);
        }
        enteredAt.set(e.project_id, e.at);
    }
    const perStage = LANES.filter((l) => l !== "arquivado").map((lane) => {
        const stays = stayDays.get(lane) ?? [];
        return { lane, moves: stays.length, median_days: stays.length ? round1(median(stays)!) : null };
    });
    const movesMeasured = perStage.reduce((n, s) => n + s.moves, 0);

    // ── SLA (the card's deadline) ───────────────────────────────────────────
    const withDeadline = closed.filter((c) => typeof c.deadline === "string");
    const onTime = withDeadline.filter((c) => closedAt(c).slice(0, 10) <= String(c.deadline));
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
    // Reviewed by agents: exactly countAgentReviews, the home screen's number.
    const agentReviewed = input.agentReviews;
    const agentRunsInPeriod = input.agentRuns.filter((r) => inPeriod(r.started_at));
    // Reviewed by people: an analysis a person brought in, with no agent
    // analysis of the same contract in the period.
    const generatedIds = new Set(generated.map((d) => d.project_id));
    const humanReviewed = new Set(imported.map((d) => d.project_id).filter((id) => !generatedIds.has(id)));
    const termsExtracted = input.terms.filter((t) => inPeriod(t.extracted_at));
    const triaged = input.changes.filter((c) => inPeriod(c.created_at));

    // ── Ficha fields verified by a person (same rule as the Ficha's own
    // "14/24 verificados": not-applicable fields are left out) ────────────────
    let fichaTotal = 0;
    let fichaVerified = 0;
    for (const row of input.fichas ?? []) {
        for (const field of Object.values(row.ficha ?? {})) {
            const f = field as { status?: string; review?: { state?: string } } | null;
            if (!f || typeof f !== "object" || f.status === "nao_aplicavel") continue;
            fichaTotal++;
            if (f.review?.state && f.review.state !== "pendente") fichaVerified++;
        }
    }

    // ── hours saved, formula visible ────────────────────────────────────────
    const a = opts.assumptions;
    const savedMinutes =
        agentReviewed * a.minutes_per_review +
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
            per_stage_history: perStage,
            per_stage_moves: movesMeasured,
        },
        sla: {
            closed_with_deadline: withDeadline.length,
            on_time: onTime.length,
            rate: withDeadline.length ? round1((onTime.length / withDeadline.length) * 100) : null,
            open_overdue: overdueOpen.length,
        },
        ficha:
            input.fichas === null
                ? null
                : {
                      contracts: input.fichas.length,
                      fields: fichaTotal,
                      verified: fichaVerified,
                      rate: fichaTotal ? round1((fichaVerified / fichaTotal) * 100) : null,
                  },
        notice: {
            due_in_30_days: noticeWindow.length,
            missed_in_period: noticeMissed.length,
        },
        agents: {
            contracts_reviewed_by_agents: agentReviewed,
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
                `${agentReviewed} revisões × ${a.minutes_per_review} min + ` +
                `${termsExtracted.length} extrações de prazos × ${a.minutes_per_terms} min + ` +
                `${triaged.length} mudanças regulatórias × ${a.minutes_per_regulatory_triage} min`,
        },
        adoption: {
            people: [...people.entries()]
                .map(([email, v]) => ({ email, ...v }))
                .sort((x, y) => y.closed + y.assigned_open - (x.closed + x.assigned_open)),
            reviews_by_user_id: [...runsByUser.entries()].map(([user_id, count]) => ({ user_id, count })),
        },
        ai_cost: aiCost(agentRunsInPeriod),
    };
}

/**
 * What the agent runs recorded. Null when no run carries a cost: the
 * provider registry does not report it for every model, and a zero would
 * read as "free".
 */
function aiCost(runs: AgentRunRow[]) {
    const costed = runs.filter((r) => r.cost_usd !== null && r.cost_usd !== undefined && Number.isFinite(Number(r.cost_usd)));
    if (costed.length === 0) return null;
    const byAgent = new Map<string, number>();
    for (const r of costed) byAgent.set(r.agent, (byAgent.get(r.agent) ?? 0) + Number(r.cost_usd));
    const total = [...byAgent.values()].reduce((a, b) => a + b, 0);
    const contracts = new Set(costed.map((r) => r.project_id)).size;
    return {
        total_usd: Math.round(total * 100) / 100,
        runs: costed.length,
        per_contract_usd: Math.round((total / contracts) * 100) / 100,
        by_agent: [...byAgent.entries()]
            .map(([agent, usd]) => ({ agent, usd: Math.round(usd * 100) / 100 }))
            .sort((a, b) => b.usd - a.usd),
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

/**
 * A table or column another module's migration adds, not on this database
 * yet: Postgres undefined_table / undefined_column, or PostgREST's schema
 * cache misses for either.
 */
function isMissingTable(error: { code?: string }): boolean {
    return ["42P01", "42703", "PGRST205", "PGRST204"].includes(error.code ?? "");
}

type SliceQuery<T> = (slice: string[]) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;

/**
 * Rows of a table another module's migration adds. Null while this database
 * does not have it yet, so the dashboard shows "not available" instead of
 * failing whole.
 */
async function optionalInChunks<T>(ids: string[], read: SliceQuery<T>): Promise<T[] | null> {
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const { data, error } = await read(ids.slice(i, i + ID_CHUNK));
        if (error && isMissingTable(error)) return null;
        if (error) throw error;
        out.push(...((data ?? []) as T[]));
    }
    return out;
}

async function inChunks<T>(ids: string[], read: (slice: string[]) => Promise<T[]>): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += ID_CHUNK) out.push(...(await read(ids.slice(i, i + ID_CHUNK))));
    return out;
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * The requesting area of each card: the area mirrored on the card, else the
 * request's own, else what intake triage read. Each source is read only if
 * this database has it; a card with none is left out (it shows as "Área não
 * informada"), never filled with the requester's name.
 */
async function requestAreas(db: Db, ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const mirrored = await optionalInChunks<ProjectAreaRow>(ids, (slice) =>
        db.from("projects").select("id, requester_area").in("id", slice),
    );
    for (const p of mirrored ?? []) if (text(p.requester_area)) out.set(p.id, text(p.requester_area));

    const missing = ids.filter((id) => !out.has(id));
    if (missing.length === 0) return out;
    let requests = await optionalInChunks<RequestAreaRow>(missing, (slice) =>
        db.from("legal_requests").select("project_id, requester_area, triage").in("project_id", slice),
    );
    // Before the area columns exist, the triage's reading is all there is.
    if (requests === null) {
        requests = await optionalInChunks<RequestAreaRow>(missing, (slice) =>
            db.from("legal_requests").select("project_id, triage").in("project_id", slice),
        );
    }
    for (const r of requests ?? []) {
        const area = text(r.requester_area) || text(r.triage?.area);
        if (r.project_id && area && !out.has(r.project_id)) out.set(r.project_id, area);
    }
    return out;
}

export async function getDashboard(
    db: Db,
    caller: Caller,
    query: Record<string, unknown>,
    now = new Date(),
    workspace: WorkspaceFilter = null,
): Promise<ServiceResult<Dashboard>> {
    const opts = parseDashboardQuery(query);
    const board = await listPipeline(db, caller);
    if (!board.ok) return board;
    // The active workspace, the same cut the home screen counts in.
    const cards = board.data.cards.filter((c) => workspaceMatches(workspace, c.org_id as string | null | undefined));
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
        const laneEvents = await inChunks(ids, async (slice) => {
            const { data, error } = await db
                .from("card_events")
                .select("project_id, at, before, after")
                .in("project_id", slice)
                .eq("action", "lane.changed");
            if (error) throw error;
            return (data ?? []) as LaneEventRow[];
        });
        const agentRuns = await inChunks(ids, async (slice) => {
            const { data, error } = await db
                .from("agent_runs")
                .select("project_id, agent, status, cost_usd, started_at, finished_at")
                .in("project_id", slice);
            if (error) throw error;
            return (data ?? []) as AgentRunRow[];
        });
        // The Ficha ships in another module's migration; until a database has
        // it, the tile says so instead of failing the whole dashboard.
        const fichas = await optionalInChunks<FichaRow>(ids, (slice) =>
            db.from("contract_fichas").select("project_id, ficha").in("project_id", slice),
        );
        // The one count shared with the home screen, over the visible
        // contracts and the period's window.
        const agentReviews = await countAgentReviews(db, ids, periodStart(now, opts.periodDays), now.toISOString());
        const requestArea = await requestAreas(db, ids);
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
                { cards, dossiers, terms, runs, changes, laneEvents, agentRuns, fichas, agentReviews, requestArea, documentProject },
                { now, periodDays: opts.periodDays, assumptions: opts.assumptions },
            ),
        );
    } catch (error) {
        return internalFailure(error);
    }
}
