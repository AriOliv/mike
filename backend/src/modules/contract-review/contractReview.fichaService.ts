// Reading, extracting and validating a contract's Ficha. The extraction runs
// the review slice of the schema through one model call, verifies every quote
// by code, merges with what people already validated, then recomputes the
// rule findings and the card's overall risk.

import type { Db } from "../../lib/supabase";
import { completeText } from "../../lib/llm";
import { downloadFile } from "../../lib/storage";
import { extractDocxBodyText } from "../../lib/docxTrackedChanges";
import { extractPdfText } from "../../lib/pdfText";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { getUserModelSettings } from "../user/user.service";
import {
    applyFieldDecision,
    correctionChoices,
    extractionPrompt,
    FICHA_FIELDS,
    validCorrection,
    fichaProgress,
    isFichaPath,
    mergeExtraction,
    normalizeExtraction,
    type Ficha,
    type FichaField,
} from "./contractReview.ficha";
import { evaluateRules, overallRisk, RULES_VERSION, type RiskFinding } from "./contractReview.rules";
import {
    contractDocument,
    parseModelJson,
    requireContractEdit,
    requireContractView,
    type Caller,
    type ContractDocument,
} from "./contractReview.shared";

class FichaChangedError extends Error {}

export const FICHA_PROMPT_VERSION = "ficha-revisao-v1";

export const MODEL_REQUIRED =
    "Escolha um modelo de revisão tabular em Configurações antes de extrair a Ficha.";

export type FichaView = {
    ficha: Ficha | null;
    /** How each field can be corrected: its options, "boolean", or null for free text. */
    choices: Record<string, ReturnType<typeof correctionChoices>>;
    findings: RiskFinding[];
    risk_overall: "critico" | "atencao" | "ok" | null;
    progress: { verified: number; total: number };
    document_id: string | null;
    extracted_at: string | null;
    model: string | null;
};

type FichaRow = {
    project_id: string;
    updated_at?: string;
    ficha: Ficha | null;
    findings: RiskFinding[] | null;
    risk_overall: FichaView["risk_overall"];
    document_id: string | null;
    extracted_at: string | null;
    model: string | null;
};

function view(row: FichaRow | null): FichaView {
    const ficha = row?.ficha && Object.keys(row.ficha).length ? row.ficha : null;
    return {
        ficha,
        choices: Object.fromEntries(FICHA_FIELDS.map((field) => [field.path, correctionChoices(field.path)])),
        findings: row?.findings ?? [],
        risk_overall: row?.risk_overall ?? null,
        progress: fichaProgress(ficha),
        document_id: row?.document_id ?? null,
        extracted_at: row?.extracted_at ?? null,
        model: row?.model ?? null,
    };
}

async function loadRow(db: Db, projectId: string): Promise<FichaRow | null> {
    const { data, error } = await db
        .from("contract_fichas")
        .select("project_id, ficha, findings, risk_overall, document_id, extracted_at, model, updated_at")
        .eq("project_id", projectId)
        .maybeSingle();
    if (error) throw error;
    return (data as FichaRow | null) ?? null;
}

export async function getFicha(db: Db, caller: Caller, projectId: string): Promise<ServiceResult<FichaView>> {
    const allowed = await requireContractView(db, caller, projectId);
    if (!allowed.ok) return allowed;
    try {
        return ok(view(await loadRow(db, projectId)));
    } catch (error) {
        return internalFailure(error);
    }
}

/** The contract's text as the redline matcher reads it, so quotes line up with edits. */
export async function contractText(doc: ContractDocument): Promise<string> {
    const raw = await downloadFile(doc.storagePath);
    if (!raw) return "";
    const bytes = Buffer.from(raw);
    if (doc.isDocx) return extractDocxBodyText(bytes);
    if (doc.fileType === "pdf") return (await extractPdfText(raw)).trim();
    return "";
}

async function saveFicha(
    db: Db,
    projectId: string,
    ficha: Ficha,
    extra: Partial<Record<string, unknown>>,
    /** Writes only if the row is still the one read: a concurrent save is not lost. */
    expectedUpdatedAt?: string,
): Promise<Pick<FichaRow, "ficha" | "findings" | "risk_overall"> & Partial<FichaRow>> {
    const findings = evaluateRules(ficha);
    const now = new Date().toISOString();
    const row = {
        project_id: projectId,
        ficha,
        findings,
        risk_overall: overallRisk(findings),
        rules_version: RULES_VERSION,
        updated_at: now,
        ...extra,
    };
    if (expectedUpdatedAt) {
        const { data, error } = await db
            .from("contract_fichas")
            .update(row)
            .eq("project_id", projectId)
            .eq("updated_at", expectedUpdatedAt)
            .select("project_id");
        if (error) throw error;
        if (!Array.isArray(data) || data.length === 0) throw new FichaChangedError();
    } else {
        const { error } = await db.from("contract_fichas").upsert(row, { onConflict: "project_id" });
        if (error) throw error;
    }
    return row as Pick<FichaRow, "ficha" | "findings" | "risk_overall"> & Partial<FichaRow>;
}

export async function extractFicha(
    db: Db,
    caller: Caller,
    projectId: string,
): Promise<ServiceResult<FichaView>> {
    const allowed = await requireContractEdit(db, caller, projectId);
    if (!allowed.ok) return allowed;
    try {
        const settings = await getUserModelSettings(caller.userId, db, { orgId: allowed.access.project?.org_id ?? null });
        const model = settings.tabular_model ?? settings.last_selected_chat_model;
        if (!model) return failure("validation", MODEL_REQUIRED, "model_required");
        const doc = await contractDocument(db, projectId);
        if (!doc) return failure("validation", "Envie o contrato (.docx ou PDF) antes de extrair a Ficha.");
        const text = await contractText(doc);
        if (!text.trim()) return failure("validation", "Não consegui ler o texto do contrato.");
        const raw = await completeText({
            model,
            systemPrompt:
                "Você é um analista jurídico brasileiro extraindo dados de um contrato. Responda apenas com JSON válido.",
            user: extractionPrompt(text),
            maxTokens: 12_000,
            apiKeys: settings.api_keys,
        });
        let parsed: unknown;
        try {
            parsed = parseModelJson(raw);
        } catch (error) {
            // Size only: the answer quotes contract text.
            console.warn(`[ficha] unparseable extraction (${raw.length} chars)`);
            throw error;
        }
        const fields = (parsed as { fields?: unknown } | null)?.fields;
        // An answer with no fields would reset every field to "not found".
        if (!fields || typeof fields !== "object" || Object.keys(fields).length === 0)
            throw new Error("model returned no Ficha fields");
        const previous = (await loadRow(db, projectId))?.ficha ?? null;
        const ficha = mergeExtraction(previous, normalizeExtraction(parsed, text));
        const now = new Date().toISOString();
        const saved = await saveFicha(db, projectId, ficha, {
            document_id: doc.documentId,
            document_version_id: doc.versionId,
            model,
            prompt_version: FICHA_PROMPT_VERSION,
            extracted_at: now,
        });
        return ok(view({ project_id: projectId, document_id: null, extracted_at: null, model: null, ...saved }));
    } catch (error) {
        return internalFailure(error);
    }
}

/** Confirm or correct one field; the rules re-run on the result. */
export async function decideFichaField(
    db: Db,
    caller: Caller,
    projectId: string,
    body: Record<string, unknown>,
): Promise<ServiceResult<FichaView>> {
    const path = body.path;
    const action = body.action;
    if (!isFichaPath(path)) return failure("validation", "Campo da Ficha desconhecido.");
    if (action !== "confirmar" && action !== "corrigir") return failure("validation", "Ação deve ser confirmar ou corrigir.");
    if (action === "corrigir" && !("value" in body)) return failure("validation", "Informe o valor corrigido.");
    if (action === "corrigir" && !validCorrection(path, body.value))
        return failure("validation", "Escolha um dos valores deste campo.");
    const comment = typeof body.comment === "string" ? body.comment.trim().slice(0, 500) || null : null;
    const allowed = await requireContractEdit(db, caller, projectId);
    if (!allowed.ok) return allowed;
    try {
        const row = await loadRow(db, projectId);
        const field = row?.ficha?.[path] as FichaField | undefined;
        if (!row?.ficha || !field) return failure("not_found", "Extraia a Ficha antes de validar campos.");
        const by = caller.userEmail ?? caller.userId;
        const now = new Date().toISOString();
        const decided = applyFieldDecision(
            field,
            action === "confirmar" ? { action, by, comment } : { action, by, value: body.value ?? null, comment },
            now,
        );
        const saved = await saveFicha(db, projectId, { ...row.ficha, [path]: decided }, {}, row.updated_at);
        const { error } = await db.from("contract_field_reviews").insert({
            project_id: projectId,
            path,
            action: decided.review.state,
            ai_value: decided.ai_value ?? field.value ?? null,
            final_value: decided.value ?? null,
            reviewer: by,
            comment,
        });
        if (error) throw error;
        return ok(view({ ...row, ...saved }));
    } catch (error) {
        if (error instanceof FichaChangedError)
            return failure("conflict", "Outra pessoa acabou de alterar a Ficha. Recarregue e tente de novo.");
        return internalFailure(error);
    }
}
