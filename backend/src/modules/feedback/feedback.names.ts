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

/**
 * Corporate forms and small words that are written in capitals in a company name but mean nothing alone:
 * "ME" (microempresa) is also the pronoun "me", so a counterparty "Padaria do Zé ME" would turn every
 * report that says "não me deixa salvar" sensitive. Found by running real-looking names through
 * shortNames, not by guessing.
 */
const NOT_A_NAME = new Set(["me", "epp", "eireli", "mei", "sa", "ss", "cia", "ltd", "inc", "llc", "gmbh", "bv", "nv", "ag", "co", "de", "da", "do", "das", "dos", "em", "na", "no", "um", "uma", "por", "com", "sem", "ao", "as", "os", "ou", "eu", "se", "te", "ele", "ela", "nos", "vos", "seu", "sua", "que"]);

/**
 * Short counterparty names ("XP", "BTG", "B3", "3M"): two or three letters, in capitals or with a digit.
 * Only from counterparties, which are company names; a file title or a contract name is not read this way
 * (it would make "de" or "em" a name). Lower-case small words ("de", "do", "e") never count.
 */
export function shortNames(counterparties: readonly (string | null | undefined)[]): Set<string> {
    const out = new Set<string>();
    for (const c of counterparties) {
        if (!c) continue;
        for (const raw of c.replace(/\.[a-z0-9]{2,5}$/i, "").split(/[^A-Za-z0-9]+/)) {
            if (raw.length < 2 || raw.length > 3) continue;
            if (/^\d+$/.test(raw)) continue;
            const w = norm(raw);
            if (NOT_A_NAME.has(w)) continue;
            if (/[0-9]/.test(raw) || raw === raw.toUpperCase()) out.add(w);
        }
    }
    return out;
}

/**
 * True when the text uses a word from the names, a short counterparty name, or a whole multi-word name,
 * ignoring accents and case. `counterparties` is the subset of `names` that are company names.
 */
export function mentionsAny(text: string, names: readonly (string | null | undefined)[], counterparties: readonly (string | null | undefined)[] = []): boolean {
    const hay = ` ${norm(text).replace(/[^a-z0-9]+/g, " ").trim()} `;
    const hayWords = new Set(hay.split(" ").filter(Boolean));
    for (const w of nameWords([...names, ...counterparties])) if (hayWords.has(w)) return true;
    for (const w of shortNames(counterparties)) if (hayWords.has(w)) return true;
    for (const n of [...names, ...counterparties]) {
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

/** The base is larger than the check can read: a partial list must never answer "names-clear". */
export class NamesCeilingError extends Error {
    constructor() {
        super("names ceiling reached");
        this.name = "NamesCeilingError";
    }
}

type Scope = { orgId: string | null; userId: string };
export type LoadedNames = { names: string[]; counterparties: string[] };

/** Every page of a query, up to the ceiling; reaching it with the last page still full is an error, not a result. */
async function paged<T>(page: (from: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
    const rows: T[] = [];
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
        const { data, error } = await page(from);
        if (error) throw error;
        const got = (data ?? []) as T[];
        rows.push(...got);
        if (got.length < PAGE) return rows;
    }
    throw new NamesCeilingError();
}

/** Names of one space's contracts and counterparties, and of its documents' files. */
async function loadSpace(db: Db, { orgId, userId }: Scope): Promise<LoadedNames> {
    const names: string[] = [];
    const counterparties: string[] = [];
    // The org's space, or, in a personal space, what this person made: never another org's.
    const projects = await paged<{ name: string | null; counterparty: string | null }>((from) => {
        const q = db.from("projects").select("name, counterparty");
        return (orgId ? q.eq("org_id", orgId) : q.eq("user_id", userId).is("org_id", null)).range(from, from + PAGE - 1);
    });
    for (const r of projects) {
        names.push(r.name ?? "");
        counterparties.push(r.counterparty ?? "");
    }
    const documents = await paged<{ id: string }>((from) => {
        const q = db.from("documents").select("id");
        return (orgId ? q.eq("org_id", orgId) : q.eq("user_id", userId).is("org_id", null)).range(from, from + PAGE - 1);
    });
    for (let i = 0; i < documents.length; i += 200) {
        const { data, error } = await db.from("document_versions").select("filename").in("document_id", documents.slice(i, i + 200).map((d) => d.id));
        if (error) throw error;
        for (const r of (data ?? []) as { filename: string | null }[]) names.push(r.filename ?? "");
    }
    return { names, counterparties };
}

/** Every organization the person belongs to (not deleted), then their personal space. */
async function authorSpaces(db: Db, userId: string): Promise<Scope[]> {
    const { data, error } = await db
        .from("org_members")
        .select("org_id, organizations!inner(id)")
        .is("organizations.deleted_at", null)
        .eq("user_id", userId);
    if (error) throw error;
    const orgs = [...new Set(((data ?? []) as { org_id: string }[]).map((r) => r.org_id))];
    return [...orgs.map((orgId) => ({ orgId, userId })), { orgId: null, userId }];
}

/**
 * The verdict for an already-redacted report. It compares with the names of EVERY space the author can
 * report from (all their organizations and their personal space), not only the one the report names:
 * a person in several organizations may report from any of them. Any failure to read the base, and a base
 * too large to read whole, is `sensitive`: the safe side, and the one that keeps the auto-fix away.
 */
export async function namesVerdict(db: Db, userId: string, texts: readonly string[]): Promise<NamesVerdict> {
    try {
        const all: LoadedNames = { names: [], counterparties: [] };
        for (const scope of await authorSpaces(db, userId)) {
            const one = await loadSpace(db, scope);
            all.names.push(...one.names);
            all.counterparties.push(...one.counterparties);
        }
        return mentionsAny(texts.join("\n"), all.names, all.counterparties) ? "sensitive" : "names-clear";
    } catch {
        return "sensitive";
    }
}
