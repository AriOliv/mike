// Extraction of the commercial terms a legal team tracks per contract:
// renewal and the notice window that stops it, penalties, liability cap, and
// how the counterparty may change the deal unilaterally.
//
// Every value carries the clause it came from. A term with no clause is not
// recorded — a tracked obligation nobody can trace is worse than a blank.

import type { Db } from "../../lib/supabase";
import { listAccessibleProjectIds } from "../../lib/access";
import { completeText } from "../../lib/llm";
import {
    failure,
    internalFailure,
    ok,
    type ServiceResult,
} from "../../lib/serviceResult";
import {
    analysisModel,
    contractFileText,
    excerpt,
    isIsoDate,
    latestContractFiles,
    parseModelJson,
    requireProjectEdit,
    requireProjectView,
    type Caller,
} from "./contracts.shared";

// How much lead time the team wants before the notice window closes.
export const ALERT_LEAD_DAYS = Number(process.env.RENEWAL_ALERT_LEAD_DAYS ?? 90);

const HEAD_CHARS = 14000;
const TAIL_CHARS = 12000;

const SYSTEM = `Você é um analista jurídico extraindo os termos comerciais de um contrato.

Regras invioláveis:
- Extraia SOMENTE o que está no texto. Nunca invente valor, prazo ou cláusula.
- Todo campo preenchido precisa do trecho VERBATIM que o embasa, em "sources".
- Se algo não constar no texto, use null (e não invente).
- Responda apenas com JSON válido, sem cercas de código.`;

const SCHEMA = {
    auto_renewal: "true se há renovação automática; false se não; null se não consta",
    term_end: "data de término da vigência atual em YYYY-MM-DD, ou null",
    notice_days: "número de dias de aviso prévio para não renovar/rescindir, ou null",
    penalty_value: "valor/fórmula da multa como texto (ex.: '20% do valor restante'), ou null",
    penalty_recurrence: "'unica' se a multa é aplicada uma vez; 'por_evento' se por ocorrência; null",
    liability_cap: "limite de responsabilidade como texto (ex.: 'valor pago nos últimos 12 meses'), ou null",
    unilateral_amendment: "true se a contraparte pode alterar o contrato ao seu exclusivo critério; false; null",
    amendment_notes: "como as alterações podem ser feitas (aviso, aceite, etc.), ou null",
    price_regulatory_impact: "alterações que impactem preço ou aspectos regulatórios, ou null",
    contract_type:
        "classificação curta do tipo de contrato (ex.: 'NDA', 'Prestação de serviços', 'MSA', 'Licenciamento', 'Locação', 'Parceria'), ou null. É uma classificação, não precisa de trecho em sources.",
    sources: {
        "<campo>": "trecho VERBATIM do contrato que embasa aquele campo",
    },
};

const COLUMNS =
    "project_id, auto_renewal, term_end, notice_days, notice_deadline, penalty_value, penalty_recurrence, liability_cap, unilateral_amendment, amendment_notes, price_regulatory_impact, sources, extracted_at";

export type ContractTerms = {
    auto_renewal: boolean | null;
    term_end: string | null;
    notice_days: number | null;
    notice_deadline: string | null;
    penalty_value: string | null;
    penalty_recurrence: string | null;
    liability_cap: string | null;
    unilateral_amendment: boolean | null;
    amendment_notes: string | null;
    price_regulatory_impact: string | null;
    sources: Record<string, string>;
};

function boolOrNull(value: unknown): boolean | null {
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    return null;
}

function textOrNull(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function shiftDays(date: string, days: number): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/** null when nothing has been extracted yet. */
export async function getContractTerms(
    db: Db,
    caller: Caller,
    projectId: string,
): Promise<ServiceResult<Record<string, unknown> | null>> {
    const access = await requireProjectView(db, caller, projectId);
    if (!access.ok) return access;
    const { data, error } = await db
        .from("contract_terms")
        .select(COLUMNS)
        .eq("project_id", projectId)
        .maybeSingle();
    if (error) return internalFailure(error);
    return ok((data as Record<string, unknown> | null) ?? null);
}

/** (Re)read the contract and store its terms. */
export async function extractContractTerms(
    db: Db,
    caller: Caller,
    projectId: string,
): Promise<ServiceResult<ContractTerms>> {
    const access = await requireProjectEdit(db, caller, projectId);
    if (!access.ok) return access;
    const selected = await analysisModel(db, caller.userId);
    if (!selected.ok) return selected;
    try {
        const terms = await extractTerms(db, caller.userId, projectId, selected);
        if (!terms) return failure("validation", "Could not read the contract", "contract_unreadable");
        return ok(terms);
    } catch (error) {
        return internalFailure(error);
    }
}

/**
 * Extraction for a background agent acting for the person who queued it. The
 * job already decided who that is, so there is no caller check here; it
 * returns null when the contract has no readable text.
 */
export function extractTermsForAgent(
    db: Db,
    userId: string,
    projectId: string,
    selected: Extract<Awaited<ReturnType<typeof analysisModel>>, { ok: true }>,
): Promise<ContractTerms | null> {
    return extractTerms(db, userId, projectId, selected);
}

async function extractTerms(
    db: Db,
    userId: string,
    projectId: string,
    selected: Extract<Awaited<ReturnType<typeof analysisModel>>, { ok: true }>,
): Promise<ContractTerms | null> {
    const file = (await latestContractFiles(db, [projectId])).get(projectId);
    const text = file ? await contractFileText(file) : "";
    if (!text) return null;

    const raw = await completeText({
        model: selected.model,
        systemPrompt: SYSTEM,
        user: `Extraia os termos comerciais do contrato abaixo.

Schema de saída (JSON):
${JSON.stringify(SCHEMA, null, 2)}

CONTRATO:
${excerpt(text, HEAD_CHARS, TAIL_CHARS)}`,
        // A reasoning model spends part of the budget thinking; a JSON answer
        // cut mid-object is unusable.
        maxTokens: 8000,
        apiKeys: selected.settings.api_keys,
    });

    const parsed = parseModelJson(raw);
    const termEnd = isIsoDate(parsed.term_end) ? parsed.term_end.trim() : null;
    const noticeDays =
        typeof parsed.notice_days === "number" && Number.isFinite(parsed.notice_days)
            ? Math.trunc(parsed.notice_days)
            : null;

    const terms: ContractTerms = {
        auto_renewal: boolOrNull(parsed.auto_renewal),
        term_end: termEnd,
        notice_days: noticeDays,
        // The date the decision must be made by. Only meaningful when both the
        // end of the term and the notice period are known.
        notice_deadline: termEnd && noticeDays !== null ? shiftDays(termEnd, -noticeDays) : null,
        penalty_value: textOrNull(parsed.penalty_value),
        penalty_recurrence: ["unica", "por_evento"].includes(String(parsed.penalty_recurrence))
            ? String(parsed.penalty_recurrence)
            : null,
        liability_cap: textOrNull(parsed.liability_cap),
        unilateral_amendment: boolOrNull(parsed.unilateral_amendment),
        amendment_notes: textOrNull(parsed.amendment_notes),
        price_regulatory_impact: textOrNull(parsed.price_regulatory_impact),
        sources:
            parsed.sources && typeof parsed.sources === "object"
                ? (parsed.sources as Record<string, string>)
                : {},
    };

    const { error } = await db.from("contract_terms").upsert(
        {
            project_id: projectId,
            user_id: userId,
            ...terms,
            extracted_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        },
        { onConflict: "project_id" },
    );
    if (error) throw error;

    // Contract type is a derived card field (like risk), so it lives on the
    // project, not on contract_terms. Only write a real classification — never
    // blank out a value with a null the model wasn't sure about.
    const contractType = textOrNull(parsed.contract_type);
    if (contractType) {
        await db.from("projects").update({ contract_type: contractType }).eq("id", projectId);
    }

    await syncRenewalObligations(db, projectId, userId, terms);
    return terms;
}

/**
 * Turn a renewal window into dated obligations: the notice deadline itself, and
 * an alert far enough ahead to still act on it. Both are marked `renewal` so a
 * re-extraction refreshes them without disturbing hand-entered deadlines.
 */
async function syncRenewalObligations(
    db: Db,
    projectId: string,
    userId: string,
    terms: ContractTerms,
): Promise<void> {
    await db.from("obligations").delete().eq("project_id", projectId).eq("origin", "renewal");
    if (!terms.notice_deadline) return;

    const quote = terms.sources?.notice_days ?? terms.sources?.auto_renewal ?? null;
    const rows = [
        {
            user_id: userId,
            project_id: projectId,
            title: `Prazo limite para avisar não renovação (${terms.notice_days} dias de aviso prévio)`,
            mark: "critico",
            due_date: terms.notice_deadline,
            source_quote: quote,
            origin: "renewal",
        },
        {
            user_id: userId,
            project_id: projectId,
            title: "Decidir sobre renovação — janela de aviso fecha em breve",
            mark: "tarefa",
            due_date: shiftDays(terms.notice_deadline, -ALERT_LEAD_DAYS),
            source_quote: quote,
            origin: "renewal",
        },
    ];
    await db.from("obligations").insert(rows);
}

export type TermsSyncSummary = { extracted: number; skipped: number; errors: number };

/** Extract terms for every pipeline contract the caller can edit that has none yet. */
export async function extractMissingContractTerms(
    db: Db,
    caller: Caller,
    limit = 100,
): Promise<ServiceResult<TermsSyncSummary>> {
    const selected = await analysisModel(db, caller.userId);
    if (!selected.ok) return selected;
    const summary: TermsSyncSummary = { extracted: 0, skipped: 0, errors: 0 };

    let ids: string[];
    try {
        ids = await listAccessibleProjectIds(caller.userId, caller.userEmail, db);
    } catch (error) {
        return internalFailure(error);
    }
    if (ids.length === 0) return ok(summary);

    const { data: existing, error: existingError } = await db
        .from("contract_terms")
        .select("project_id");
    if (existingError) return internalFailure(existingError);
    const done = new Set(((existing ?? []) as { project_id: string }[]).map((r) => r.project_id));

    const pending: string[] = [];
    for (let i = 0; i < ids.length && pending.length < limit; i += 200) {
        const { data, error } = await db
            .from("projects")
            .select("id")
            .in("id", ids.slice(i, i + 200))
            .not("lane", "is", null)
            .is("archived_at", null);
        if (error) return internalFailure(error);
        for (const p of (data ?? []) as { id: string }[]) {
            if (!done.has(p.id) && pending.length < limit) pending.push(p.id);
        }
    }

    for (const projectId of pending) {
        const access = await requireProjectEdit(db, caller, projectId);
        if (!access.ok) {
            summary.skipped++;
            continue;
        }
        try {
            const terms = await extractTerms(db, caller.userId, projectId, selected);
            if (terms) summary.extracted++;
            else summary.skipped++;
        } catch (e) {
            summary.errors++;
            console.warn(`[terms] ${projectId} failed: ${(e as Error).message}`);
        }
    }
    console.log(`[terms] sync: ${JSON.stringify(summary)}`);
    return ok(summary);
}
