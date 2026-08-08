// Google Calendar mirror of the deadline radar.
//
// Every obligation becomes an all-day event on a shared calendar, so deadlines
// show up where the team already looks. The event id is derived from the
// obligation id, which makes the write an upsert: re-running never duplicates,
// and rescheduling a deadline moves the existing event instead of adding one.
import { createServerSupabase } from "./supabase";
import { SCOPES, googleApi, serviceAccountConfigured } from "./google";

const BASE = "https://www.googleapis.com/calendar/v3";

export function calendarEnabled(): boolean {
    return !!(serviceAccountConfigured() && process.env.GOOGLE_CALENDAR_ID?.trim());
}

function calendarId(): string {
    return encodeURIComponent(process.env.GOOGLE_CALENDAR_ID!.trim());
}

/** Google event ids allow a-v and 0-9 only, so a UUID's hex fits once the
 *  dashes are gone. Deterministic, so the same obligation always maps to the
 *  same event. */
function eventId(obligationId: string): string {
    return obligationId.replace(/-/g, "").toLowerCase();
}

function nextDay(date: string): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

const MARK_PREFIX: Record<string, string> = {
    critico: "🔴",
    recorrente: "🔵",
    tarefa: "⚪",
};

type Row = {
    id: string;
    title: string;
    mark: string;
    due_date: string;
    done: boolean;
    note: string | null;
    source_quote: string | null;
    project_id: string | null;
    projects: { name: string; counterparty: string | null } | null;
};

function eventBody(row: Row) {
    const base = (process.env.APP_BASE_URL?.trim() || "http://localhost:3000").replace(/\/$/, "");
    const contract = row.projects?.counterparty || row.projects?.name;
    const lines: string[] = [];
    if (contract) lines.push(`Contrato: ${contract}`);
    if (row.source_quote) lines.push(`\nCláusula:\n"${row.source_quote}"`);
    if (row.note) lines.push(`\n${row.note}`);
    if (row.project_id) lines.push(`\n${base}/projects/${row.project_id}`);

    return {
        summary: `${MARK_PREFIX[row.mark] ?? ""} ${row.title}`.trim(),
        description: lines.join("\n"),
        // All-day event: Google treats `end` as exclusive.
        start: { date: row.due_date },
        end: { date: nextDay(row.due_date) },
        // A completed deadline stays on the calendar as a record, greyed out by
        // being marked transparent rather than deleted.
        transparency: row.done ? "transparent" : "opaque",
        status: "confirmed",
    };
}

/**
 * Write one obligation's event.
 *
 * Calendar's PUT is an update and 404s when the event does not exist yet, so a
 * first write has to be an insert carrying our own id. Update first, because
 * after the initial run almost every write is an update.
 */
async function upsertEvent(row: Row): Promise<void> {
    const id = eventId(row.id);
    const body = eventBody(row);
    try {
        await googleApi(SCOPES.calendar, `${BASE}/calendars/${calendarId()}/events/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    } catch (e) {
        if (!/HTTP 404/.test((e as Error).message)) throw e;
        await googleApi(SCOPES.calendar, `${BASE}/calendars/${calendarId()}/events`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, id }),
        });
    }
}

export type CalendarSyncSummary = {
    enabled: boolean;
    synced?: number;
    errors?: number;
    calendar_id?: string;
    detail?: string;
};

/** Mirror every obligation onto the calendar. Idempotent by construction. */
export async function syncObligationsToCalendar(limit = 500): Promise<CalendarSyncSummary> {
    if (!calendarEnabled()) return { enabled: false };
    const db = createServerSupabase();
    const summary: CalendarSyncSummary = {
        enabled: true,
        synced: 0,
        errors: 0,
        calendar_id: process.env.GOOGLE_CALENDAR_ID,
    };
    try {
        const { data, error } = await db
            .from("obligations")
            .select(
                "id, title, mark, due_date, done, note, source_quote, project_id, projects(name, counterparty)",
            )
            .order("due_date", { ascending: true })
            .limit(limit);
        if (error) throw new Error(error.message);

        for (const row of (data ?? []) as unknown as Row[]) {
            try {
                await upsertEvent(row);
                summary.synced = (summary.synced ?? 0) + 1;
            } catch (e) {
                summary.errors = (summary.errors ?? 0) + 1;
                console.warn(`[calendar] obligation ${row.id} failed: ${(e as Error).message}`);
            }
        }
        console.log(`[calendar] sync: ${JSON.stringify(summary)}`);
        return summary;
    } catch (e) {
        console.warn(`[calendar] sync aborted: ${(e as Error).message}`);
        return { ...summary, errors: (summary.errors ?? 0) + 1, detail: (e as Error).message };
    }
}

/** Remove an obligation's event — used when a deadline is deleted. */
export async function removeCalendarEvent(obligationId: string): Promise<void> {
    if (!calendarEnabled()) return;
    try {
        await googleApi(
            SCOPES.calendar,
            `${BASE}/calendars/${calendarId()}/events/${eventId(obligationId)}`,
            { method: "DELETE" },
        );
    } catch (e) {
        // A missing event is the desired end state anyway.
        console.warn(`[calendar] delete ${obligationId}: ${(e as Error).message}`);
    }
}

/** Periodic mirror. Started at boot only when the integration is configured. */
export function startCalendarSyncer(): void {
    const seconds = Math.max(60, Number(process.env.CALENDAR_SYNC_SECONDS ?? 300));
    const tick = async () => {
        try {
            await syncObligationsToCalendar();
        } catch (e) {
            console.warn(`[calendar] syncer: ${(e as Error).message}`);
        }
    };
    void tick();
    setInterval(tick, seconds * 1000).unref();
}
