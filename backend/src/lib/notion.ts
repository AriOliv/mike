// Notion mirror of the contract pipeline.
//
// Server-side only: one internal-integration token in the environment, no
// per-user OAuth. The app owns its database — it creates "Pipeline — Mike"
// under the shared page (NOTION_PARENT_ID), or uses that id directly when it
// already points at a database — and keeps one card per pipeline project,
// upserted by the ProjectId property so a re-sync updates instead of piling up.
//
// The board is task-shaped: besides the contract fields (Contraparte, Risco,
// Renovação, Tipo — all derived, mirrored one-way) it carries the task fields
// the legal team tracks (Status, Responsável, Prioridade, Prazo, Conclusão).
// Phase 1 pushes everything one-way; the write-back is Phase 2.
//
// Best-effort throughout: Notion being down or misconfigured logs and moves on,
// it never breaks the API.
import { createServerSupabase } from "./supabase";

const API = "https://api.notion.com/v1";

// The board is read by the legal team, so lanes show their own vocabulary
// rather than the storage slug.
export const LANE_LABELS: Record<string, string> = {
    entrada: "Entrada",
    triagem: "Triagem",
    revisao: "Revisão",
    negociacao: "Negociação",
    assinatura: "Assinatura",
    arquivado: "Arquivado",
};
const VERSION = "2022-06-28";

// Property names as they exist on the team's board. The mirror writes to the
// board people already read rather than a parallel set of its own.
const PROP = {
    etapa: "Etapa",
    // "Progresso", not "Status": Notion databases carry a built-in "Status"
    // property of the native `status` type, whose options cannot be created or
    // edited through the API. A select we own, under a distinct name, lets the
    // mirror manage the four states (incl. "Bloqueado") the team wants.
    status: "Progresso",
    responsavel: "Responsável",
    prioridade: "Prioridade",
    prazo: "Prazo",
    conclusao: "Data de conclusão",
    contraparte: "Contraparte",
    solicitante: "Solicitante",
    risco: "Risco",
    tipo: "Tipo",
    renovacao: "Renovação",
    atualizado: "Atualizado",
    abrirNoApp: "Abrir no app",
    projectId: "ProjectId",
} as const;

const RISK_LABELS: Record<string, string> = {
    critico: "Risco crítico",
    atencao: "Atenção",
    ok: "OK",
};

// Status is a plain select, not Notion's native "status" property type: that
// type cannot be created or edited through the API, so a select carrying the
// same four states is the only option a server-side mirror can manage.
const STATUS_LABELS: Record<string, string> = {
    a_fazer: "A fazer",
    em_andamento: "Em andamento",
    bloqueado: "Bloqueado",
    concluido: "Concluído",
};

const PRIORITY_LABELS: Record<string, string> = {
    baixa: "Baixa",
    media: "Média",
    alta: "Alta",
};

// Card properties besides the title. Name -> Notion schema definition. New
// options on a select are added by ensureSchema as they appear (Tipo has no
// fixed vocabulary yet), so this only needs the ones we know up front.
const SCHEMA: Record<string, unknown> = {
    [PROP.contraparte]: { rich_text: {} },
    [PROP.etapa]: {
        select: { options: Object.values(LANE_LABELS).map((name) => ({ name })) },
    },
    [PROP.status]: {
        select: { options: Object.values(STATUS_LABELS).map((name) => ({ name })) },
    },
    [PROP.responsavel]: { people: {} },
    [PROP.prioridade]: {
        select: { options: Object.values(PRIORITY_LABELS).map((name) => ({ name })) },
    },
    [PROP.prazo]: { date: {} },
    [PROP.conclusao]: { date: {} },
    [PROP.risco]: {
        select: { options: Object.values(RISK_LABELS).map((name) => ({ name })) },
    },
    [PROP.tipo]: { select: { options: [] } },
    [PROP.renovacao]: { date: {} },
    [PROP.solicitante]: { rich_text: {} },
    [PROP.atualizado]: { date: {} },
    [PROP.abrirNoApp]: { url: {} },
    [PROP.projectId]: { rich_text: {} },
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

// ── people resolution ─────────────────────────────────────────────────────
// "Responsável" is a Notion person, but the app stores an email. Resolve the
// workspace's users once and cache the email→id map briefly. Best-effort: a
// lookup failure just means no person is set on the card this run.
let peopleCache: { at: number; map: Map<string, string> } | null = null;

async function resolvePerson(email: string | null): Promise<string | null> {
    if (!email) return null;
    const now = Date.now();
    if (!peopleCache || now - peopleCache.at > 10 * 60_000) {
        const map = new Map<string, string>();
        try {
            let cursor: string | undefined;
            do {
                const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
                const page = await req("GET", `/users${qs}`);
                const users = (page.results ?? []) as {
                    id: string;
                    person?: { email?: string };
                }[];
                for (const u of users) {
                    const e = u.person?.email?.toLowerCase();
                    if (e) map.set(e, u.id);
                }
                cursor = (page.has_more ? (page.next_cursor as string) : undefined) ?? undefined;
            } while (cursor);
        } catch (e) {
            console.warn(`[notion] users lookup failed: ${(e as Error).message}`);
        }
        peopleCache = { at: now, map };
    }
    return peopleCache.map.get(email.toLowerCase()) ?? null;
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

// Rename drift-safe reconcile for a select property: options that mean the same
// thing (ignoring case/accents) are renamed in place so cards keep their value,
// genuinely new options are appended, and nothing is removed (dropping an option
// in use would blank those cards).
function reconcileSelect(
    existing: Record<string, unknown>,
    prop: string,
    wanted: string[],
    patch: Record<string, unknown>,
): void {
    const cur = existing[prop] as
        | { select?: { options?: { id?: string; name: string }[] } }
        | undefined;
    if (!cur?.select) return;
    const norm = (s: string) =>
        s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
    const byNorm = new Map(wanted.map((name) => [norm(name), name]));
    const current = cur.select.options ?? [];
    const options = current.map((o) => {
        const target = byNorm.get(norm(o.name));
        return target && target !== o.name ? { id: o.id, name: target } : o;
    });
    const covered = new Set(current.map((o) => norm(o.name)));
    for (const name of wanted) if (!covered.has(norm(name))) options.push({ name });
    const changed =
        options.length !== current.length ||
        options.some((o, i) => o.name !== current[i]?.name);
    if (changed) patch[prop] = { select: { options } };
}

async function ensureSchema(databaseId: string, meta: Record<string, unknown>): Promise<void> {
    const existing = (meta.properties ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(SCHEMA)) {
        if (!(name in existing)) patch[name] = def;
    }
    // Keep the managed selects' options in step with our vocabulary.
    reconcileSelect(existing, PROP.etapa, Object.values(LANE_LABELS), patch);
    reconcileSelect(existing, PROP.status, Object.values(STATUS_LABELS), patch);
    reconcileSelect(existing, PROP.prioridade, Object.values(PRIORITY_LABELS), patch);
    reconcileSelect(existing, PROP.risco, Object.values(RISK_LABELS), patch);

    if (Object.keys(patch).length > 0) {
        await req("PATCH", `/databases/${databaseId}`, { properties: patch });
    }
}

// ── card shape ──────────────────────────────────────────────────────────────
type Card = {
    id: string;
    name: string;
    counterparty: string | null;
    lane: string | null;
    status: string | null;
    assignee_email: string | null;
    priority: string | null;
    deadline: string | null;
    completed_at: string | null;
    risk_level: string | null;
    contract_type: string | null;
    requester_name: string | null;
    updated_at: string | null;
    // Attached from contract_terms before upsert (not a projects column).
    renewal_date?: string | null;
};

const rt = (v: string | null) => ({
    rich_text: v ? [{ type: "text", text: { content: v.slice(0, 1900) } }] : [],
});
const sel = (v: string | null) => ({ select: v ? { name: v } : null });
const dt = (v: string | null | undefined) => ({
    date: v ? { start: v.slice(0, 10) } : null,
});

function cardProps(
    card: Card,
    titleKey: string,
    assigneeNotionId: string | null,
): Record<string, unknown> {
    const base = (process.env.APP_BASE_URL?.trim() || "http://localhost:3000").replace(/\/$/, "");
    return {
        [titleKey]: {
            title: [{ type: "text", text: { content: (card.name || "(untitled)").slice(0, 1900) } }],
        },
        [PROP.contraparte]: rt(card.counterparty),
        [PROP.etapa]: sel(card.lane ? (LANE_LABELS[card.lane] ?? card.lane) : null),
        [PROP.status]: sel(card.status ? (STATUS_LABELS[card.status] ?? card.status) : null),
        [PROP.responsavel]: { people: assigneeNotionId ? [{ id: assigneeNotionId }] : [] },
        [PROP.prioridade]: sel(
            card.priority ? (PRIORITY_LABELS[card.priority] ?? card.priority) : null,
        ),
        [PROP.prazo]: dt(card.deadline),
        [PROP.conclusao]: dt(card.completed_at),
        [PROP.risco]: sel(card.risk_level ? (RISK_LABELS[card.risk_level] ?? card.risk_level) : null),
        [PROP.tipo]: sel(card.contract_type),
        [PROP.renovacao]: dt(card.renewal_date ?? null),
        [PROP.solicitante]: rt(card.requester_name),
        [PROP.atualizado]: {
            date: { start: (card.updated_at ?? new Date().toISOString()).slice(0, 10) },
        },
        [PROP.abrirNoApp]: { url: `${base}/projects/${card.id}` },
        [PROP.projectId]: rt(card.id),
    };
}

type UpsertedPage = { id: string; url: string | null };

async function upsert(
    databaseId: string,
    titleKey: string,
    card: Card,
): Promise<UpsertedPage> {
    const query = await req("POST", `/databases/${databaseId}/query`, {
        filter: { property: PROP.projectId, rich_text: { equals: card.id } },
        page_size: 1,
    });
    const results = (query.results ?? []) as { id: string }[];
    const assigneeNotionId = await resolvePerson(card.assignee_email);
    const properties = cardProps(card, titleKey, assigneeNotionId);
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

const CARD_SELECT =
    "id, name, counterparty, lane, status, assignee_email, priority, deadline, " +
    "completed_at, risk_level, contract_type, requester_name, updated_at";

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
            .select(CARD_SELECT)
            .not("lane", "is", null)
            .order("updated_at", { ascending: true });
        if (last) query = query.gte("updated_at", last);

        const startedAt = new Date().toISOString();
        const { data, error } = await query;
        if (error) throw new Error(error.message);
        const cards = (data ?? []) as unknown as Card[];

        // Renovação lives on contract_terms, not projects. Fetch the notice
        // deadlines for the cards in this batch and attach them.
        if (cards.length > 0) {
            const { data: terms } = await db
                .from("contract_terms")
                .select("project_id, notice_deadline")
                .in(
                    "project_id",
                    cards.map((c) => c.id),
                );
            const byProject = new Map(
                ((terms ?? []) as { project_id: string; notice_deadline: string | null }[]).map(
                    (t) => [t.project_id, t.notice_deadline],
                ),
            );
            for (const c of cards) c.renewal_date = byProject.get(c.id) ?? null;
        }

        for (const card of cards) {
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
