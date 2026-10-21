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
