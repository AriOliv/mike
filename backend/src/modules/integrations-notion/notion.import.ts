// First import: every page of the organization's Notion board becomes a card
// in Mike, linked by notion_page_id. Always a dry run first, which shows what
// would come in, what is already in Mike and what does not fit; the apply
// re-reads the board and does exactly what a dry run would say.
//
// Matching a page to a card, in order:
//   1. linked     a card of this org already has this notion_page_id
//   2. project    the page's ProjectId names a project of this org
//   3. duplicate  a card of this org has the same counterparty + name
//                 (normalized): linked to it instead of creating another
//   4. new        none of the above
// Idempotent: a second apply finds every page linked (1) and changes nothing
// it did not change the first time.

import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { getOrgRole, isOrgAdmin } from "../../lib/access";
import { recordAudit } from "../../lib/audit";
import { recordCardEvent } from "../contracts/contracts.service";
import { notionErrorMessage, type Fetch, type NotionClient } from "./notion.client";
import { clientForOrg, type Caller } from "./notion.connection";
import { normalize, readPage, type CardFields, type FieldMap, type StageMap } from "./notion.mapping";

const PAGE_SIZE = 100;
const MAX_PAGES = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ImportMatch = "linked" | "project" | "duplicate" | "new";

export type ImportItem = {
    page_id: string;
    name: string;
    counterparty: string | null;
    lane: string | null;
    tag: string | null;
    match: ImportMatch;
    /** The card it lands on, when one exists already. */
    project_id: string | null;
    /** Why it may need a look: a person-facing sentence each. */
    warnings: string[];
};

export type ImportPlan = {
    total: number;
    counts: Record<ImportMatch, number> & { skipped: number };
    items: ImportItem[];
    /** Pages that cannot come in, and why. */
    skipped: { page_id: string; reason: string }[];
};

type Page = { id: string; url?: string; last_edited_time?: string; archived?: boolean; in_trash?: boolean; properties: Record<string, { type?: string; [k: string]: unknown }> };

type OrgCard = { id: string; name: string; counterparty: string | null; notion_page_id: string | null };

const NOT_FOUND = failure("not_found", "Organização não encontrada.");
const ONLY_ADMINS = failure("forbidden", "Só quem administra a organização pode importar do Notion.");
const NOT_READY = failure("conflict", "Conecte o Notion e salve o mapeamento antes de importar.");

/** Every live page of the board, following Notion's cursor. */
export async function readAllPages(client: NotionClient, databaseId: string): Promise<Page[]> {
    const pages: Page[] = [];
    let cursor: string | undefined;
    do {
        const body: Record<string, unknown> = { page_size: PAGE_SIZE };
        if (cursor) body.start_cursor = cursor;
        const result = await client.request("POST", `/databases/${encodeURIComponent(databaseId)}/query`, body);
        for (const page of (result.results ?? []) as Page[]) if (!page.archived && !page.in_trash) pages.push(page);
        cursor = result.has_more ? (result.next_cursor as string) : undefined;
    } while (cursor && pages.length < MAX_PAGES);
    return pages;
}

const key = (counterparty: string | null | undefined, name: string) => `${normalize(counterparty ?? "")}|${normalize(name)}`;

async function orgCards(db: Db, orgId: string): Promise<OrgCard[]> {
    const { data, error } = await db
        .from("projects")
        .select("id, name, counterparty, notion_page_id")
        .eq("org_id", orgId)
        .not("lane", "is", null);
    if (error) throw error;
    return (data ?? []) as OrgCard[];
}

/** The plan for a set of pages against the org's cards. Pure apart from the cards read. */
export function planImport(pages: Page[], cards: OrgCard[], fieldMap: FieldMap, stageMap: StageMap): ImportPlan & { fields: Map<string, CardFields> } {
    const byPage = new Map(cards.filter((c) => c.notion_page_id).map((c) => [c.notion_page_id!, c]));
    const byId = new Map(cards.map((c) => [c.id, c]));
    const byKey = new Map<string, OrgCard>();
    for (const c of cards) if (!byKey.has(key(c.counterparty, c.name))) byKey.set(key(c.counterparty, c.name), c);
    const stageProperty = Object.entries(fieldMap).find(([, f]) => f === "lane")?.[0];
    const taken = new Set<string>();

    const items: ImportItem[] = [];
    const skipped: ImportPlan["skipped"] = [];
    const fields = new Map<string, CardFields>();
    for (const page of pages) {
        const card = readPage(page.properties, fieldMap, stageMap);
        if (!card.name) {
            skipped.push({ page_id: page.id, reason: "A página não tem nome de contrato." });
            continue;
        }
        const warnings: string[] = [];
        const stageValue = stageProperty ? ((page.properties[stageProperty]?.select ?? page.properties[stageProperty]?.status) as { name?: string } | null) : null;
        if (!card.lane) {
            warnings.push(stageValue?.name ? `A etapa ${stageValue.name} não está no mapeamento; entra em Entrada.` : "Sem etapa no Notion; entra em Entrada.");
        }

        let match: ImportMatch = "new";
        let target: OrgCard | undefined = byPage.get(page.id);
        if (target) match = "linked";
        if (!target && card.project_id) {
            const candidate = UUID.test(card.project_id) ? byId.get(card.project_id) : undefined;
            if (candidate && !candidate.notion_page_id && !taken.has(candidate.id)) {
                target = candidate;
                match = "project";
            } else if (!candidate) {
                warnings.push("O ProjectId da página não existe nesta organização; entra como card novo.");
            }
        }
        if (!target) {
            const candidate = byKey.get(key(card.counterparty, card.name));
            if (candidate && !candidate.notion_page_id && !taken.has(candidate.id)) {
                target = candidate;
                match = "duplicate";
            }
        }
        if (target) taken.add(target.id);
        if (card.app_link && /localhost|127\.0\.0\.1/.test(card.app_link)) warnings.push("O link “Abrir no app” aponta para localhost; será trocado pelo endereço do Mike.");
        fields.set(page.id, card);
        items.push({
            page_id: page.id,
            name: card.name,
            counterparty: card.counterparty ?? null,
            lane: card.lane ?? null,
            tag: card.notion_stage ?? null,
            match,
            project_id: target?.id ?? null,
            warnings,
        });
    }
    const counts = { linked: 0, project: 0, duplicate: 0, new: 0, skipped: skipped.length };
    for (const item of items) counts[item.match] += 1;
    return { total: pages.length, counts, items, skipped, fields };
}

type Ready = { client: NotionClient; databaseId: string; fieldMap: FieldMap; stageMap: StageMap; writesAllowed: boolean };

async function ready(db: Db, caller: Caller, orgId: string, fetchImpl?: Fetch): Promise<{ ok: true; ready: Ready } | { ok: false; result: ReturnType<typeof failure> }> {
    const role = await getOrgRole(caller.userId, orgId, db);
    if (!role) return { ok: false, result: NOT_FOUND };
    if (!isOrgAdmin(role)) return { ok: false, result: ONLY_ADMINS };
    const conn = await clientForOrg(db, orgId, fetchImpl);
    const fieldMap = (conn?.row.field_map ?? {}) as FieldMap;
    if (!conn || !conn.row.database_id || !Object.values(fieldMap).includes("lane")) return { ok: false, result: NOT_READY };
    return {
        ok: true,
        ready: {
            client: conn.client,
            databaseId: conn.row.database_id,
            fieldMap,
            stageMap: (conn.row.stage_map ?? {}) as StageMap,
            // Writing to the organization's board is off until an admin turns the sync on.
            writesAllowed: conn.row.sync_enabled === true,
        },
    };
}

/** What an import would do, changing nothing. */
export async function previewNotionImport(db: Db, caller: Caller, orgId: string, fetchImpl?: Fetch): Promise<ServiceResult<ImportPlan>> {
    try {
        const r = await ready(db, caller, orgId, fetchImpl);
        if (!r.ok) return r.result;
        let pages: Page[];
        try {
            pages = await readAllPages(r.ready.client, r.ready.databaseId);
        } catch (error) {
            return failure("unavailable", notionErrorMessage(error));
        }
        const { fields: _fields, ...plan } = planImport(pages, await orgCards(db, orgId), r.ready.fieldMap, r.ready.stageMap);
        void _fields;
        return ok(plan);
    } catch (error) {
        return internalFailure(error);
    }
}

function appBase(): string {
    return (process.env.APP_BASE_URL?.trim() || process.env.FRONTEND_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");
}

/** Card columns from page fields: the legal team's fields always, Mike's only when Mike has none. */
function cardPatch(fields: CardFields, existing: boolean): Record<string, unknown> {
    const patch: Record<string, unknown> = {
        lane: fields.lane ?? "entrada",
        notion_stage: fields.notion_stage ?? null,
        status: fields.status ?? null,
        priority: fields.priority ?? null,
        deadline: fields.deadline ?? null,
        completed_at: fields.completed_at ?? null,
        requester_name: fields.requester_name ?? null,
    };
    // Mike owns what its agents derive; an existing card keeps its own values.
    if (!existing) {
        patch.counterparty = fields.counterparty ?? null;
        patch.risk_level = fields.risk_level ?? null;
        patch.contract_type = fields.contract_type ?? null;
    }
    return patch;
}

export type ImportResult = { created: number; linked: number; skipped: number; failed: number };

/**
 * Applies the import. Re-reads the board, re-plans, and for each page links
 * or creates the card. Mike's link is written back to the page only when
 * asked AND the organization turned writing to Notion on (sync_enabled):
 * the import never writes to a board nobody allowed it to. Each card gets
 * one "imported from Notion" event.
 */
export async function applyNotionImport(
    db: Db,
    caller: Caller,
    orgId: string,
    opts: { writeBack?: boolean } = {},
    fetchImpl?: Fetch,
): Promise<ServiceResult<ImportResult>> {
    try {
        const r = await ready(db, caller, orgId, fetchImpl);
        if (!r.ok) return r.result;
        let pages: Page[];
        try {
            pages = await readAllPages(r.ready.client, r.ready.databaseId);
        } catch (error) {
            return failure("unavailable", notionErrorMessage(error));
        }
        const plan = planImport(pages, await orgCards(db, orgId), r.ready.fieldMap, r.ready.stageMap);
        const result: ImportResult = { created: 0, linked: 0, skipped: plan.skipped.length, failed: 0 };
        const now = new Date().toISOString();
        const appLinkProp = Object.entries(r.ready.fieldMap).find(([, f]) => f === "app_link")?.[0];
        const projectIdProp = Object.entries(r.ready.fieldMap).find(([, f]) => f === "project_id")?.[0];
        const pageUrl = new Map(pages.map((p) => [p.id, p.url ?? null]));

        for (const item of plan.items) {
            const fields = plan.fields.get(item.page_id)!;
            try {
                let projectId = item.project_id;
                if (item.match === "linked") {
                    // Already in Mike: the sync keeps it current; the import leaves it.
                    result.linked += 1;
                    continue;
                }
                if (!projectId) {
                    const { data, error } = await db.rpc("create_project_with_memory", {
                        p_user_id: caller.userId,
                        p_name: item.name,
                        p_cm_number: null,
                        p_practice: null,
                        p_org_id: orgId,
                        p_memory_enabled: false,
                    });
                    const created = Array.isArray(data) ? data[0] : data;
                    if (error || !created) throw error ?? new Error("project not created");
                    projectId = (created as { id: string }).id;
                }
                const { error: updateError } = await db
                    .from("projects")
                    .update({
                        ...cardPatch(fields, !!item.project_id),
                        visibility: "organization",
                        lane_updated_at: now,
                        notion_page_id: item.page_id,
                        notion_url: pageUrl.get(item.page_id) ?? null,
                    })
                    .eq("id", projectId)
                    .eq("org_id", orgId);
                if (updateError) throw updateError;
                await recordCardEvent(db, {
                    projectId,
                    orgId,
                    actorType: "system",
                    actorId: "notion:import",
                    actorName: "Importação do Notion",
                    onBehalfOf: caller.userEmail ?? null,
                    action: item.project_id ? "notion.linked" : "notion.imported",
                    after: { match: item.match },
                    source: "notion",
                });
                if (opts.writeBack && r.ready.writesAllowed && (appLinkProp || projectIdProp)) {
                    const properties: Record<string, unknown> = {};
                    if (appLinkProp) properties[appLinkProp] = { url: `${appBase()}/projects/${projectId}` };
                    if (projectIdProp) properties[projectIdProp] = { rich_text: [{ text: { content: projectId } }] };
                    await r.ready.client.request("PATCH", `/pages/${encodeURIComponent(item.page_id)}`, { properties });
                }
                if (item.project_id) result.linked += 1;
                else result.created += 1;
            } catch {
                result.failed += 1;
            }
        }
        await recordAudit(db, {
            userId: caller.userId,
            orgId,
            userEmail: caller.userEmail ?? null,
            action: "notion.imported",
            title: "Notion",
            surface: "settings",
            detail: { ...result, write_back: !!opts.writeBack && r.ready.writesAllowed },
        });
        return ok(result);
    } catch (error) {
        return internalFailure(error);
    }
}
