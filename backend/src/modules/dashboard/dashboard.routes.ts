// HTTP layer for the Legal head's dashboard.

import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure } from "../../lib/serviceResult";
import { getDashboard } from "./dashboard.service";

export const dashboardRouter = Router();

dashboardRouter.get(
    "/",
    requireAuth,
    asyncRoute(async (req, res) => {
        const result = await getDashboard(
            createServerSupabase(),
            { userId: res.locals.userId as string, userEmail: res.locals.userEmail as string | undefined },
            req.query as Record<string, unknown>,
        );
        if (!result.ok) return void sendServiceFailure(res, result);
        res.json(result.data);
    }),
);

dashboardRouter.use(routerErrorHandler("[dashboard]"));
