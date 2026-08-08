// AI contract analysis ("dossier") attached to a project: critical risks,
// points of attention, suggested redlines and compliance notes, each quoting
// the clause it came from.
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { checkProjectAccess } from "../lib/access";

export const dossiersRouter = Router({ mergeParams: true });

const COLUMNS = "id, project_id, payload, risk_level, source, created_at, updated_at";

// GET /projects/:projectId/dossier
dossiersRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const projectId = req.params.projectId;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

    const { data, error } = await db
        .from("dossiers")
        .select(COLUMNS)
        .eq("project_id", projectId)
        .maybeSingle();
    if (error) return void res.status(500).json({ detail: error.message });
    // No analysis yet is a normal state, not an error — the UI shows an empty state.
    res.json(data ?? null);
});

// PUT /projects/:projectId/dossier — store or replace the analysis.
dossiersRouter.put("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const projectId = req.params.projectId;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

    const payload = req.body?.payload;
    if (!payload || typeof payload !== "object") {
        return void res.status(400).json({ detail: "payload object is required" });
    }
    const riskLevel =
        typeof req.body?.risk_level === "string" ? req.body.risk_level : null;
    const source = req.body?.source === "generated" ? "generated" : "import";

    const { data, error } = await db
        .from("dossiers")
        .upsert(
            {
                project_id: projectId,
                user_id: userId,
                payload,
                risk_level: riskLevel,
                source,
                updated_at: new Date().toISOString(),
            },
            { onConflict: "project_id" },
        )
        .select(COLUMNS)
        .single();
    if (error) return void res.status(500).json({ detail: error.message });
    res.json(data);
});
