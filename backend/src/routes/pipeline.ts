// Contract pipeline ("esteira") — a kanban board over projects.
//
// A project with a non-null `lane` is a contract moving through the pipeline,
// so a card carries everything a project already has (documents, chat, tabular
// reviews, sharing). Projects without a lane never appear here.
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { checkProjectAccess } from "../lib/access";

export const pipelineRouter = Router();

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

const CARD_COLUMNS =
    "id, name, counterparty, lane, risk_level, requester_name, lane_updated_at, updated_at, created_at, user_id, notion_url";

function normalizeString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

// GET /pipeline — every card the user can see, grouped by lane.
pipelineRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = (res.locals.userEmail as string | undefined) ?? "";
    const db = createServerSupabase();

    const { data, error } = await db
        .from("projects")
        .select(CARD_COLUMNS + ", shared_with")
        .not("lane", "is", null)
        .order("lane_updated_at", { ascending: false, nullsFirst: false });
    if (error) return void res.status(500).json({ detail: error.message });

    type CardRow = {
        user_id: string;
        shared_with: string[] | null;
        lane: Lane;
    };
    const email = userEmail.toLowerCase();
    const visible = ((data ?? []) as unknown as CardRow[]).filter((row) => {
        if (row.user_id === userId) return true;
        const shared = Array.isArray(row.shared_with) ? row.shared_with : [];
        return !!email && shared.some((e) => (e ?? "").toLowerCase() === email);
    });

    const lanes = Object.fromEntries(LANES.map((l) => [l, [] as CardRow[]]));
    for (const card of visible) {
        if (lanes[card.lane]) lanes[card.lane].push(card);
    }
    res.json({ lanes: LANES, cards: visible, by_lane: lanes });
});

// PATCH /pipeline/:projectId — move a card between lanes / edit its fields.
// Also puts a project on the board for the first time (send a lane).
pipelineRouter.patch("/:projectId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const projectId = req.params.projectId;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

    const patch: Record<string, unknown> = {};
    if ("lane" in req.body) {
        const lane = req.body.lane;
        // null removes the project from the board without deleting it
        if (lane === null) {
            patch.lane = null;
        } else {
            if (!LANES.includes(lane)) {
                return void res
                    .status(400)
                    .json({ detail: `lane must be one of: ${LANES.join(", ")}` });
            }
            patch.lane = lane;
        }
        patch.lane_updated_at = new Date().toISOString();
    }
    if ("risk_level" in req.body) {
        const risk = req.body.risk_level;
        if (risk !== null && !RISK_LEVELS.includes(risk)) {
            return void res
                .status(400)
                .json({ detail: `risk_level must be one of: ${RISK_LEVELS.join(", ")}` });
        }
        patch.risk_level = risk;
    }
    if ("counterparty" in req.body) patch.counterparty = normalizeString(req.body.counterparty);
    if ("requester_name" in req.body) patch.requester_name = normalizeString(req.body.requester_name);

    if (Object.keys(patch).length === 0) {
        return void res.status(400).json({ detail: "Nothing to update" });
    }
    patch.updated_at = new Date().toISOString();

    const { data, error } = await db
        .from("projects")
        .update(patch)
        .eq("id", projectId)
        .select(CARD_COLUMNS)
        .single();
    if (error) return void res.status(500).json({ detail: error.message });
    res.json(data);
});
