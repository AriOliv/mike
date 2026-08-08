// Notion mirror of the contract pipeline.
//
// Server-side only: one internal-integration token in the environment, no
// per-user OAuth. The app owns its database — it creates "Pipeline — Mike"
// under the shared page (NOTION_PARENT_ID), or uses that id directly when it
// already points at a database — and keeps one card per pipeline project,
// upserted by the ProjectId property so a re-sync updates instead of piling up.
//
// Best-effort throughout: Notion being down or misconfigured logs and moves on,
// it never breaks the API.
import { createServerSupabase } from "./supabase";

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

// Card properties besides the title. Name -> Notion schema definition.
const SCHEMA: Record<string, unknown> = {
    Counterparty: { rich_text: {} },
    Lane: {
        select: {
            options: [
                { name: "entrada" },
                { name: "triagem" },
                { name: "revisao" },
                { name: "negociacao" },
                { name: "assinatura" },
            ],
        },
    },
    Risk: {
        select: {
            options: [{ name: "critico" }, { name: "atencao" }, { name: "ok" }],
        },
    },
    Requester: { rich_text: {} },
    Updated: { date: {} },
    "Open in app": { url: {} },
    ProjectId: { rich_text: {} },
};

export function notionEnabled(): boolean {
    return !!(process.env.NOTION_TOKEN?.trim() && process.env.NOTION_PARENT_ID?.trim());
}

function headers(): Record<string, string> {
    return {
        Authorization: `Bearer ${process.env.NOTION_TOKEN?.trim()}`,
        "Notion-Version": VERSION,
        "Content-Type": "application/json",
    };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req(
    method: string,
    path: string,
    body?: unknown,
): Promise<Record<string, unknown>> {
    let response = await fetch(`${API}${path}`, {
        method,
        headers: headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 429) {
        // Notion asks for a wait rather than a retry storm.
        await sleep(Number(response.headers.get("Retry-After") ?? "1") * 1000);
        response = await fetch(`${API}${path}`, {
            method,
            headers: headers(),
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    }
    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`notion ${method} ${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
    }
    return (await response.json()) as Record<string, unknown>;
}

// ── settings kv ─────────────────────────────────────────────────────────────
type Db = ReturnType<typeof createServerSupabase>;

async function getSetting(db: Db, key: string): Promise<string | null> {
    const { data } = await db.from("app_settings").select("value").eq("key", key).maybeSingle();
    return (data as { value?: string } | null)?.value ?? null;
}

async function setSetting(db: Db, key: string, value: string): Promise<void> {
    await db
        .from("app_settings")
        .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
}

// ── database resolution ─────────────────────────────────────────────────────
function titleProp(meta: Record<string, unknown>): string {
    const props = (meta.properties ?? {}) as Record<string, { type?: string }>;
    for (const [name, p] of Object.entries(props)) {
        if (p?.type === "title") return name;
    }
    return "Name";
}

async function resolveDatabase(db: Db): Promise<{ id: string; titleProp: string }> {
    const parent = process.env.NOTION_PARENT_ID!.trim();
    const cached = await getSetting(db, "notion_database_id");
    if (cached) {
        const meta = await req("GET", `/databases/${cached}`);
        return { id: cached, titleProp: titleProp(meta) };
    }
    // The parent may already be a database — use it as-is.
    try {
        const meta = await req("GET", `/databases/${parent}`);
        await setSetting(db, "notion_database_id", parent);
        return { id: parent, titleProp: titleProp(meta) };
    } catch {
        // otherwise it is a page: create the database under it
    }
    const meta = await req("POST", "/databases", {
        parent: { type: "page_id", page_id: parent },
        title: [{ type: "text", text: { content: "Pipeline — Mike" } }],
        properties: { Name: { title: {} }, ...SCHEMA },
    });
    const id = meta.id as string;
    await setSetting(db, "notion_database_id", id);
    console.log(`[notion] created database ${id}`);
    return { id, titleProp: "Name" };
}

async function ensureSchema(databaseId: string, meta: Record<string, unknown>): Promise<void> {
    const existing = (meta.properties ?? {}) as Record<string, unknown>;
    const missing: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(SCHEMA)) {
        if (!(name in existing)) missing[name] = def;
    }
    if (Object.keys(missing).length > 0) {
        await req("PATCH", `/databases/${databaseId}`, { properties: missing });
    }
}

// ── card shape ──────────────────────────────────────────────────────────────
type Card = {
    id: string;
    name: string;
    counterparty: string | null;
    lane: string | null;
    risk_level: string | null;
    requester_name: string | null;
    updated_at: string | null;
};

const rt = (v: string | null) => ({
    rich_text: v ? [{ type: "text", text: { content: v.slice(0, 1900) } }] : [],
});
const sel = (v: string | null) => ({ select: v ? { name: v } : null });

function cardProps(card: Card, titleKey: string): Record<string, unknown> {
    const base = (process.env.APP_BASE_URL?.trim() || "http://localhost:3000").replace(/\/$/, "");
    return {
        [titleKey]: {
            title: [{ type: "text", text: { content: (card.name || "(untitled)").slice(0, 1900) } }],
        },
        Counterparty: rt(card.counterparty),
        Lane: sel(card.lane),
        Risk: sel(card.risk_level),
        Requester: rt(card.requester_name),
        Updated: {
            date: { start: (card.updated_at ?? new Date().toISOString()).slice(0, 10) },
        },
        "Open in app": { url: `${base}/projects/${card.id}` },
        ProjectId: rt(card.id),
    };
}

type UpsertedPage = { id: string; url: string | null };

async function upsert(
    databaseId: string,
    titleKey: string,
    card: Card,
): Promise<UpsertedPage> {
    const query = await req("POST", `/databases/${databaseId}/query`, {
        filter: { property: "ProjectId", rich_text: { equals: card.id } },
        page_size: 1,
    });
    const results = (query.results ?? []) as { id: string }[];
    const properties = cardProps(card, titleKey);
    const page =
        results.length > 0
            ? await req("PATCH", `/pages/${results[0].id}`, { properties })
            : await req("POST", "/pages", {
                  parent: { database_id: databaseId },
                  properties,
              });
    return { id: page.id as string, url: (page.url as string) ?? null };
}

/** Link to the mirrored board, or null when the mirror has never run. */
export async function notionBoardUrl(): Promise<string | null> {
    if (!notionEnabled()) return null;
    const id = await getSetting(createServerSupabase(), "notion_database_id");
    return id ? `https://www.notion.so/${id.replace(/-/g, "")}` : null;
}

export type NotionSyncSummary = {
    enabled: boolean;
    synced?: number;
    errors?: number;
    database_id?: string;
    detail?: string;
};

/** Mirror pipeline projects changed since the last run (all of them the first time). */
export async function syncPipelineToNotion(): Promise<NotionSyncSummary> {
    if (!notionEnabled()) return { enabled: false };
    const db = createServerSupabase();
    const summary: NotionSyncSummary = { enabled: true, synced: 0, errors: 0 };
    try {
        const { id: databaseId, titleProp: titleKey } = await resolveDatabase(db);
        summary.database_id = databaseId;
        await ensureSchema(databaseId, await req("GET", `/databases/${databaseId}`));

        const last = await getSetting(db, "notion_last_sync");
        let query = db
            .from("projects")
            .select("id, name, counterparty, lane, risk_level, requester_name, updated_at")
            .not("lane", "is", null)
            .order("updated_at", { ascending: true });
        if (last) query = query.gte("updated_at", last);

        const startedAt = new Date().toISOString();
        const { data, error } = await query;
        if (error) throw new Error(error.message);

        for (const card of (data ?? []) as unknown as Card[]) {
            try {
                const page = await upsert(databaseId, titleKey, card);
                // Remember where the card landed so the app can link to it.
                // Writing updated_at here would re-select the row on the next
                // run, so the sync would never settle — leave it untouched.
                await db
                    .from("projects")
                    .update({ notion_page_id: page.id, notion_url: page.url })
                    .eq("id", card.id);
                summary.synced = (summary.synced ?? 0) + 1;
            } catch (e) {
                summary.errors = (summary.errors ?? 0) + 1;
                console.warn(`[notion] card ${card.id} failed: ${(e as Error).message}`);
            }
            await sleep(340); // ~3 requests/second, Notion's published limit
        }
        await setSetting(db, "notion_last_sync", startedAt);
        console.log(`[notion] sync: ${JSON.stringify(summary)}`);
        return summary;
    } catch (e) {
        // Never let a mirror problem surface as an API failure.
        console.warn(`[notion] sync aborted: ${(e as Error).message}`);
        return { ...summary, errors: (summary.errors ?? 0) + 1, detail: (e as Error).message };
    }
}

/** Periodic mirror. Started at boot only when the integration is configured. */
export function startNotionSyncer(): void {
    const seconds = Math.max(60, Number(process.env.NOTION_SYNC_SECONDS ?? 300));
    const tick = async () => {
        try {
            await syncPipelineToNotion();
        } catch (e) {
            console.warn(`[notion] syncer: ${(e as Error).message}`);
        }
    };
    void tick();
    setInterval(tick, seconds * 1000).unref();
}
