// Deadline radar — obligations with a calendar date, optionally tied to a
// pipeline project. Dates come from the contract text (see source_quote), so a
// deadline can always be traced back to the clause that created it.
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { checkProjectAccess } from "../lib/access";

export const obligationsRouter = Router();

const MARKS = ["recorrente", "critico", "tarefa"] as const;

const COLUMNS =
    "id, project_id, title, mark, due_date, done, note, source_quote, created_at, updated_at";

function isIsoDate(value: unknown): value is string {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function normalizeString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

// GET /obligations?from=YYYY-MM-DD&to=YYYY-MM-DD&include_done=true
obligationsRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();

    let query = db
        .from("obligations")
        .select(COLUMNS + ", projects(name, counterparty, lane)")
        .eq("user_id", userId)
        .order("due_date", { ascending: true });

    const from = req.query.from;
    const to = req.query.to;
    if (isIsoDate(from)) query = query.gte("due_date", from);
    if (isIsoDate(to)) query = query.lte("due_date", to);
    if (req.query.include_done !== "true") query = query.eq("done", false);

    const { data, error } = await query;
    if (error) return void res.status(500).json({ detail: error.message });
    res.json(data ?? []);
});

// POST /obligations
obligationsRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    const title = normalizeString(req.body?.title);
    const dueDate = req.body?.due_date;
    if (!title) return void res.status(400).json({ detail: "title is required" });
    if (!isIsoDate(dueDate)) {
        return void res.status(400).json({ detail: "due_date must be YYYY-MM-DD" });
    }
    const mark = req.body?.mark ?? "recorrente";
    if (!MARKS.includes(mark)) {
        return void res.status(400).json({ detail: `mark must be one of: ${MARKS.join(", ")}` });
    }

    const projectId = normalizeString(req.body?.project_id);
    if (projectId) {
        const access = await checkProjectAccess(projectId, userId, userEmail, db);
        if (!access.ok) return void res.status(404).json({ detail: "Project not found" });
    }

    const { data, error } = await db
        .from("obligations")
        .insert({
            user_id: userId,
            project_id: projectId,
            title,
            mark,
            due_date: dueDate.trim(),
            note: normalizeString(req.body?.note),
            source_quote: normalizeString(req.body?.source_quote),
        })
        .select(COLUMNS)
        .single();
    if (error) return void res.status(500).json({ detail: error.message });
    res.status(201).json(data);
});

// PATCH /obligations/:id — tick it off, reschedule, or edit.
obligationsRouter.patch("/:id", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();

    const patch: Record<string, unknown> = {};
    if ("done" in req.body) patch.done = !!req.body.done;
    if ("title" in req.body) {
        const title = normalizeString(req.body.title);
        if (!title) return void res.status(400).json({ detail: "title cannot be empty" });
        patch.title = title;
    }
    if ("due_date" in req.body) {
        if (!isIsoDate(req.body.due_date)) {
            return void res.status(400).json({ detail: "due_date must be YYYY-MM-DD" });
        }
        patch.due_date = req.body.due_date.trim();
    }
    if ("mark" in req.body) {
        if (!MARKS.includes(req.body.mark)) {
            return void res.status(400).json({ detail: `mark must be one of: ${MARKS.join(", ")}` });
        }
        patch.mark = req.body.mark;
    }
    if ("note" in req.body) patch.note = normalizeString(req.body.note);

    if (Object.keys(patch).length === 0) {
        return void res.status(400).json({ detail: "Nothing to update" });
    }
    patch.updated_at = new Date().toISOString();

    const { data, error } = await db
        .from("obligations")
        .update(patch)
        .eq("id", req.params.id)
        .eq("user_id", userId)
        .select(COLUMNS)
        .single();
    if (error) return void res.status(500).json({ detail: error.message });
    if (!data) return void res.status(404).json({ detail: "Obligation not found" });
    res.json(data);
});

// DELETE /obligations/:id
obligationsRouter.delete("/:id", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const { error } = await db
        .from("obligations")
        .delete()
        .eq("id", req.params.id)
        .eq("user_id", userId);
    if (error) return void res.status(500).json({ detail: error.message });
    res.status(204).end();
});
