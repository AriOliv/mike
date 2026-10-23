// POST /feedback: a person reports a bug or suggests a feature (doc 13).

import { Router, type Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure } from "../../lib/serviceResult";
import { feedbackEnabled, submitReport } from "./feedback.reports";

export const feedbackRouter = Router();

/** Tells the app whether to show the entry points. */
feedbackRouter.get("/status", requireAuth, (_req, res: Response) => {
    res.json({ enabled: feedbackEnabled() });
});

feedbackRouter.post(
    "/",
    requireAuth,
    asyncRoute(async (req, res) => {
        const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
        const caller = { userId: res.locals.userId as string, userEmail: res.locals.userEmail as string | undefined };
        const result = await submitReport(createServerSupabase(), caller, body, { kind: "app" });
        if (!result.ok) return void sendServiceFailure(res, result);
        res.status(201).json(result.data);
    }),
);
