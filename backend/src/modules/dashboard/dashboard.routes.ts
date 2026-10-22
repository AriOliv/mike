// HTTP layer for the Legal head's dashboard.

import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure } from "../../lib/serviceResult";
import { resolveWorkspaceFilter, sendWorkspaceFailure } from "../../lib/workspace";
import { getDashboard } from "./dashboard.service";

export const dashboardRouter = Router();

dashboardRouter.get(
    "/",
    requireAuth,
    asyncRoute(async (req, res) => {
        const db = createServerSupabase();
        const workspace = await resolveWorkspaceFilter(db, res.locals.userId as string, req.query.workspace);
        if (!workspace.ok) return void sendWorkspaceFailure(res, workspace);
        const result = await getDashboard(
            db,
            { userId: res.locals.userId as string, userEmail: res.locals.userEmail as string | undefined },
            req.query as Record<string, unknown>,
            new Date(),
            workspace.workspace,
        );
        if (!result.ok) return void sendServiceFailure(res, result);
        res.json(result.data);
    }),
);

dashboardRouter.use(routerErrorHandler("[dashboard]"));
