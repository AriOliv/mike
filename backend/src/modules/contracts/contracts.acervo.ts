// Ask a question across the whole contract corpus ("acervo").
//
// Answering from 50+ contracts at once would be slow and mostly wasted tokens,
// so this narrows first: contracts are ranked against the question using what
// is already indexed cheaply — name, counterparty and the AI analysis — and only
// the best few are read in full.
//
// The rule the answer must obey: every claim cites the clause it came from. An
// answer without a source is worse than no answer, because nobody can check it.

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
    latestContractFiles,
    parseModelJson,
    type Caller,
} from "./contracts.shared";

const CONTRACTS_READ = 6; // how many contracts are read in full per question
const HEAD_CHARS = 14000;
const TAIL_CHARS = 10000;

const STOPWORDS = new Set([
    "a","o","as","os","de","da","do","das","dos","e","em","um","uma","que","qual","quais",
    "para","por","com","no","na","nos","nas","ao","aos","se","sobre","the","of","and","in",
    "to","for","is","are","what","which","contrato","contratos",
]);

function terms(text: string): string[] {
    return text
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

type Candidate = {
    project_id: string;
    name: string;
    counterparty: string | null;
    haystack: string;
};

export function scoreCandidate(question: string, haystack: string): number {
    const wanted = new Set(terms(question));
    if (wanted.size === 0) return 0;
    const found = new Set(terms(haystack));
    let hits = 0;
    for (const w of wanted) if (found.has(w)) hits++;
    return hits / wanted.size;
}

const SYSTEM = `Você é um analista jurídico respondendo perguntas sobre o acervo de
contratos da empresa.

Regras invioláveis:
- Responda SOMENTE com base nos contratos fornecidos. Nunca invente cláusula, número ou dado.
- Toda afirmação precisa citar a cláusula-fonte: um trecho VERBATIM e de qual contrato veio.
- Se a resposta não estiver nos contratos, diga que não encontrou (found=false).
- Português do Brasil, objetivo, sem floreio.
- Responda apenas com JSON válido, sem cercas de código.`;

function buildPrompt(question: string, corpus: { id: string; label: string; text: string }[]) {
    const blocks = corpus
        .map((c) => `[contrato id=${c.id}] ${c.label}\n${c.text}`)
        .join("\n\n---\n\n");
    const schema = {
        answer: "resposta objetiva (1-4 frases)",
        found: "true se respondida a partir dos contratos; false se não achou",
        sources: [
            {
                project_id: "id do contrato citado (exatamente o id= do cabeçalho)",
                contract: "nome ou contraparte do contrato",
                ref: "cláusula/anexo, se identificável (ex.: 'cl. 11.1')",
                quote: "trecho VERBATIM da cláusula-fonte",
            },
        ],
    };
    return `Pergunta sobre o acervo:
"${question}"

Cite só os contratos realmente relevantes — não todos.

Schema de saída (JSON):
${JSON.stringify(schema, null, 2)}

CONTRATOS:
${blocks}`;
}

export type AcervoAnswer = {
    answer: string;
    found: boolean;
    sources: unknown[];
    searched: number;
};

export async function askAcervo(
    db: Db,
    caller: Caller,
    body: Record<string, unknown>,
): Promise<ServiceResult<AcervoAnswer>> {
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) return failure("validation", "question is required");

    // ── narrow: rank the contracts the caller can see ───────────────────────
    let ids: string[];
    try {
        ids = await listAccessibleProjectIds(caller.userId, caller.userEmail, db);
    } catch (error) {
        return internalFailure(error);
    }
    const rows: { id: string; name: string; counterparty: string | null }[] = [];
    for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await db
            .from("projects")
            .select("id, name, counterparty")
            .in("id", ids.slice(i, i + 200))
            .not("lane", "is", null)
            .is("archived_at", null);
        if (error) return internalFailure(error);
        rows.push(...((data ?? []) as typeof rows));
    }
    if (rows.length === 0) return ok({ answer: "", found: false, sources: [], searched: 0 });

    const { data: dossiers, error: dossiersError } = await db
        .from("dossiers")
        .select("project_id, payload")
        .in("project_id", rows.map((r) => r.id));
    if (dossiersError) return internalFailure(dossiersError);
    const summaryByProject = new Map<string, string>();
    for (const d of (dossiers ?? []) as { project_id: string; payload: unknown }[]) {
        summaryByProject.set(d.project_id, JSON.stringify(d.payload ?? {}).slice(0, 4000));
    }

    const ranked = rows
        .map(
            (p): Candidate => ({
                project_id: p.id,
                name: p.name,
                counterparty: p.counterparty,
                haystack: `${p.name} ${p.counterparty ?? ""} ${summaryByProject.get(p.id) ?? ""}`,
            }),
        )
        .map((c) => ({ candidate: c, s: scoreCandidate(question, c.haystack) }))
        .sort((a, b) => b.s - a.s);

    // A question that matches nothing by keyword is still worth answering, so
    // fall back to the first contracts rather than giving up.
    const chosen = (ranked.some((r) => r.s > 0) ? ranked.filter((r) => r.s > 0) : ranked)
        .slice(0, CONTRACTS_READ)
        .map((r) => r.candidate);

    const selected = await analysisModel(db, caller.userId);
    if (!selected.ok) return selected;

    // ── read the chosen contracts ───────────────────────────────────────────
    let files;
    try {
        files = await latestContractFiles(db, chosen.map((c) => c.project_id));
    } catch (error) {
        return internalFailure(error);
    }
    const corpus: { id: string; label: string; text: string }[] = [];
    for (const candidate of chosen) {
        const file = files.get(candidate.project_id);
        if (!file) continue;
        try {
            const text = await contractFileText(file);
            if (!text) continue;
            corpus.push({
                id: candidate.project_id,
                label: `${candidate.name}${candidate.counterparty ? ` — contraparte: ${candidate.counterparty}` : ""}`,
                text: excerpt(text, HEAD_CHARS, TAIL_CHARS),
            });
        } catch (e) {
            console.warn(`[acervo] could not read ${candidate.project_id}: ${(e as Error).message}`);
        }
    }

    if (corpus.length === 0) {
        return ok({
            answer: "Não consegui ler o texto dos contratos para responder.",
            found: false,
            sources: [],
            searched: 0,
        });
    }

    // ── answer, with citations ──────────────────────────────────────────────
    try {
        const raw = await completeText({
            model: selected.model,
            systemPrompt: SYSTEM,
            user: buildPrompt(question, corpus),
            // Generous: a reasoning model spends part of this budget thinking,
            // and a JSON answer cut mid-object is unusable.
            maxTokens: 8000,
            apiKeys: selected.settings.api_keys,
        });
        let parsed: Record<string, unknown>;
        try {
            parsed = parseModelJson(raw);
        } catch (e) {
            // Log the size only: the answer quotes contract text.
            console.warn(`[acervo] unparseable answer (${raw.length} chars)`);
            throw e;
        }
        return ok({
            answer: typeof parsed.answer === "string" ? parsed.answer : "",
            found: parsed.found === true || parsed.found === "true",
            sources: Array.isArray(parsed.sources) ? parsed.sources : [],
            searched: corpus.length,
        });
    } catch (error) {
        return internalFailure(error);
    }
}
