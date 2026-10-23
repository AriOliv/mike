// GET /cnpj/:cnpj — the company record of a CNPJ, for the counterparty field.

import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure } from "../../lib/serviceResult";
import { lookupCnpj } from "./cnpj.lookup";

export const cnpjRouter = Router();

cnpjRouter.get(
    "/:cnpj",
    requireAuth,
    asyncRoute(async (req, res) => {
        const result = await lookupCnpj(createServerSupabase(), String(req.params.cnpj));
        if (!result.ok) return void sendServiceFailure(res, result);
        res.json(result.data);
    }),
);
