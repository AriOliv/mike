// Status of server-side integrations, and manual triggers for them.
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { notionBoardUrl, notionEnabled, syncPipelineToNotion } from "../lib/notion";
import { driveEnabled, syncDocumentsToDrive } from "../lib/drive";

export const integrationsRouter = Router();

integrationsRouter.get("/status", requireAuth, async (_req, res) => {
    res.json({
        notion: { enabled: notionEnabled(), board_url: await notionBoardUrl() },
        drive: { enabled: driveEnabled(), folder_id: process.env.DRIVE_FOLDER_ID ?? null },
    });
});

// Mirror the pipeline to Notion now, instead of waiting for the next tick.
integrationsRouter.post("/notion/sync", requireAuth, async (_req, res) => {
    const summary = await syncPipelineToNotion();
    res.json(summary);
});

// Push any documents that have no Drive copy yet.
integrationsRouter.post("/drive/sync", requireAuth, async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const summary = await syncDocumentsToDrive(limit);
    res.json(summary);
});
