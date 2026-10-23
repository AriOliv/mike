// Does the report name something of the team's base? (doc 13 §5)
//
// The names stay in the cluster: the backend compares the already-redacted text
// with the org's contract and counterparty names and keeps only the verdict, a
// label on the issue. `names-clear` is the only way a report may reach the
// auto-fix; `sensitive` closes that door for good. When the check cannot run,
// the answer is `sensitive` (fail closed), never `names-clear`.

import type { Db } from "../../lib/supabase";

export type NamesVerdict = "names-clear" | "sensitive";

/** Words shorter than this are too common to mean a name. */
const MIN_WORD = 4;
/**
 * Words too common to identify anyone: the app's own vocabulary and the generic words of a
 * contract title. Without them a file called "Pedido de renovação" would make every report that
 * says "pedido" sensitive, and the check would flag everything. A name is what is left.
 */
const COMMON = new Set([
    // contract and document words
    "contrato", "contratos", "aditivo", "termo", "acordo", "minuta", "proposta", "anexo", "versao", "final", "assinado", "assinada",
    "prestacao", "servicos", "servico", "tratamento", "dados", "confidencialidade", "locacao", "compra", "venda", "parceria",
    "renovacao", "rescisao", "adesao", "licenca", "licenciamento", "fornecimento", "cessao", "distribuicao", "representacao",
    "documento", "documentos", "arquivo", "arquivos", "copia", "rascunho", "modelo", "padrao", "draft", "novo", "nova", "teste", "exemplo",
    "assinatura", "assinaturas", "clausula", "clausulas", "obrigacao", "obrigacoes", "prazo", "prazos", "vigencia", "valor", "valores",
    // company-form words
    "empresa", "empresas", "ltda", "eireli", "limitada", "sociedade", "comercial", "participacoes", "holding", "grupo", "brasil", "brasileira",
    // the app's own words (screens, actions, states)
    "pedido", "pedidos", "pagina", "tela", "botao", "salvar", "enviar", "abrir", "fechar", "lista", "filtro", "busca", "painel", "inicio",
    "ficha", "revisao", "revisoes", "analise", "controle", "radar", "esteira", "etapa", "etapas", "triagem", "entrega", "erro", "falha",
    "usuario", "usuarios", "pessoa", "pessoas", "equipe", "time", "legal", "juridico", "organizacao", "espaco", "conta", "perfil",
    "docx", "pdf",
]);

export const norm = (s: string) =>
    s
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase();

const words = (s: string) =>
    norm(s)
        .replace(/\.[a-z0-9]{2,5}$/, "")
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= MIN_WORD && !/^\d+$/.test(w) && !COMMON.has(w));

/** The words of every name worth watching, as a set. Pure; unit-tested without a database. */
export function nameWords(names: readonly (string | null | undefined)[]): Set<string> {
    const out = new Set<string>();
    for (const n of names) if (n) for (const w of words(n)) out.add(w);
    return out;
}

/** True when the text uses a word from the names, or a whole multi-word name, ignoring accents and case. */
export function mentionsAny(text: string, names: readonly (string | null | undefined)[]): boolean {
    const hay = ` ${norm(text).replace(/[^a-z0-9]+/g, " ").trim()} `;
    const hayWords = new Set(hay.split(" ").filter(Boolean));
    for (const w of nameWords(names)) if (hayWords.has(w)) return true;
    for (const n of names) {
        if (!n) continue;
        // A whole name counts only when it carries a word that identifies: "Termo de Adesão" is
        // made of common words, so it says nothing even when the report repeats it letter by letter.
        if (words(n).length === 0) continue;
        const phrase = ` ${norm(n).replace(/\.[a-z0-9]{2,5}$/, "").replace(/[^a-z0-9]+/g, " ").trim()} `;
        if (phrase.trim().split(" ").length >= 2 && hay.includes(phrase)) return true;
    }
    return false;
}

const PAGE = 1000;
const MAX_ROWS = 20_000;

/** Names of the org's contracts and counterparties, and of its documents' files. */
async function loadNames(db: Db, orgId: string | null, userId: string): Promise<string[]> {
    const names: string[] = [];
    // The org's space, or, in a personal space, what this person made: never another org's.
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
        const q = db.from("projects").select("name, counterparty");
        const { data, error } = await (orgId ? q.eq("org_id", orgId) : q.eq("user_id", userId).is("org_id", null)).range(from, from + PAGE - 1);
        if (error) throw error;
        for (const r of (data ?? []) as { name: string | null; counterparty: string | null }[]) names.push(r.name ?? "", r.counterparty ?? "");
        if ((data ?? []).length < PAGE) break;
    }
    // Files of those documents, through their versions.
    const docIds: string[] = [];
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
        const q = db.from("documents").select("id");
        const { data, error } = await (orgId ? q.eq("org_id", orgId) : q.eq("user_id", userId).is("org_id", null)).range(from, from + PAGE - 1);
        if (error) throw error;
        for (const r of (data ?? []) as { id: string }[]) docIds.push(r.id);
        if ((data ?? []).length < PAGE) break;
    }
    for (let i = 0; i < docIds.length; i += 200) {
        const { data, error } = await db.from("document_versions").select("filename").in("document_id", docIds.slice(i, i + 200));
        if (error) throw error;
        for (const r of (data ?? []) as { filename: string | null }[]) names.push(r.filename ?? "");
    }
    return names;
}

/**
 * The verdict for an already-redacted report. Any failure to read the base
 * is `sensitive`: the safe side, and the one that keeps the auto-fix away.
 */
export async function namesVerdict(db: Db, orgId: string | null, userId: string, texts: readonly string[]): Promise<NamesVerdict> {
    try {
        const names = await loadNames(db, orgId, userId);
        const joined = texts.join("\n");
        return mentionsAny(joined, names) ? "sensitive" : "names-clear";
    } catch {
        return "sensitive";
    }
}
