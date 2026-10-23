// HTTP layer for requests to the legal team. Handlers read the caller off
// res.locals, call the service, and map its ServiceResult onto status codes.

import { Router, type Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure, type ServiceResult } from "../../lib/serviceResult";
import {
    getRequestAnalysis,
    getTerms,
    setTerms,
    listCriticalAlerts,
    requestAnalysis,
    answerIntake,
    getIntake,
    getAssignmentRules,
    getIntakeTemplate,
    setAssignmentRules,
    setIntakeTemplate,
    assignRequest,
    createRequest,
    decideTriage,
    deliverRequest,
    getRequest,
    inviteParticipant,
    listRequests,
    postMessage,
    revokeParticipant,
    whoAmI,
    type Caller,
} from "./requests.service";

function caller(res: Response): Caller {
    return {
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string | undefined,
    };
}

function body(req: { body?: unknown }): Record<string, unknown> {
    return req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
}

/**
 * A failure on its way out. A validation that names a field answers 422 with
 * it, so the form paints the right field instead of a toast; every other
 * failure keeps the status of its kind.
 */
function fail(res: Response, result: Extract<ServiceResult<unknown>, { ok: false }>): void {
    if (result.kind === "validation" && result.code?.startsWith("field:")) {
        return void res.status(422).json({ detail: result.detail, field: result.code.slice("field:".length) });
    }
    sendServiceFailure(res, result);
}

function send<T>(res: Response, result: ServiceResult<T>, status = 200): void {
    if (!result.ok) return void fail(res, result);
    res.status(status).json(result.data);
}

export const requestsRouter = Router();

requestsRouter.get(
    "/",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(
            res,
            await listRequests(createServerSupabase(), caller(res), { mine: req.query.mine === "1" }),
        );
    }),
);

requestsRouter.get(
    "/me",
    requireAuth,
    asyncRoute(async (_req, res) => {
        send(res, await whoAmI(createServerSupabase(), caller(res)));
    }),
);

requestsRouter.post(
    "/",
    requireAuth,
    asyncRoute(async (req, res) => {
        const result = await createRequest(createServerSupabase(), caller(res), body(req));
        if (!result.ok) return void fail(res, result);
        res.status(result.data.deduplicated ? 200 : 201).json(result.data);
    }),
);

// Open critical alerts for the Head (home screen, Pedidos badge).
requestsRouter.get(
    "/alerts",
    requireAuth,
    asyncRoute(async (_req, res) => {
        send(res, await listCriticalAlerts(createServerSupabase(), caller(res)));
    }),
);

// The organization's intake checklist (before "/:id", which would match it).
requestsRouter.get(
    "/assignment-rules",
    requireAuth,
    asyncRoute(async (_req, res) => {
        send(res, await getAssignmentRules(createServerSupabase(), caller(res)));
    }),
);

requestsRouter.put(
    "/assignment-rules",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await setAssignmentRules(createServerSupabase(), caller(res), body(req)));
    }),
);

requestsRouter.get(
    "/intake-template",
    requireAuth,
    asyncRoute(async (_req, res) => {
        send(res, await getIntakeTemplate(createServerSupabase(), caller(res)));
    }),
);

requestsRouter.put(
    "/intake-template",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await setIntakeTemplate(createServerSupabase(), caller(res), body(req)));
    }),
);

requestsRouter.get(
    "/:id",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await getRequest(createServerSupabase(), caller(res), req.params.id));
    }),
);

requestsRouter.get(
    "/:id/intake",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await getIntake(createServerSupabase(), caller(res), req.params.id));
    }),
);

requestsRouter.get(
    "/:id/terms",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await getTerms(createServerSupabase(), caller(res), req.params.id));
    }),
);

requestsRouter.put(
    "/:id/terms",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await setTerms(createServerSupabase(), caller(res), req.params.id, body(req)));
    }),
);

requestsRouter.post(
    "/:id/intake",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await answerIntake(createServerSupabase(), caller(res), req.params.id, body(req)));
    }),
);

requestsRouter.get(
    "/:id/analysis",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await getRequestAnalysis(createServerSupabase(), caller(res), req.params.id));
    }),
);

requestsRouter.post(
    "/:id/analysis",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await requestAnalysis(createServerSupabase(), caller(res), req.params.id), 202);
    }),
);

requestsRouter.post(
    "/:id/assign",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await assignRequest(createServerSupabase(), caller(res), req.params.id, body(req)));
    }),
);

requestsRouter.post(
    "/:id/triage",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await decideTriage(createServerSupabase(), caller(res), req.params.id, body(req)));
    }),
);

requestsRouter.post(
    "/:id/messages",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await postMessage(createServerSupabase(), caller(res), req.params.id, body(req)), 201);
    }),
);

requestsRouter.post(
    "/:id/deliver",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await deliverRequest(createServerSupabase(), caller(res), req.params.id, body(req)));
    }),
);

requestsRouter.post(
    "/:id/participants",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await inviteParticipant(createServerSupabase(), caller(res), req.params.id, body(req)), 201);
    }),
);

requestsRouter.delete(
    "/:id/participants/:participantId",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(
            res,
            await revokeParticipant(createServerSupabase(), caller(res), req.params.id, req.params.participantId),
        );
    }),
);

requestsRouter.use(routerErrorHandler("[requests]"));
