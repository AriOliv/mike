// HTTP layer for the regulatory radar. Handlers read the caller off
// res.locals, call the service, and map its ServiceResult onto status codes.

import { Router, type Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure, type ServiceResult } from "../../lib/serviceResult";
import {
    createObligationFromChange,
    createRequestFromChange,
    createScan,
    deleteScan,
    listChanges,
    listPresets,
    listScans,
    runScanNow,
    updateChange,
    updateScan,
    type Caller,
} from "./regulatory.service";

function caller(res: Response): Caller {
    return {
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string | undefined,
    };
}

function body(req: { body?: unknown }): Record<string, unknown> {
    return req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
}

function send<T>(res: Response, result: ServiceResult<T>, status = 200): void {
    if (!result.ok) return void sendServiceFailure(res, result);
    res.status(status).json(result.data);
}

export const regulatoryRouter = Router();

regulatoryRouter.get(
    "/presets",
    requireAuth,
    asyncRoute(async (_req, res) => {
        res.json(listPresets());
    }),
);

regulatoryRouter.get(
    "/scans",
    requireAuth,
    asyncRoute(async (_req, res) => {
        send(res, await listScans(createServerSupabase(), caller(res)));
    }),
);

regulatoryRouter.post(
    "/scans",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await createScan(createServerSupabase(), caller(res), body(req)), 201);
    }),
);

regulatoryRouter.patch(
    "/scans/:id",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await updateScan(createServerSupabase(), caller(res), req.params.id, body(req)));
    }),
);

regulatoryRouter.delete(
    "/scans/:id",
    requireAuth,
    asyncRoute(async (req, res) => {
        const result = await deleteScan(createServerSupabase(), caller(res), req.params.id);
        if (!result.ok) return void sendServiceFailure(res, result);
        res.status(204).end();
    }),
);

regulatoryRouter.post(
    "/scans/:id/run",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await runScanNow(createServerSupabase(), caller(res), req.params.id), 202);
    }),
);

regulatoryRouter.get(
    "/changes",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await listChanges(createServerSupabase(), caller(res), req.query));
    }),
);

regulatoryRouter.patch(
    "/changes/:id",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await updateChange(createServerSupabase(), caller(res), req.params.id, body(req)));
    }),
);

regulatoryRouter.post(
    "/changes/:id/request",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await createRequestFromChange(createServerSupabase(), caller(res), req.params.id, body(req)), 201);
    }),
);

regulatoryRouter.post(
    "/changes/:id/obligation",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await createObligationFromChange(createServerSupabase(), caller(res), req.params.id, body(req)), 201);
    }),
);

regulatoryRouter.use(routerErrorHandler("[regulatory]"));
