// Deadline radar — obligations with a calendar date, optionally tied to a
// pipeline project. Dates come from the contract text (see source_quote), so a
// deadline can always be traced back to the clause that created it.

import type { Db } from "../../lib/supabase";
import { removeCalendarEvent } from "../../lib/gcal";
import {
    failure,
    internalFailure,
    ok,
    type ServiceResult,
} from "../../lib/serviceResult";
import {
    isIsoDate,
    normalizeString,
    requireProjectEdit,
    type Caller,
} from "./contracts.shared";

const MARKS = ["recorrente", "critico", "tarefa"] as const;

const COLUMNS =
    "id, project_id, title, mark, due_date, done, note, source_quote, created_at, updated_at";

export type Obligation = Record<string, unknown> & { id: string };

export async function listObligations(
    db: Db,
    caller: Caller,
    query: { from?: unknown; to?: unknown; include_done?: unknown },
): Promise<ServiceResult<Obligation[]>> {
    let q = db
        .from("obligations")
        .select(COLUMNS + ", projects(name, counterparty, lane)")
        .eq("user_id", caller.userId)
        .order("due_date", { ascending: true });
    if (isIsoDate(query.from)) q = q.gte("due_date", query.from);
    if (isIsoDate(query.to)) q = q.lte("due_date", query.to);
    if (query.include_done !== "true") q = q.eq("done", false);

    const { data, error } = await q;
    if (error) return internalFailure(error);
    return ok((data ?? []) as unknown as Obligation[]);
}

export async function createObligation(
    db: Db,
    caller: Caller,
    body: Record<string, unknown>,
): Promise<ServiceResult<Obligation>> {
    const title = normalizeString(body.title);
    const dueDate = body.due_date;
    if (!title) return failure("validation", "title is required");
    if (!isIsoDate(dueDate)) return failure("validation", "due_date must be YYYY-MM-DD");
    const mark = body.mark ?? "recorrente";
    if (!MARKS.includes(mark as (typeof MARKS)[number])) {
        return failure("validation", `mark must be one of: ${MARKS.join(", ")}`);
    }

    const projectId = normalizeString(body.project_id);
    if (projectId) {
        const access = await requireProjectEdit(db, caller, projectId);
        if (!access.ok) return access;
    }

    const { data, error } = await db
        .from("obligations")
        .insert({
            user_id: caller.userId,
            project_id: projectId,
            title,
            mark,
            due_date: dueDate.trim(),
            note: normalizeString(body.note),
            source_quote: normalizeString(body.source_quote),
        })
        .select(COLUMNS)
        .single();
    if (error) return internalFailure(error);
    return ok(data as unknown as Obligation);
}

/** Tick it off, reschedule, or edit. */
export async function updateObligation(
    db: Db,
    caller: Caller,
    id: string,
    body: Record<string, unknown>,
): Promise<ServiceResult<Obligation>> {
    const patch: Record<string, unknown> = {};
    if ("done" in body) patch.done = !!body.done;
    if ("title" in body) {
        const title = normalizeString(body.title);
        if (!title) return failure("validation", "title cannot be empty");
        patch.title = title;
    }
    if ("due_date" in body) {
        if (!isIsoDate(body.due_date)) return failure("validation", "due_date must be YYYY-MM-DD");
        patch.due_date = body.due_date.trim();
    }
    if ("mark" in body) {
        if (!MARKS.includes(body.mark as (typeof MARKS)[number])) {
            return failure("validation", `mark must be one of: ${MARKS.join(", ")}`);
        }
        patch.mark = body.mark;
    }
    if ("note" in body) patch.note = normalizeString(body.note);

    if (Object.keys(patch).length === 0) return failure("validation", "Nothing to update");
    patch.updated_at = new Date().toISOString();

    const { data, error } = await db
        .from("obligations")
        .update(patch)
        .eq("id", id)
        .eq("user_id", caller.userId)
        .select(COLUMNS)
        .maybeSingle();
    if (error) return internalFailure(error);
    if (!data) return failure("not_found", "Obligation not found");
    return ok(data as unknown as Obligation);
}

export async function deleteObligation(
    db: Db,
    caller: Caller,
    id: string,
): Promise<ServiceResult<null>> {
    const { data, error } = await db
        .from("obligations")
        .delete()
        .eq("id", id)
        .eq("user_id", caller.userId)
        .select("id");
    if (error) return internalFailure(error);
    // Best-effort: the deadline is gone either way, the event should follow.
    // Only for a row this caller really deleted, and by the stored id.
    for (const row of (data ?? []) as { id: string }[]) void removeCalendarEvent(row.id);
    return ok(null);
}
