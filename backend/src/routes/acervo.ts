// Ask a question across the whole contract corpus.
//
// Answering from 50+ contracts at once would be slow and mostly wasted tokens,
// so this narrows first: contracts are ranked against the question using what
// is already indexed cheaply — name, counterparty and the AI analysis — and only
// the best few are read in full.
//
// The rule the answer must obey: every claim cites the clause it came from. An
// answer without a source is worse than no answer, because nobody can check it.
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { downloadFile } from "../lib/storage";
import { extractPdfText } from "../lib/chat/tools/documentOps";
import { completeText, resolveModel, DEFAULT_TABULAR_MODEL } from "../lib/llm";
import { getUserModelSettings } from "../lib/userSettings";

export const acervoRouter = Router();

const CONTRACTS_READ = 6; // how many contracts are read in full per question
// Head plus tail rather than a prefix: general clauses — governing law, venue,
// term, termination — sit at the END of a contract, so truncating from the
// start drops exactly what most questions ask about.
const HEAD_CHARS = 14000;
const TAIL_CHARS = 10000;

function excerpt(text: string): string {
    if (text.length <= HEAD_CHARS + TAIL_CHARS) return text;
    return (
        text.slice(0, HEAD_CHARS) +
        "\n\n[...trecho intermediário omitido...]\n\n" +
        text.slice(-TAIL_CHARS)
    );
}

const STOPWORDS = new Set([
    "a","o","as","os","de","da","do","das","dos","e","em","um","uma","que","qual","quais",
    "para","por","com","no","na","nos","nas","ao","aos","se","sobre","the","of","and","in",
    "to","for","is","are","what","which","contrato","contratos",
]);

function terms(text: string): string[] {
    return text
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
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

function score(question: string, candidate: Candidate): number {
    const wanted = new Set(terms(question));
    if (wanted.size === 0) return 0;
    const found = new Set(terms(candidate.haystack));
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

// POST /acervo  { question }
acervoRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (!question) return void res.status(400).json({ detail: "question is required" });

    const db = createServerSupabase();

    // ── narrow: rank contracts using what is already cheap to read ──────────
    const { data: projects, error } = await db
        .from("projects")
        .select("id, name, counterparty")
        .not("lane", "is", null);
    if (error) return void res.status(500).json({ detail: error.message });

    const rows = (projects ?? []) as { id: string; name: string; counterparty: string | null }[];
    if (rows.length === 0) {
        return void res.json({ answer: "", found: false, sources: [], searched: 0 });
    }

    const { data: dossiers } = await db.from("dossiers").select("project_id, payload");
    const summaryByProject = new Map<string, string>();
    for (const d of (dossiers ?? []) as { project_id: string; payload: unknown }[]) {
        summaryByProject.set(d.project_id, JSON.stringify(d.payload ?? {}).slice(0, 4000));
    }

    const ranked = rows
        .map((p) => ({
            project_id: p.id,
            name: p.name,
            counterparty: p.counterparty,
            haystack: `${p.name} ${p.counterparty ?? ""} ${summaryByProject.get(p.id) ?? ""}`,
        }))
        .map((c) => ({ candidate: c, s: score(question, c) }))
        .sort((a, b) => b.s - a.s);

    // A question that matches nothing by keyword is still worth answering, so
    // fall back to the most recently updated contracts rather than giving up.
    const chosen = (ranked.some((r) => r.s > 0) ? ranked.filter((r) => r.s > 0) : ranked)
        .slice(0, CONTRACTS_READ)
        .map((r) => r.candidate);

    // ── read the chosen contracts ───────────────────────────────────────────
    const ids = chosen.map((c) => c.project_id);
    const { data: docs } = await db.from("documents").select("id, project_id").in("project_id", ids);
    const docRows = (docs ?? []) as { id: string; project_id: string }[];
    const { data: versions } = await db
        .from("document_versions")
        .select("document_id, storage_path, pdf_storage_path, version_number, deleted_at")
        .in("document_id", docRows.map((d) => d.id));

    type V = {
        document_id: string;
        storage_path: string | null;
        pdf_storage_path: string | null;
        version_number: number | null;
        deleted_at: string | null;
    };
    const bestByDoc = new Map<string, V>();
    for (const v of (versions ?? []) as unknown as V[]) {
        if (v.deleted_at) continue;
        const current = bestByDoc.get(v.document_id);
        if (!current || (v.version_number ?? 0) > (current.version_number ?? 0)) {
            bestByDoc.set(v.document_id, v);
        }
    }

    const corpus: { id: string; label: string; text: string }[] = [];
    for (const candidate of chosen) {
        const doc = docRows.find((d) => d.project_id === candidate.project_id);
        const version = doc ? bestByDoc.get(doc.id) : undefined;
        const path = version?.pdf_storage_path ?? version?.storage_path;
        if (!path) continue;
        try {
            const bytes = await downloadFile(path);
            if (!bytes) continue;
            const text = excerpt(await extractPdfText(bytes));
            if (!text.trim()) continue;
            corpus.push({
                id: candidate.project_id,
                label: `${candidate.name}${candidate.counterparty ? ` — contraparte: ${candidate.counterparty}` : ""}`,
                text,
            });
        } catch (e) {
            console.warn(`[acervo] could not read ${candidate.project_id}: ${(e as Error).message}`);
        }
    }

    if (corpus.length === 0) {
        return void res.json({
            answer: "Não consegui ler o texto dos contratos para responder.",
            found: false,
            sources: [],
            searched: 0,
        });
    }

    // ── answer, with citations ──────────────────────────────────────────────
    try {
        const settings = await getUserModelSettings(userId, db);
        const model = resolveModel(settings.tabular_model, DEFAULT_TABULAR_MODEL);
        const raw = await completeText({
            model,
            systemPrompt: SYSTEM,
            user: buildPrompt(question, corpus),
            // Generous: a reasoning model spends part of this budget thinking,
            // and a JSON answer cut mid-object is unusable.
            maxTokens: 8000,
            apiKeys: settings.api_keys,
        });
        let parsed: Record<string, unknown>;
        try {
            parsed = parseJson(raw);
        } catch (e) {
            // Log what actually came back — "did not return JSON" alone is not
            // enough to tell a truncated answer from a chatty one.
            console.warn(`[acervo] unparseable answer (${raw.length} chars): ${raw.slice(0, 300)}`);
            throw e;
        }
        res.json({
            answer: typeof parsed.answer === "string" ? parsed.answer : "",
            found: parsed.found === true || parsed.found === "true",
            sources: Array.isArray(parsed.sources) ? parsed.sources : [],
            searched: corpus.length,
        });
    } catch (e) {
        console.warn(`[acervo] answer failed: ${(e as Error).message}`);
        res.status(502).json({ detail: "Could not get an answer from the model." });
    }
});
