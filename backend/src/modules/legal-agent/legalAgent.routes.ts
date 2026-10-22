// HTTP layer for the legal team's chat agent, under an organization:
//   GET    /orgs/:orgId/legal-agent                         settings + channels (any member)
//   PUT    /orgs/:orgId/legal-agent                         save settings (owner/admin)
//   POST   /orgs/:orgId/legal-agent/channels                new channel + setup files (owner/admin)
//   PUT    /orgs/:orgId/legal-agent/channels/:id            edit channel + setup files
//   GET    /orgs/:orgId/legal-agent/channels/:id/setup      setup files again
//   PATCH  /orgs/:orgId/legal-agent/channels/:id            status: rascunho | configurado | pausado
//   DELETE /orgs/:orgId/legal-agent/channels/:id

import { Router, type Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure, type ServiceResult } from "../../lib/serviceResult";
import {
    deleteLegalAgentChannel,
    getLegalAgent,
    getLegalAgentChannelSetup,
    saveLegalAgentChannel,
    saveLegalAgentSettings,
    setLegalAgentChannelStatus,
    type Caller,
} from "./legalAgent.service";

function caller(res: Response): Caller {
    return { userId: res.locals.userId as string, userEmail: res.locals.userEmail as string | undefined };
}

function body(req: { body?: unknown }): Record<string, unknown> {
    return req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
}

function send<T>(res: Response, result: ServiceResult<T>, status = 200): void {
    if (!result.ok) return void sendServiceFailure(res, result);
    res.status(status).json(result.data);
}

export const legalAgentRouter = Router({ mergeParams: true });

legalAgentRouter.get(
    "/",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await getLegalAgent(createServerSupabase(), caller(res), req.params.orgId));
    }),
);

legalAgentRouter.put(
    "/",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await saveLegalAgentSettings(createServerSupabase(), caller(res), req.params.orgId, req.body));
    }),
);

legalAgentRouter.post(
    "/channels",
    requireAuth,
    asyncRoute(async (req, res) => {
        const { kind, name, config } = body(req);
        send(res, await saveLegalAgentChannel(createServerSupabase(), caller(res), req.params.orgId, { kind, name, config }), 201);
    }),
);

legalAgentRouter.put(
    "/channels/:channelId",
    requireAuth,
    asyncRoute(async (req, res) => {
        const { kind, name, config } = body(req);
        send(
            res,
            await saveLegalAgentChannel(createServerSupabase(), caller(res), req.params.orgId, {
                id: req.params.channelId,
                kind,
                name,
                config,
            }),
        );
    }),
);

legalAgentRouter.get(
    "/channels/:channelId/setup",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await getLegalAgentChannelSetup(createServerSupabase(), caller(res), req.params.orgId, req.params.channelId));
    }),
);

legalAgentRouter.patch(
    "/channels/:channelId",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(
            res,
            await setLegalAgentChannelStatus(
                createServerSupabase(),
                caller(res),
                req.params.orgId,
                req.params.channelId,
                body(req).status,
            ),
        );
    }),
);

legalAgentRouter.delete(
    "/channels/:channelId",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await deleteLegalAgentChannel(createServerSupabase(), caller(res), req.params.orgId, req.params.channelId));
    }),
);

legalAgentRouter.use(routerErrorHandler("[legal-agent]"));
