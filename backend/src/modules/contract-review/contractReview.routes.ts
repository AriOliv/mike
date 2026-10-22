// HTTP layer for the contract-review module, mounted at
// /projects/:projectId/contract-review (one contract) and /contracts (the
// portfolio). Handlers read the caller, call the
// service, and map its ServiceResult onto status codes.

import { Router, type Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure, type ServiceResult } from "../../lib/serviceResult";
import {
    decideFichaField,
    decideReviewClause,
    extractFicha,
    getContractReview,
    getFicha,
    listContractPortfolio,
    listContractReviews,
    startContractReview,
    analysisDocx,
    decideAnalysisRedline,
    exportAnalysis,
    getAnalysisById,
    getLatestAnalysis,
    listRedlineDecisions,
    startAnalystAnalysis,
    type Caller,
} from "./contractReview.service";

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

export const contractReviewRouter = Router({ mergeParams: true });
contractReviewRouter.use(requireAuth);

contractReviewRouter.get(
    "/reviews",
    asyncRoute(async (req, res) => {
        send(res, await listContractReviews(createServerSupabase(), caller(res), req.params.projectId));
    }),
);

contractReviewRouter.post(
    "/reviews",
    asyncRoute(async (req, res) => {
        send(res, await startContractReview(createServerSupabase(), caller(res), req.params.projectId, body(req)), 202);
    }),
);

contractReviewRouter.get(
    "/reviews/:runId",
    asyncRoute(async (req, res) => {
        send(
            res,
            await getContractReview(createServerSupabase(), caller(res), req.params.projectId, req.params.runId),
        );
    }),
);

contractReviewRouter.post(
    "/reviews/:runId/clauses/:findingId/decision",
    asyncRoute(async (req, res) => {
        send(
            res,
            await decideReviewClause(
                createServerSupabase(),
                caller(res),
                req.params.projectId,
                req.params.runId,
                req.params.findingId,
                body(req),
            ),
        );
    }),
);

contractReviewRouter.get(
    "/ficha",
    asyncRoute(async (req, res) => {
        send(res, await getFicha(createServerSupabase(), caller(res), req.params.projectId));
    }),
);

contractReviewRouter.post(
    "/ficha/extract",
    asyncRoute(async (req, res) => {
        send(res, await extractFicha(createServerSupabase(), caller(res), req.params.projectId));
    }),
);

contractReviewRouter.patch(
    "/ficha/fields",
    asyncRoute(async (req, res) => {
        send(res, await decideFichaField(createServerSupabase(), caller(res), req.params.projectId, body(req)));
    }),
);

// The analyst's analysis: a draft for the legal team (editors of the contract).
contractReviewRouter.get(
    "/analysis",
    asyncRoute(async (req, res) => {
        send(res, await getLatestAnalysis(createServerSupabase(), caller(res), req.params.projectId));
    }),
);

contractReviewRouter.post(
    "/analysis",
    asyncRoute(async (req, res) => {
        const input = body(req);
        send(
            res,
            await startAnalystAnalysis(createServerSupabase(), caller(res), req.params.projectId, {
                request_id: input.request_id as string | null | undefined,
                intake: input.intake,
            }),
            202,
        );
    }),
);

contractReviewRouter.get(
    "/analysis/:analysisId",
    asyncRoute(async (req, res) => {
        const result = await getAnalysisById(createServerSupabase(), caller(res), req.params.analysisId);
        // An analysis of another contract answers like one that does not exist.
        if (result.ok && result.data.project_id !== req.params.projectId)
            return void res.status(404).json({ detail: "Análise não encontrada." });
        send(res, result);
    }),
);

contractReviewRouter.get(
    "/analysis/:analysisId/decisions",
    asyncRoute(async (req, res) => {
        send(res, await listRedlineDecisions(createServerSupabase(), caller(res), req.params.projectId, req.params.analysisId));
    }),
);

contractReviewRouter.post(
    "/analysis/:analysisId/redlines/:redlineId/decision",
    asyncRoute(async (req, res) => {
        send(
            res,
            await decideAnalysisRedline(
                createServerSupabase(),
                caller(res),
                req.params.projectId,
                req.params.analysisId,
                req.params.redlineId,
                body(req),
            ),
        );
    }),
);

// ?format=md (default) answers the text; ?format=docx a Word file.
contractReviewRouter.get(
    "/analysis/:analysisId/export",
    asyncRoute(async (req, res) => {
        const result = await exportAnalysis(createServerSupabase(), caller(res), req.params.projectId, req.params.analysisId);
        if (!result.ok) return void send(res, result);
        const { filename, markdown } = result.data;
        if (req.query.format === "docx") {
            const file = await analysisDocx(markdown);
            res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
            res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.docx`)}`);
            return void res.send(file);
        }
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.md`)}`);
        res.send(markdown);
    }),
);

contractReviewRouter.use(routerErrorHandler("[contract-review]"));

// ── /contracts: the portfolio across every contract the caller can open ─────
export const contractPortfolioRouter = Router();
contractPortfolioRouter.use(requireAuth);

contractPortfolioRouter.get(
    "/fichas",
    asyncRoute(async (req, res) => {
        send(res, await listContractPortfolio(createServerSupabase(), caller(res), req.query as Record<string, unknown>));
    }),
);

contractPortfolioRouter.use(routerErrorHandler("[contracts]"));
