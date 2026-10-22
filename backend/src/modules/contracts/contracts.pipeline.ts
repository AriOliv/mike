// Contract pipeline ("esteira") — a kanban board over projects.
//
// A project with a non-null `lane` is a contract moving through the pipeline,
// so a card carries everything a project already has (documents, chat, tabular
// reviews, sharing). Projects without a lane never appear here.

import type { Db } from "../../lib/supabase";
import { listAccessibleProjectIds } from "../../lib/access";
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
import { recordCardEvent } from "./contracts.events";

export const LANES = [
    "entrada",
    "triagem",
    "revisao",
    "negociacao",
    "assinatura",
    "arquivado",
] as const;
export type Lane = (typeof LANES)[number];

const RISK_LEVELS = ["critico", "atencao", "ok"] as const;
const STATUSES = ["a_fazer", "em_andamento", "bloqueado", "concluido"] as const;
const PRIORITIES = ["baixa", "media", "alta"] as const;

const CARD_COLUMNS =
    "id, name, counterparty, lane, status, assignee_email, priority, deadline, completed_at, " +
    "risk_level, contract_type, requester_name, lane_updated_at, updated_at, created_at, user_id, notion_url, org_id";

// PostgREST caps an `in` list by URL length; the board is read in slices.
const ID_CHUNK = 200;

export type PipelineCard = Record<string, unknown> & { id: string; lane: Lane };

export type PipelineBoard = {
    lanes: readonly Lane[];
    cards: PipelineCard[];
    by_lane: Record<string, PipelineCard[]>;
};

/** Every card the caller can see, grouped by lane. */
export async function listPipeline(
    db: Db,
    caller: Caller,
): Promise<ServiceResult<PipelineBoard>> {
    let ids: string[];
    try {
        ids = await listAccessibleProjectIds(caller.userId, caller.userEmail, db);
    } catch (error) {
        return internalFailure(error);
    }

    const cards: PipelineCard[] = [];
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const { data, error } = await db
            .from("projects")
            .select(CARD_COLUMNS)
            .in("id", ids.slice(i, i + ID_CHUNK))
            .not("lane", "is", null)
            .is("archived_at", null);
        if (error) return internalFailure(error);
        cards.push(...((data ?? []) as unknown as PipelineCard[]));
    }
    cards.sort((a, b) =>
        String(b.lane_updated_at ?? "").localeCompare(String(a.lane_updated_at ?? "")),
    );

    const byLane = Object.fromEntries(LANES.map((l) => [l, [] as PipelineCard[]]));
    for (const card of cards) byLane[card.lane]?.push(card);
    return ok({ lanes: LANES, cards, by_lane: byLane });
}

function oneOf<T extends string>(
    body: Record<string, unknown>,
    field: string,
    allowed: readonly T[],
    patch: Record<string, unknown>,
) {
    if (!(field in body)) return null;
    const value = body[field];
    if (value !== null && !allowed.includes(value as T)) {
        return failure("validation", `${field} must be one of: ${allowed.join(", ")}`);
    }
    patch[field] = value;
    return null;
}

/**
 * Move a card between lanes or edit its fields. Sending a lane also puts a
 * project on the board for the first time; a null lane takes it off without
 * deleting it.
 */
export async function updatePipelineCard(
    db: Db,
    caller: Caller,
    projectId: string,
    body: Record<string, unknown>,
): Promise<ServiceResult<PipelineCard>> {
    const access = await requireProjectEdit(db, caller, projectId);
    if (!access.ok) return access;

    const patch: Record<string, unknown> = {};
    if ("lane" in body) {
        const lane = body.lane;
        if (lane !== null && !LANES.includes(lane as Lane)) {
            return failure("validation", `lane must be one of: ${LANES.join(", ")}`);
        }
        patch.lane = lane;
        patch.lane_updated_at = new Date().toISOString();
    }
    // Task fields are a second axis, independent of the lane: a contract can
    // be blocked without leaving its stage.
    const invalid =
        oneOf(body, "risk_level", RISK_LEVELS, patch) ??
        oneOf(body, "status", STATUSES, patch) ??
        oneOf(body, "priority", PRIORITIES, patch);
    if (invalid) return invalid;

    if ("counterparty" in body) patch.counterparty = normalizeString(body.counterparty);
    if ("requester_name" in body) patch.requester_name = normalizeString(body.requester_name);
    if ("assignee_email" in body) {
        const email = normalizeString(body.assignee_email);
        if (email !== null && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            return failure("validation", "assignee_email must be a valid email or null");
        }
        patch.assignee_email = email?.toLowerCase() ?? null;
    }
    for (const field of ["deadline", "completed_at"] as const) {
        if (!(field in body)) continue;
        const value = body[field];
        if (value !== null && !isIsoDate(value)) {
            return failure("validation", `${field} must be YYYY-MM-DD or null`);
        }
        patch[field] = value;
    }

    if (Object.keys(patch).length === 0) return failure("validation", "Nothing to update");
    patch.updated_at = new Date().toISOString();

    // Read the fields the activity feed reports before overwriting them.
    const logged = LOGGED_FIELDS.filter((field) => field in patch);
    let before: Record<string, unknown> = {};
    if (logged.length) {
        const { data: current, error: currentError } = await db
            .from("projects")
            .select(`org_id, ${logged.join(", ")}`)
            .eq("id", projectId)
            .single();
        if (currentError) return internalFailure(currentError);
        before = (current ?? {}) as unknown as Record<string, unknown>;
    }

    const { data, error } = await db
        .from("projects")
        .update(patch)
        .eq("id", projectId)
        .select(CARD_COLUMNS)
        .single();
    if (error) return internalFailure(error);

    for (const field of logged) {
        if ((before[field] ?? null) === (patch[field] ?? null)) continue;
        await recordCardEvent(db, {
            projectId,
            orgId: (before.org_id as string | null | undefined) ?? null,
            actorType: "user",
            actorId: caller.userId,
            actorName: caller.userEmail ?? null,
            action: `${FIELD_ACTIONS[field]}.changed`,
            field,
            before: before[field] ?? null,
            after: patch[field] ?? null,
        });
    }
    return ok(data as unknown as PipelineCard);
}

// Card fields whose changes appear in the activity feed, and the event name.
const FIELD_ACTIONS = {
    lane: "lane",
    assignee_email: "assignee",
    status: "status",
} as const;
const LOGGED_FIELDS = Object.keys(FIELD_ACTIONS) as (keyof typeof FIELD_ACTIONS)[];
