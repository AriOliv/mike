// The home screen ("Início") in one read: what the agents did since the
// person's last visit, the counters, the review queue, the notice deadlines
// closing soon and the recent activity — all limited to the cards the caller
// can see.

import type { Db } from "../../lib/supabase";
import { listAccessibleProjectIds } from "../../lib/access";
import { internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { workspaceMatches, type WorkspaceFilter } from "../../lib/workspace";
import { loadProfileUsersByEmail } from "../../lib/userLookup";
import type { Caller } from "./contracts.shared";
import type { CardEvent } from "./contracts.events";

const ID_CHUNK = 200;
const NOTICE_WINDOW_DAYS = 30;
const REVIEW_LIMIT = 200;
const ACTIVITY_LIMIT = 30;

export type HomeReview = {
    id: string;
    project_id: string;
    project_name: string;
    counterparty: string | null;
    lane: string | null;
    document_id: string;
    filename: string | null;
    status: "queued" | "running" | "ready" | "done" | "failed";
    step: "lendo" | "ficha" | "playbook" | null;
    aligned: number;
    needs_review: number;
    deviates: number;
    summary: string | null;
    error: string | null;
    assignee_email: string | null;
    playbook_id: string | null;
    playbook_run_id: string | null;
    watched_folder_id: string | null;
    requester_name: string | null;
    deadline: string | null;
    notice_deadline: string | null;
    notice_days: number | null;
    term_end: string | null;
    /** The Ficha's headline: fields a person checked out of those that apply. */
    ficha: { verified: number; total: number } | null;
    /** The assignment agent's pick when nobody owns the review yet. */
    suggested_assignee: string | null;
    /** The owner's profile name, when they have one. */
    assignee_name: string | null;
    /** The request this contract came from: LEG-0142 and its id, for the link. */
    request: { id: string; code: string } | null;
    updated_at: string;
};

export type HomeDeadline = {
    project_id: string;
    project_name: string;
    counterparty: string | null;
    notice_deadline: string;
    notice_days: number | null;
    term_end: string | null;
    auto_renewal: boolean | null;
    days_left: number;
};

export type HomeSummary = {
    since: string | null;
    greeting: { reviewed: number; failed: number; notices_closing: number; ready: number };
    counters: { ready: number; mine: number; notices_30d: number; folders: number };
    reviews: HomeReview[];
    deadlines: HomeDeadline[];
    activity: (CardEvent & { project_name: string })[];
};

type ReviewRow = Pick<
    HomeReview,
    | "id"
    | "project_id"
    | "document_id"
    | "status"
    | "step"
    | "aligned"
    | "needs_review"
    | "deviates"
    | "summary"
    | "error"
    | "assignee_email"
    | "playbook_id"
    | "playbook_run_id"
    | "updated_at"
> & { version_id: string; finished_at: string | null };

type ProjectRow = {
    id: string;
    org_id: string | null;
    name: string;
    counterparty: string | null;
    lane: string | null;
    requester_name: string | null;
    deadline: string | null;
    watched_folder_id: string | null;
};

type FichaField = { status?: string; review?: { state?: string } } | null;

/**
 * "14/24 verificados", by the Ficha's own rule (contract-review module):
 * fields that do not apply are left out, and a field counts once a person
 * confirmed or corrected it.
 */
export function fichaHeadline(ficha: Record<string, FichaField> | null): { verified: number; total: number } | null {
    if (!ficha || Object.keys(ficha).length === 0) return null;
    const fields = Object.values(ficha).filter(
        (field): field is NonNullable<FichaField> => !!field && field.status !== "nao_aplicavel",
    );
    return {
        verified: fields.filter((field) => (field.review?.state ?? "pendente") !== "pendente").length,
        total: fields.length,
    };
}

/** "LEG-0142": the request number as people say it. */
export function requestCode(number: number): string {
    return `LEG-${String(number).padStart(4, "0")}`;
}

/** Postgres / PostgREST "no such table": the Ficha ships in another module's migration. */
function isMissingTable(error: unknown): boolean {
    const code = (error as { code?: string } | null)?.code;
    return code === "42P01" || code === "PGRST205";
}

/** Today's date where the legal team works, so a deadline "today" is not "past" after 21h. */
export function saoPauloDate(now: Date): string {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Sao_Paulo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(now);
}

function daysBetween(fromIso: string, toDate: string): number {
    const from = Date.parse(fromIso.slice(0, 10) + "T00:00:00Z");
    const to = Date.parse(toDate + "T00:00:00Z");
    return Math.round((to - from) / 86_400_000);
}

async function inChunks<T>(
    ids: string[],
    read: (slice: string[]) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const { data, error } = await read(ids.slice(i, i + ID_CHUNK));
        if (error) throw error;
        out.push(...((data ?? []) as T[]));
    }
    return out;
}

/** The agents whose succeeded runs count as reviewing a contract. */
export const REVIEW_AGENTS = ["revisor"] as const;

/**
 * How many distinct contracts the agents reviewed among the given cards,
 * finished in [since, until) (either end open when null): a finished automatic review
 * (contract_reviews ready or done) or a succeeded run of a review agent
 * (agent_runs). The one source for "Revisei N contratos" here and for the
 * reviewed-by-agents tile on the legal dashboard, so they never disagree.
 */
export async function countAgentReviews(
    db: Db,
    projectIds: string[],
    since: string | null,
    until: string | null = null,
): Promise<number> {
    const reviewed = new Set<string>();
    for (let i = 0; i < projectIds.length; i += ID_CHUNK) {
        const slice = projectIds.slice(i, i + ID_CHUNK);
        let runs = db
            .from("agent_runs")
            .select("project_id")
            .in("project_id", slice)
            .in("agent", [...REVIEW_AGENTS])
            .eq("status", "succeeded");
        if (since) runs = runs.gte("finished_at", since);
        if (until) runs = runs.lt("finished_at", until);
        let reviews = db
            .from("contract_reviews")
            .select("project_id")
            .in("project_id", slice)
            .in("status", ["ready", "done"]);
        if (since) reviews = reviews.gte("finished_at", since);
        if (until) reviews = reviews.lt("finished_at", until);
        for (const query of [runs, reviews]) {
            const { data, error } = await query;
            if (error) throw error;
            for (const row of (data ?? []) as { project_id: string }[]) reviewed.add(row.project_id);
        }
    }
    return reviewed.size;
}

/**
 * Builds the home screen and records this visit. `since` is when the caller
 * last opened it, so the greeting counts only what is new to them.
 */
export async function getHomeSummary(
    db: Db,
    caller: Caller,
    now: Date = new Date(),
    workspace: WorkspaceFilter = null,
): Promise<ServiceResult<HomeSummary>> {
    try {
        const since = await touchVisit(db, caller.userId, now);
        const ids = await listAccessibleProjectIds(caller.userId, caller.userEmail, db);
        const projects = await inChunks<ProjectRow>(ids, (slice) =>
            db
                .from("projects")
                .select("id, org_id, name, counterparty, lane, requester_name, deadline, watched_folder_id")
                .in("id", slice)
                .is("archived_at", null),
        ).then((rows) => rows.filter((p) => workspaceMatches(workspace, p.org_id)));
        const byId = new Map(projects.map((p) => [p.id, p]));
        const visible = projects.map((p) => p.id);

        const reviewRows = await inChunks<ReviewRow>(
            visible,
            (slice) =>
                db
                    .from("contract_reviews")
                    .select(
                        "id, project_id, document_id, version_id, status, step, aligned, needs_review, deviates, summary, error, assignee_email, playbook_id, playbook_run_id, updated_at, finished_at",
                    )
                    .in("project_id", slice)
                    .order("updated_at", { ascending: false })
                    .limit(REVIEW_LIMIT),
        );
        // One row per card: its newest review.
        reviewRows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        const latest = new Map<string, ReviewRow>();
        for (const review of reviewRows) if (!latest.has(review.project_id)) latest.set(review.project_id, review);

        const versionIds = [...latest.values()].map((r) => r.version_id);
        const versions = await inChunks<{ id: string; filename: string | null }>(versionIds, (slice) =>
            db.from("document_versions").select("id, filename").in("id", slice),
        );
        const filename = new Map(versions.map((v) => [v.id, v.filename]));

        const terms = await inChunks<{
            project_id: string;
            notice_deadline: string | null;
            notice_days: number | null;
            term_end: string | null;
            auto_renewal: boolean | null;
        }>(visible, (slice) =>
            db
                .from("contract_terms")
                .select("project_id, notice_deadline, notice_days, term_end, auto_renewal")
                .in("project_id", slice),
        );
        const termsOf = new Map(terms.map((t) => [t.project_id, t]));

        // The Ficha lives in the contract-review module's table; a database
        // without it yet shows "not filled" instead of failing the screen.
        const fichaOf = new Map<string, Record<string, FichaField> | null>();
        try {
            const fichas = await inChunks<{ project_id: string; ficha: Record<string, FichaField> | null }>(
                visible,
                (slice) => db.from("contract_fichas").select("project_id, ficha").in("project_id", slice),
            );
            for (const row of fichas) fichaOf.set(row.project_id, row.ficha);
        } catch (error) {
            if (!isMissingTable(error)) throw error;
        }

        // The request each contract came from (requests module), same fallback.
        const requestOf = new Map<string, { id: string; code: string }>();
        try {
            const requests = await inChunks<{ id: string; number: number; project_id: string }>(visible, (slice) =>
                db.from("legal_requests").select("id, number, project_id").in("project_id", slice),
            );
            for (const row of requests) requestOf.set(row.project_id, { id: row.id, code: requestCode(row.number) });
        } catch (error) {
            if (!isMissingTable(error)) throw error;
        }

        // Owners by name, not by the local part of their e-mail.
        const owners = [...new Set(reviewRows.map((r) => r.assignee_email?.toLowerCase()).filter((e): e is string => !!e))];
        const userByEmail = owners.length
            ? (await loadProfileUsersByEmail(db, { userIds: [], emails: owners })).userByEmail
            : new Map<string, { display_name: string | null }>();

        // The assignment agent suggests, a person confirms: its latest pick per card.
        const suggestionRows = await inChunks<{ project_id: string; after: unknown }>(visible, (slice) =>
            db
                .from("card_events")
                .select("project_id, after, at")
                .in("project_id", slice)
                .eq("action", "assignee.suggested")
                .order("at", { ascending: false })
                .limit(ID_CHUNK),
        );
        const suggestions = new Map<string, string>();
        for (const row of suggestionRows) {
            const after = row.after as { email?: unknown; name?: unknown } | null;
            const pick = typeof after?.name === "string" ? after.name : typeof after?.email === "string" ? after.email : null;
            if (pick && !suggestions.has(row.project_id)) suggestions.set(row.project_id, pick);
        }

        const reviews: HomeReview[] = [...latest.values()].map((r) => {
            const card = byId.get(r.project_id)!;
            const t = termsOf.get(r.project_id);
            return {
                id: r.id,
                project_id: r.project_id,
                project_name: card.name,
                counterparty: card.counterparty,
                lane: card.lane,
                document_id: r.document_id,
                filename: filename.get(r.version_id) ?? null,
                status: r.status,
                step: r.step,
                aligned: r.aligned,
                needs_review: r.needs_review,
                deviates: r.deviates,
                summary: r.summary,
                error: r.error,
                assignee_email: r.assignee_email?.toLowerCase() ?? null,
                playbook_id: r.playbook_id,
                playbook_run_id: r.playbook_run_id,
                watched_folder_id: card.watched_folder_id,
                requester_name: card.requester_name,
                deadline: card.deadline,
                notice_deadline: t?.notice_deadline ?? null,
                notice_days: t?.notice_days ?? null,
                term_end: t?.term_end ?? null,
                ficha: fichaHeadline(fichaOf.get(r.project_id) ?? null),
                suggested_assignee: r.assignee_email ? null : (suggestions.get(r.project_id) ?? null),
                assignee_name: r.assignee_email
                    ? (userByEmail.get(r.assignee_email.toLowerCase())?.display_name ?? null)
                    : null,
                request: requestOf.get(r.project_id) ?? null,
                updated_at: r.updated_at,
            };
        });

        const today = saoPauloDate(now);
        const deadlines: HomeDeadline[] = terms
            .filter((t) => t.notice_deadline)
            .map((t) => {
                const card = byId.get(t.project_id)!;
                return {
                    project_id: t.project_id,
                    project_name: card.name,
                    counterparty: card.counterparty,
                    notice_deadline: t.notice_deadline!,
                    notice_days: t.notice_days,
                    term_end: t.term_end,
                    auto_renewal: t.auto_renewal,
                    days_left: daysBetween(today, t.notice_deadline!),
                };
            })
            .filter((d) => d.days_left >= 0 && d.days_left <= 90)
            .sort((a, b) => a.days_left - b.days_left);

        const me = caller.userEmail?.toLowerCase() ?? null;
        const folders = new Set(projects.map((p) => p.watched_folder_id).filter(Boolean));
        const { count: ownFolders, error: foldersError } = await db
            .from("watched_folders")
            .select("id", { count: "exact", head: true })
            .eq("created_by", caller.userId)
            .eq("active", true);
        if (foldersError) throw foldersError;

        const sinceMs = since ? Date.parse(since) : 0;
        const newSince = (iso: string | null) => !!iso && Date.parse(iso) > sinceMs;
        const reviewed = await countAgentReviews(db, visible, since);
        const failed = reviewRows.filter((r) => r.status === "failed" && newSince(r.updated_at)).length;

        const activityRows = await inChunks<CardEvent>(visible, (slice) =>
            db
                .from("card_events")
                .select(
                    "id, project_id, at, actor_type, actor_id, actor_name, on_behalf_of, action, field, before, after, run_id, source",
                )
                .in("project_id", slice)
                .order("at", { ascending: false })
                .limit(ACTIVITY_LIMIT),
        );
        activityRows.sort((a, b) => b.at.localeCompare(a.at));
        const activity = activityRows.slice(0, ACTIVITY_LIMIT).map((event) => ({
            ...event,
            project_name: byId.get(event.project_id)?.name ?? "",
        }));

        const notices30 = deadlines.filter((d) => d.days_left <= NOTICE_WINDOW_DAYS).length;
        return ok({
            since,
            greeting: {
                reviewed,
                failed,
                notices_closing: notices30,
                ready: reviews.filter((r) => r.status === "ready").length,
            },
            counters: {
                ready: reviews.filter((r) => r.status === "ready").length,
                mine: reviews.filter((r) => me && r.assignee_email === me && r.status !== "done").length,
                notices_30d: notices30,
                folders: Math.max(folders.size, ownFolders ?? 0),
            },
            reviews,
            deadlines,
            activity,
        });
    } catch (error) {
        return internalFailure(error);
    }
}

/**
 * Moves the caller's last visit forward and returns the one before, so a
 * reload in the same session keeps counting from the same point: the visit
 * only advances once an hour has passed.
 */
async function touchVisit(db: Db, userId: string, now: Date): Promise<string | null> {
    const { data, error } = await db
        .from("home_visits")
        .select("previous_seen_at, last_seen_at")
        .eq("user_id", userId)
        .maybeSingle();
    if (error) throw error;
    const visit = data as { previous_seen_at: string | null; last_seen_at: string } | null;
    const nowIso = now.toISOString();
    if (!visit) {
        const { error: insertError } = await db
            .from("home_visits")
            .insert({ user_id: userId, previous_seen_at: null, last_seen_at: nowIso });
        if (insertError) throw insertError;
        return null;
    }
    if (now.getTime() - Date.parse(visit.last_seen_at) < 60 * 60 * 1000) {
        return visit.previous_seen_at;
    }
    const { error: updateError } = await db
        .from("home_visits")
        .update({ previous_seen_at: visit.last_seen_at, last_seen_at: nowIso })
        .eq("user_id", userId);
    if (updateError) throw updateError;
    return visit.last_seen_at;
}
