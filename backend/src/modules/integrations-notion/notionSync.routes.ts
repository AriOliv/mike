// HTTP layer for an organization's Notion integration:
//   GET    /orgs/:orgId/integrations/notion             connection, board and mapping (any member)
//   PUT    /orgs/:orgId/integrations/notion/token       connect: checks and stores the token (owner/admin)
//   DELETE /orgs/:orgId/integrations/notion/token       disconnect
//   GET    /orgs/:orgId/integrations/notion/databases   the bases the integration can see
//   GET    /orgs/:orgId/integrations/notion/board?database_id=…  schema + suggested mapping
//   PUT    /orgs/:orgId/integrations/notion/mapping     save base and mapping

import { Router, type Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure, type ServiceResult } from "../../lib/serviceResult";
import {
    connectNotion,
    describeNotionBoard,
    disconnectNotion,
    getNotionConnection,
    listNotionDatabases,
    saveNotionMapping,
    type Caller,
} from "./notionSync.service";

function caller(res: Response): Caller {
    return { userId: res.locals.userId as string, userEmail: res.locals.userEmail as string | undefined };
}

function body(req: { body?: unknown }): Record<string, unknown> {
    return req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
}

function send<T>(res: Response, result: ServiceResult<T>): void {
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
}

export const notionIntegrationRouter = Router({ mergeParams: true });

notionIntegrationRouter.get(
    "/",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await getNotionConnection(createServerSupabase(), caller(res), req.params.orgId));
    }),
);

notionIntegrationRouter.put(
    "/token",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await connectNotion(createServerSupabase(), caller(res), req.params.orgId, body(req).token));
    }),
);

notionIntegrationRouter.delete(
    "/token",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await disconnectNotion(createServerSupabase(), caller(res), req.params.orgId));
    }),
);

notionIntegrationRouter.get(
    "/databases",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await listNotionDatabases(createServerSupabase(), caller(res), req.params.orgId));
    }),
);

notionIntegrationRouter.get(
    "/board",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await describeNotionBoard(createServerSupabase(), caller(res), req.params.orgId, req.query.database_id));
    }),
);

notionIntegrationRouter.put(
    "/mapping",
    requireAuth,
    asyncRoute(async (req, res) => {
        const { database_id, field_map, stage_map, poll_minutes } = body(req);
        send(
            res,
            await saveNotionMapping(createServerSupabase(), caller(res), req.params.orgId, {
                database_id,
                field_map,
                stage_map,
                poll_minutes,
            }),
        );
    }),
);

notionIntegrationRouter.use(routerErrorHandler("[notion]"));
