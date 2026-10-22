// HTTP layer for the contracts module. Handlers read the caller off
// res.locals, call the service, and map its ServiceResult onto status codes.

import { Router, type Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure, type ServiceResult } from "../../lib/serviceResult";
import { resolveWorkspaceFilter, sendWorkspaceFailure } from "../../lib/workspace";
import { listLegalTeamMembers, whoAmI } from "../requests/requests.service";
import {
    askAcervo,
    createWatchedFolder,
    getHomeSummary,
    getLatestReview,
    listWatchedFolders,
    requestReview,
    updateContractReview,
    watchProject,
    createObligation,
    deleteObligation,
    extractContractTerms,
    extractMissingContractTerms,
    getContractPreview,
    getContractPreviewFile,
    getContractTerms,
    getDossier,
    integrationStatus,
    listObligationAlerts,
    listObligations,
    listCardEvents,
    listPipeline,
    putDossier,
    syncDocumentsToDrive,
    syncObligationsToCalendar,
    syncPipelineToNotion,
    updateObligation,
    updatePipelineCard,
    type Caller,
    type OwnerOptions,
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

// Before "/:id": the alerts waiting for this person today.
obligationsRouter.get(
    "/alerts",
    requireAuth,
    asyncRoute(async (_req, res) => {
        send(res, await listObligationAlerts(createServerSupabase(), caller(res)));
    }),
);

// Who can own a deadline: the legal team's people, for the picker.
obligationsRouter.get(
    "/owners",
    requireAuth,
    asyncRoute(async (_req, res) => {
        send(res, await listLegalTeamMembers(createServerSupabase(), caller(res)));
    }),
);

/**
 * Whom a deadline may be handed to, when the body names someone: the legal
 * team's e-mails. With no team set up there is nothing to check against, so
 * any valid e-mail goes; someone outside the team cannot name an owner.
 */
async function ownerOptions(
    db: ReturnType<typeof createServerSupabase>,
    who: Caller,
    payload: Record<string, unknown>,
): Promise<OwnerOptions> {
    if (typeof payload.owner_email !== "string" || payload.owner_email.trim() === "") return {};
    const team = await listLegalTeamMembers(db, who);
    if (team.ok) return { members: team.data.map((m) => m.email) };
    return team.kind === "unavailable" ? {} : { members: [] };
}

obligationsRouter.post(
    "/",
    requireAuth,
    asyncRoute(async (req, res) => {
        const db = createServerSupabase();
        const options = await ownerOptions(db, caller(res), body(req));
        send(res, await createObligation(db, caller(res), body(req), options), 201);
    }),
);

obligationsRouter.patch(
    "/:id",
    requireAuth,
    asyncRoute(async (req, res) => {
        const db = createServerSupabase();
        const options = await ownerOptions(db, caller(res), body(req));
        send(res, await updateObligation(db, caller(res), req.params.id, body(req), options));
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

// ── /projects/:projectId/{dossier,preview,terms,activity,review} ─────────────────────────────
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

projectContractRouter.get(
    "/activity",
    requireAuth,
    asyncRoute(async (req, res) => {
        const limit = Number(req.query.limit ?? 50);
        send(
            res,
            await listCardEvents(createServerSupabase(), caller(res), req.params.projectId, limit),
        );
    }),
);

projectContractRouter.get(
    "/review",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await getLatestReview(createServerSupabase(), caller(res), req.params.projectId));
    }),
);

// Review the card's latest document now ("Revisar de novo", or right after a
// batch upload) instead of waiting for the next folder scan.
projectContractRouter.post(
    "/review",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await requestReview(createServerSupabase(), caller(res), req.params.projectId), 202);
    }),
);

projectContractRouter.use(routerErrorHandler("[contracts]"));

// ── /home ────────────────────────────────────────────────────────────────────
export const homeRouter = Router();

homeRouter.get(
    "/",
    requireAuth,
    asyncRoute(async (req, res) => {
        const db = createServerSupabase();
        const workspace = await resolveWorkspaceFilter(db, res.locals.userId as string, req.query.workspace);
        if (!workspace.ok) return void sendWorkspaceFailure(res, workspace);
        // Someone outside the legal team never gets the portfolio here, grants or not.
        const me = await whoAmI(db, caller(res));
        if (!me.ok) return void sendServiceFailure(res, me);
        const audience = me.data.configured && me.data.role === "requester" ? "requester" : "team";
        send(res, await getHomeSummary(db, caller(res), new Date(), workspace.workspace, audience));
    }),
);

homeRouter.use(routerErrorHandler("[home]"));

// ── /watched-folders and /contract-reviews ──────────────────────────────────
export const watchedFoldersRouter = Router();

watchedFoldersRouter.get(
    "/",
    requireAuth,
    asyncRoute(async (_req, res) => {
        send(res, await listWatchedFolders(createServerSupabase(), caller(res)));
    }),
);

watchedFoldersRouter.post(
    "/",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(res, await createWatchedFolder(createServerSupabase(), caller(res), body(req)), 201);
    }),
);

watchedFoldersRouter.put(
    "/:folderId/projects/:projectId",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(
            res,
            await watchProject(createServerSupabase(), caller(res), req.params.folderId, req.params.projectId),
        );
    }),
);

watchedFoldersRouter.use(routerErrorHandler("[watched-folders]"));

export const contractReviewsRouter = Router();

contractReviewsRouter.patch(
    "/:reviewId",
    requireAuth,
    asyncRoute(async (req, res) => {
        send(
            res,
            await updateContractReview(createServerSupabase(), caller(res), req.params.reviewId, body(req)),
        );
    }),
);

contractReviewsRouter.use(routerErrorHandler("[contract-reviews]"));

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
