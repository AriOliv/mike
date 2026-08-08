// Extraction of the commercial terms a legal team tracks per contract:
// renewal and the notice window that stops it, penalties, liability cap, and
// how the counterparty may change the deal unilaterally.
//
// Every value carries the clause it came from. A term with no clause is not
// recorded — a tracked obligation nobody can trace is worse than a blank.
import { createServerSupabase } from "./supabase";
import { downloadFile } from "./storage";
import { extractPdfText } from "./chat/tools/documentOps";
import { completeText, resolveModel, DEFAULT_TABULAR_MODEL } from "./llm";
import { getUserModelSettings } from "./userSettings";

// How much lead time the team wants before the notice window closes.
export const ALERT_LEAD_DAYS = Number(process.env.RENEWAL_ALERT_LEAD_DAYS ?? 90);

const HEAD_CHARS = 14000;
const TAIL_CHARS = 12000;

/** Head and tail: renewal, term, penalties and liability sit at the END. */
function excerpt(text: string): string {
    if (text.length <= HEAD_CHARS + TAIL_CHARS) return text;
    return (
        text.slice(0, HEAD_CHARS) +
        "\n\n[...trecho intermediário omitido...]\n\n" +
        text.slice(-TAIL_CHARS)
    );
}

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
    sources: {
        "<campo>": "trecho VERBATIM do contrato que embasa aquele campo",
    },
};

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

function parseJson(raw: string): Record<string, unknown> {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    try {
        return JSON.parse(cleaned) as Record<string, unknown>;
    } catch {
        const start = cleaned.indexOf("{");
        const end = cleaned.lastIndexOf("}");
        if (start !== -1 && end > start) {
            return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
        }
        throw new Error("model did not return JSON");
    }
}

function isoDate(value: unknown): string | null {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
        ? value.trim()
        : null;
}

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

async function contractText(projectId: string, db: ReturnType<typeof createServerSupabase>) {
    const { data: docs } = await db.from("documents").select("id").eq("project_id", projectId);
    const ids = ((docs ?? []) as { id: string }[]).map((d) => d.id);
    if (ids.length === 0) return null;

    const { data: versions } = await db
        .from("document_versions")
        .select("document_id, storage_path, pdf_storage_path, version_number, deleted_at")
        .in("document_id", ids);

    type V = {
        storage_path: string | null;
        pdf_storage_path: string | null;
        version_number: number | null;
        deleted_at: string | null;
    };
    const version = ((versions ?? []) as unknown as V[])
        .filter((v) => !v.deleted_at && (v.pdf_storage_path || v.storage_path))
        .sort((a, b) => (b.version_number ?? 0) - (a.version_number ?? 0))[0];
    if (!version) return null;

    const bytes = await downloadFile(version.pdf_storage_path ?? version.storage_path!);
    if (!bytes) return null;
    const text = await extractPdfText(bytes);
    return text.trim() ? excerpt(text) : null;
}

/** Extract (and store) the terms of one contract. */
export async function extractContractTerms(
    projectId: string,
    userId: string,
): Promise<ContractTerms | null> {
    const db = createServerSupabase();
    const text = await contractText(projectId, db);
    if (!text) return null;

    const settings = await getUserModelSettings(userId, db);
    const model = resolveModel(settings.tabular_model, DEFAULT_TABULAR_MODEL);
    const raw = await completeText({
        model,
        systemPrompt: SYSTEM,
        user: `Extraia os termos comerciais do contrato abaixo.

Schema de saída (JSON):
${JSON.stringify(SCHEMA, null, 2)}

CONTRATO:
${text}`,
        // A reasoning model spends part of the budget thinking; a JSON answer
        // cut mid-object is unusable.
        maxTokens: 8000,
    });

    const parsed = parseJson(raw);
    const termEnd = isoDate(parsed.term_end);
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

    await db.from("contract_terms").upsert(
        {
            project_id: projectId,
            user_id: userId,
            ...terms,
            extracted_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        },
        { onConflict: "project_id" },
    );

    await syncRenewalObligations(projectId, userId, terms, db);
    return terms;
}

/**
 * Turn a renewal window into dated obligations: the notice deadline itself, and
 * an alert far enough ahead to still act on it. Both are marked `renewal` so a
 * re-extraction refreshes them without disturbing hand-entered deadlines.
 */
async function syncRenewalObligations(
    projectId: string,
    userId: string,
    terms: ContractTerms,
    db: ReturnType<typeof createServerSupabase>,
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

/** Extract terms for every pipeline contract that has none yet. */
export async function extractMissingContractTerms(
    userId: string,
    limit = 100,
): Promise<TermsSyncSummary> {
    const db = createServerSupabase();
    const summary: TermsSyncSummary = { extracted: 0, skipped: 0, errors: 0 };

    const { data: projects } = await db
        .from("projects")
        .select("id")
        .not("lane", "is", null)
        .limit(limit);
    const { data: existing } = await db.from("contract_terms").select("project_id");
    const done = new Set(((existing ?? []) as { project_id: string }[]).map((r) => r.project_id));

    for (const p of ((projects ?? []) as { id: string }[]).filter((p) => !done.has(p.id))) {
        try {
            const terms = await extractContractTerms(p.id, userId);
            if (terms) summary.extracted++;
            else summary.skipped++;
        } catch (e) {
            summary.errors++;
            console.warn(`[terms] ${p.id} failed: ${(e as Error).message}`);
        }
    }
    console.log(`[terms] sync: ${JSON.stringify(summary)}`);
    return summary;
}
