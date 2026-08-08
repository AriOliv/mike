// Status of server-side integrations, and manual triggers for them.
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { notionEnabled, syncPipelineToNotion } from "../lib/notion";

export const integrationsRouter = Router();

integrationsRouter.get("/status", requireAuth, (_req, res) => {
    res.json({ notion: { enabled: notionEnabled() } });
});

// Mirror the pipeline to Notion now, instead of waiting for the next tick.
integrationsRouter.post("/notion/sync", requireAuth, async (_req, res) => {
    const summary = await syncPipelineToNotion();
    res.json(summary);
});
