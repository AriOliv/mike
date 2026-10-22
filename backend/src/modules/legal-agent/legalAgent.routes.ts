// HTTP layer for the legal team's chat agent, under an organization:
//   GET    /orgs/:orgId/legal-agent                         settings + channels (any member)
//   PUT    /orgs/:orgId/legal-agent                         save settings (owner/admin)
//   POST   /orgs/:orgId/legal-agent/channels                new channel + setup files (owner/admin)
//   PUT    /orgs/:orgId/legal-agent/channels/:id            edit channel + setup files
//   GET    /orgs/:orgId/legal-agent/channels/:id/setup      setup files again
//   PATCH  /orgs/:orgId/legal-agent/channels/:id            status: rascunho | configurado | pausado
//   DELETE /orgs/:orgId/legal-agent/channels/:id
//   GET    /orgs/:orgId/legal-agent/links                   my chat links here
//   DELETE /orgs/:orgId/legal-agent/links/:id               revoke one of mine

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
    listMyChatLinks,
    revokeMyChatLink,
    previewChatLink,
    confirmChatLink,
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
        const { kind, name, config, platform_team_id } = body(req);
        send(
            res,
            await saveLegalAgentChannel(createServerSupabase(), caller(res), req.params.orgId, { kind, name, config, platform_team_id }),
            201,
        );
    }),
);

legalAgentRouter.put(
    "/channels/:channelId",
    requireAuth,
    asyncRoute(async (req, res) => {
        const { kind, name, config, platform_team_id } = body(req);
        send(
            res,
            await saveLegalAgentChannel(createServerSupabase(), caller(res), req.params.orgId, {
                id: req.params.channelId,
                kind,
                name,
                config,
                platform_team_id,
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

// The caller's own chat links in the organization (any member).
legalAgentRouter.get(
    "/links",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await listMyChatLinks(createServerSupabase(), caller(res), req.params.orgId));
    }),
);

legalAgentRouter.delete(
    "/links/:linkId",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await revokeMyChatLink(createServerSupabase(), caller(res), req.params.orgId, req.params.linkId));
    }),
);

legalAgentRouter.use(routerErrorHandler("[legal-agent]"));

// ── /chat-links: the one-time link a person opens from the chat ─────────────
//   GET  /chat-links/preview?t=…   what will be linked (the caller must be logged in)
//   POST /chat-links/confirm {t}   "sou eu": links the chat account to the caller
export const chatLinksRouter = Router();

chatLinksRouter.get(
    "/preview",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await previewChatLink(createServerSupabase(), caller(res), req.query.t));
    }),
);

chatLinksRouter.post(
    "/confirm",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await confirmChatLink(createServerSupabase(), caller(res), body(req).t));
    }),
);

chatLinksRouter.use(routerErrorHandler("[chat-links]"));
