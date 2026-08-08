// Commercial terms of a contract: renewal window, penalties, liability cap and
// amendment rights — each traceable to the clause it came from.
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { checkProjectAccess } from "../lib/access";
import { extractContractTerms, extractMissingContractTerms } from "../lib/contractTerms";

export const termsRouter = Router({ mergeParams: true });

const COLUMNS =
    "project_id, auto_renewal, term_end, notice_days, notice_deadline, penalty_value, penalty_recurrence, liability_cap, unilateral_amendment, amendment_notes, price_regulatory_impact, sources, extracted_at";

// GET /projects/:projectId/terms — null when nothing has been extracted yet.
termsRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    const access = await checkProjectAccess(req.params.projectId, userId, userEmail, db);
    if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

    const { data, error } = await db
        .from("contract_terms")
        .select(COLUMNS)
        .eq("project_id", req.params.projectId)
        .maybeSingle();
    if (error) return void res.status(500).json({ detail: error.message });
    res.json(data ?? null);
});

// POST /projects/:projectId/terms/extract — (re)read the contract.
termsRouter.post("/extract", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    const access = await checkProjectAccess(req.params.projectId, userId, userEmail, db);
    if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

    try {
        const terms = await extractContractTerms(req.params.projectId, userId);
        if (!terms) return void res.status(422).json({ detail: "Could not read the contract" });
        res.json(terms);
    } catch (e) {
        console.warn(`[terms] extract failed: ${(e as Error).message}`);
        res.status(502).json({ detail: "Could not extract the terms." });
    }
});
