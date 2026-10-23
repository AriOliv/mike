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
    requireProjectView,
    type Caller,
} from "./contracts.shared";
import { saoPauloDate } from "./contracts.home";

const MARKS = ["recorrente", "critico", "tarefa"] as const;
export const OBLIGATION_STATUSES = ["aberto", "feito", "dispensado"] as const;
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];

const COLUMNS =
    "id, project_id, title, mark, due_date, done, note, source_quote, owner_email, alert_days, kind, status, created_at, updated_at";

/** Warn 30 days before the end unless the deadline says otherwise. */
export const DEFAULT_ALERT_DAYS = 30;

function isEmail(value: string): boolean {
    const at = value.indexOf("@");
    return at > 0 && at === value.lastIndexOf("@") && value.indexOf(".", at) > at + 1 && !/[\s,()]/.test(value) && value.length <= 254;
}

/**
 * The e-mails of the people who may own a deadline (the legal team), when the
 * deployment has one: an owner outside it would never be warned, silently.
 */
export type OwnerOptions = { members?: string[] };

/** The owner: an e-mail, lower-cased; null clears it. */
function parseOwner(
    value: unknown,
    options: OwnerOptions = {},
): { ok: true; value: string | null } | { ok: false; detail: string } {
    if (value === null || value === "") return { ok: true, value: null };
    const text = normalizeString(value)?.toLowerCase();
    if (!text || !isEmail(text)) return { ok: false, detail: "Informe o e-mail de quem cuida do prazo." };
    if (options.members && !options.members.includes(text)) {
        return { ok: false, detail: "Não encontrei essa pessoa no time do Legal." };
    }
    return { ok: true, value: text };
}

function parseAlertDays(value: unknown): { ok: true; value: number } | { ok: false; detail: string } {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 365) return { ok: true, value };
    return { ok: false, detail: "A antecedência do alerta é um número de dias entre 0 e 365." };
}

/** A deadline is mine when I made it or when I am its owner. */
function mineFilter(caller: Caller): string {
    const email = caller.userEmail?.trim().toLowerCase();
    const own = `user_id.eq.${caller.userId}`;
    return email && isEmail(email) ? `${own},owner_email.eq.${email}` : own;
}

export type Obligation = Record<string, unknown> & { id: string };

export async function listObligations(
    db: Db,
    caller: Caller,
    query: { from?: unknown; to?: unknown; include_done?: unknown },
): Promise<ServiceResult<Obligation[]>> {
    let q = db
        .from("obligations")
        .select(COLUMNS + ", projects(name, counterparty, lane)")
        .or(mineFilter(caller))
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
    options: OwnerOptions = {},
): Promise<ServiceResult<Obligation>> {
    const title = normalizeString(body.title);
    const dueDate = body.due_date;
    if (!title) return failure("validation", "title is required");
    if (!isIsoDate(dueDate)) return failure("validation", "due_date must be YYYY-MM-DD");
    const mark = body.mark ?? "recorrente";
    if (!MARKS.includes(mark as (typeof MARKS)[number])) {
        return failure("validation", `mark must be one of: ${MARKS.join(", ")}`);
    }

    const owner = "owner_email" in body ? parseOwner(body.owner_email, options) : ({ ok: true, value: null } as const);
    if (!owner.ok) return failure("validation", owner.detail);
    const alertDays = "alert_days" in body ? parseAlertDays(body.alert_days) : ({ ok: true, value: DEFAULT_ALERT_DAYS } as const);
    if (!alertDays.ok) return failure("validation", alertDays.detail);

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
            owner_email: owner.value,
            alert_days: alertDays.value,
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
    options: OwnerOptions = {},
): Promise<ServiceResult<Obligation>> {
    const patch: Record<string, unknown> = {};
    // `status` says where a deadline stands; `done` follows it, so the radar
    // and the calendar mirror keep reading one boolean. The radar's own tick
    // sends only `done`, which maps onto feito / aberto.
    if ("status" in body) {
        if (!OBLIGATION_STATUSES.includes(body.status as ObligationStatus)) {
            return failure("validation", "O status do prazo é aberto, feito ou dispensado.");
        }
        patch.status = body.status;
        patch.done = body.status !== "aberto";
    } else if ("done" in body) {
        patch.done = !!body.done;
        patch.status = body.done ? "feito" : "aberto";
    }
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
    if ("owner_email" in body) {
        const owner = parseOwner(body.owner_email, options);
        if (!owner.ok) return failure("validation", owner.detail);
        patch.owner_email = owner.value;
    }
    if ("alert_days" in body) {
        const alertDays = parseAlertDays(body.alert_days);
        if (!alertDays.ok) return failure("validation", alertDays.detail);
        patch.alert_days = alertDays.value;
    }

    if (Object.keys(patch).length === 0) return failure("validation", "Nothing to update");
    patch.updated_at = new Date().toISOString();

    const { data, error } = await db
        .from("obligations")
        .update(patch)
        .eq("id", id)
        .or(mineFilter(caller))
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

export type ObligationAlert = Obligation & { days_left: number };

/**
 * The deadlines asking for attention from this person today: theirs (made by
 * them with no other owner, or owned by them), not done, whose warning window
 * has opened (due date minus `alert_days`) — overdue ones included. Computed
 * on read, so a changed owner or lead time takes effect at once.
 */
export async function listObligationAlerts(
    db: Db,
    caller: Caller,
    now: Date = new Date(),
): Promise<ServiceResult<ObligationAlert[]>> {
    const today = saoPauloDate(now);
    const { data, error } = await db
        .from("obligations")
        .select(COLUMNS + ", projects(name, counterparty, lane)")
        .or(mineFilter(caller))
        .eq("done", false)
        .order("due_date", { ascending: true });
    if (error) return internalFailure(error);
    const email = caller.userEmail?.trim().toLowerCase() ?? null;
    const alerts = ((data ?? []) as unknown as (Obligation & { due_date: string; alert_days: number; owner_email: string | null; user_id?: string })[])
        // Owned by someone else (made by me, handed on): theirs to be warned.
        .filter((row) => !row.owner_email || row.owner_email === email)
        .map((row) => ({ ...row, days_left: daysBetween(today, row.due_date) }))
        .filter((row) => row.days_left <= row.alert_days);
    return ok(alerts as ObligationAlert[]);
}

function daysBetween(from: string, to: string): number {
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export type ContractAlert = Obligation & { days_left: number };

/**
 * Every deadline of one contract, whoever made it or owns it: opening the
 * contract is what gives the right to see them (view access), and the tab
 * shows them all, open first, then by date. Done and dismissed ones stay, as
 * the contract's history of deadlines.
 */
export async function listContractAlerts(
    db: Db,
    caller: Caller,
    projectId: string,
    now: Date = new Date(),
): Promise<ServiceResult<ContractAlert[]>> {
    const access = await requireProjectView(db, caller, projectId);
    if (!access.ok) return access;
    const { data, error } = await db
        .from("obligations")
        .select(COLUMNS)
        .eq("project_id", projectId)
        .order("due_date", { ascending: true });
    if (error) return internalFailure(error);
    const today = saoPauloDate(now);
    const rows = ((data ?? []) as unknown as (Obligation & { due_date: string; status: string })[])
        .map((row) => ({ ...row, days_left: daysBetween(today, row.due_date) }))
        // Open first; within a group, by date (the query already ordered it).
        .sort((a, b) => Number(a.status !== "aberto") - Number(b.status !== "aberto"));
    return ok(rows as ContractAlert[]);
}

const ICS_STATUS: Record<string, string> = { aberto: "CONFIRMED", feito: "CONFIRMED", dispensado: "CANCELLED" };

function icsText(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function icsDate(date: string): string {
    return date.replace(/-/g, "");
}

function nextDate(date: string): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * One deadline as an iCalendar file, for "criar evento": it opens in Google
 * Calendar, Outlook or Apple Calendar without any credential here. An
 * all-day event on the due date, with an alarm `alert_days` before it.
 */
export async function obligationIcs(
    db: Db,
    caller: Caller,
    obligationId: string,
    now: Date = new Date(),
): Promise<ServiceResult<{ filename: string; body: string }>> {
    const { data, error } = await db
        .from("obligations")
        .select(COLUMNS + ", projects(name, counterparty)")
        .eq("id", obligationId)
        .maybeSingle();
    if (error) return internalFailure(error);
    const row = data as unknown as
        | (Obligation & {
              title: string;
              due_date: string;
              note: string | null;
              source_quote: string | null;
              alert_days: number;
              status: string;
              project_id: string | null;
              projects?: { name: string; counterparty: string | null } | null;
          })
        | null;
    if (!row) return failure("not_found", "Não encontrei este prazo.");
    // Only whoever may see its contract, or whoever made or owns it.
    if (row.project_id) {
        const access = await requireProjectView(db, caller, row.project_id);
        if (!access.ok) return failure("not_found", "Não encontrei este prazo.");
    } else {
        const mine = await db.from("obligations").select("id").eq("id", obligationId).or(mineFilter(caller)).maybeSingle();
        if (mine.error) return internalFailure(mine.error);
        if (!mine.data) return failure("not_found", "Não encontrei este prazo.");
    }
    const contract = row.projects?.counterparty || row.projects?.name || null;
    const description = [contract ? `Contrato: ${contract}` : null, row.note, row.source_quote ? `Trecho: ${row.source_quote}` : null]
        .filter(Boolean)
        .join("\n");
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Mike//Prazos//PT",
        "CALSCALE:GREGORIAN",
        "BEGIN:VEVENT",
        `UID:${obligationId}@mike`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${icsDate(row.due_date)}`,
        `DTEND;VALUE=DATE:${nextDate(row.due_date)}`,
        `SUMMARY:${icsText(row.title)}`,
        ...(description ? [`DESCRIPTION:${icsText(description)}`] : []),
        `STATUS:${ICS_STATUS[row.status] ?? "CONFIRMED"}`,
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${icsText(row.title)}`,
        `TRIGGER:-P${Math.max(0, row.alert_days)}D`,
        "END:VALARM",
        "END:VEVENT",
        "END:VCALENDAR",
    ];
    return ok({ filename: `prazo-${row.due_date}.ics`, body: lines.join("\r\n") + "\r\n" });
}
