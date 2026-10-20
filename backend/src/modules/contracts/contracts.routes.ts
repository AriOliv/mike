// HTTP layer for the contracts module. Handlers read the caller off
// res.locals, call the service, and map its ServiceResult onto status codes.

import { Router, type Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure, type ServiceResult } from "../../lib/serviceResult";
import {
    askAcervo,
    createObligation,
    deleteObligation,
    extractContractTerms,
    extractMissingContractTerms,
    getContractPreview,
    getContractPreviewFile,
    getContractTerms,
    getDossier,
    integrationStatus,
    listObligations,
    listPipeline,
    putDossier,
    syncDocumentsToDrive,
    syncObligationsToCalendar,
    syncPipelineToNotion,
    updateObligation,
    updatePipelineCard,
    type Caller,
} from "./contracts.service";

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

// ── /pipeline ────────────────────────────────────────────────────────────────
export const pipelineRouter = Router();

pipelineRouter.get(
    "/",
    requireAuth,
    asyncRoute(async (_req, res) => {
        send(res, await listPipeline(createServerSupabase(), caller(res)));
    }),
);

pipelineRouter.patch(
    "/:projectId",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(
            res,
            await updatePipelineCard(createServerSupabase(), caller(res), req.params.projectId, body(req)),
        );
    }),
);

pipelineRouter.use(routerErrorHandler("[pipeline]"));

// ── /obligations ─────────────────────────────────────────────────────────────
export const obligationsRouter = Router();

obligationsRouter.get(
    "/",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await listObligations(createServerSupabase(), caller(res), req.query));
    }),
);

obligationsRouter.post(
    "/",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await createObligation(createServerSupabase(), caller(res), body(req)), 201);
    }),
);

obligationsRouter.patch(
    "/:id",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await updateObligation(createServerSupabase(), caller(res), req.params.id, body(req)));
    }),
);

obligationsRouter.delete(
    "/:id",
    requireAuth,
    asyncRoute(async (req, res) => {
        const result = await deleteObligation(createServerSupabase(), caller(res), req.params.id);
        if (!result.ok) return void sendServiceFailure(res, result);
        res.status(204).end();
    }),
);

obligationsRouter.use(routerErrorHandler("[obligations]"));

// ── /projects/:projectId/{dossier,preview,terms} ─────────────────────────────
export const projectContractRouter = Router({ mergeParams: true });

projectContractRouter.get(
    "/dossier",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await getDossier(createServerSupabase(), caller(res), req.params.projectId));
    }),
);

projectContractRouter.put(
    "/dossier",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await putDossier(createServerSupabase(), caller(res), req.params.projectId, body(req)));
    }),
);

projectContractRouter.get(
    "/preview",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await getContractPreview(createServerSupabase(), caller(res), req.params.projectId));
    }),
);

projectContractRouter.get(
    "/preview/file",
    requireAuth,
    asyncRoute(async (req, res) => {
        const result = await getContractPreviewFile(
            createServerSupabase(),
            caller(res),
            req.params.projectId,
        );
        if (!result.ok) return void sendServiceFailure(res, result);
        res.setHeader("Content-Type", result.data.contentType);
        res.setHeader("Content-Disposition", `inline; filename="${result.data.filename}"`);
        res.send(result.data.bytes);
    }),
);

projectContractRouter.get(
    "/terms",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await getContractTerms(createServerSupabase(), caller(res), req.params.projectId));
    }),
);

projectContractRouter.post(
    "/terms/extract",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(
            res,
            await extractContractTerms(createServerSupabase(), caller(res), req.params.projectId),
        );
    }),
);

projectContractRouter.use(routerErrorHandler("[contracts]"));

// ── /acervo ──────────────────────────────────────────────────────────────────
export const acervoRouter = Router();

acervoRouter.post(
    "/",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await askAcervo(createServerSupabase(), caller(res), body(req)));
    }),
);

acervoRouter.use(routerErrorHandler("[acervo]"));

// ── /integrations ────────────────────────────────────────────────────────────
export const integrationsRouter = Router();

integrationsRouter.get(
    "/status",
    requireAuth,
    asyncRoute(async (_req, res) => {
        res.json(await integrationStatus());
    }),
);

// Mirror the pipeline to Notion now, instead of waiting for the next tick.
integrationsRouter.post(
    "/notion/sync",
    requireAuth,
    asyncRoute(async (_req, res) => {
        res.json(await syncPipelineToNotion());
    }),
);

// Push any documents that have no Drive copy yet.
integrationsRouter.post(
    "/drive/sync",
    requireAuth,
    asyncRoute(async (req, res) => {
        const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
        res.json(await syncDocumentsToDrive(limit));
    }),
);

// Push the radar's deadlines onto the shared calendar.
integrationsRouter.post(
    "/calendar/sync",
    requireAuth,
    asyncRoute(async (_req, res) => {
        res.json(await syncObligationsToCalendar());
    }),
);

// Extract commercial terms for the caller's contracts that have none yet.
integrationsRouter.post(
    "/terms/extract-missing",
    requireAuth,
    asyncRoute(async (req, res) => {
        const limit = Math.min(Number(req.query.limit ?? 100) || 100, 200);
        send(res, await extractMissingContractTerms(createServerSupabase(), caller(res), limit));
    }),
);

integrationsRouter.use(routerErrorHandler("[integrations]"));
