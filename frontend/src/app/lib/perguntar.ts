// Display rules for "Perguntar" (the corpus Q&A page at /acervo): turning the
// answer's inline markers into citation pills, the link that opens a quote in
// the contract, how a contract's row reads, and failure copy in Portuguese.

import type { AcervoAnswer, AcervoMatch } from "@/app/lib/mikeApi";
import type { UserFacingError } from "@/shared/lib/userError";

export type AnswerSegment =
    | { kind: "text"; text: string }
    | { kind: "cite"; n: number };

/**
 * Splits "A [1] e B [2, 3]." into text and citation segments. Only numbers
 * that some source carries become pills; anything else stays text, so a
 * stray "[4]" never becomes a link to nothing.
 */
export function splitCitations(answer: string, known: ReadonlySet<number>): AnswerSegment[] {
    const out: AnswerSegment[] = [];
    // Skipped markers stay inside the slice, so text and citations alternate.
    const pushText = (text: string) => {
        if (text) out.push({ kind: "text", text });
    };
    const marker = /\[(\d+(?:\s*[,;]\s*\d+)*)\]/g;
    let cursor = 0;
    for (const match of answer.matchAll(marker)) {
        const numbers = match[1].split(/[,;]/).map((n) => Number(n.trim()));
        if (!numbers.every((n) => known.has(n))) continue;
        pushText(answer.slice(cursor, match.index));
        for (const n of numbers) out.push({ kind: "cite", n });
        cursor = match.index + match[0].length;
    }
    pushText(answer.slice(cursor));
    return out;
}

/** The contract's review page, asked to highlight the quote. */
export function reviewHref(projectId: string, quote?: string | null): string {
    const base = `/projects/${encodeURIComponent(projectId)}/review`;
    return quote ? `${base}?quote=${encodeURIComponent(quote)}` : base;
}

export type MatchStatus = "tem" | "nao_tem" | "indexando" | "nao_buscado";

export function matchStatus(match: AcervoMatch): MatchStatus {
    if (match.hit) return "tem";
    if (match.basis === "pendente") return "indexando";
    if (match.basis === "nao_buscado") return "nao_buscado";
    return "nao_tem";
}

export const MATCH_STATUS_LABEL: Record<MatchStatus, string> = {
    tem: "Encontrado",
    nao_tem: "Não encontrado",
    indexando: "Ainda indexando",
    nao_buscado: "Não buscado",
};

/** A count as Portuguese reads it: "1.234". */
export const count = (n: number) => n.toLocaleString("pt-BR");

/** "1 contrato", "2 contratos", "1.234 contratos". */
export const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;

/** "7 de 52 contratos". */
export function hitSummary(answer: Pick<AcervoAnswer, "matches" | "total">): string {
    const hits = answer.matches.filter((m) => m.hit).length;
    return `${count(hits)} de ${plural(answer.total, "contrato", "contratos")}`;
}

/**
 * What the answer could not see. Zero matches in a contract that is not
 * indexed yet proves nothing, so the screen says so.
 */
export function coverageNotes(answer: Pick<AcervoAnswer, "coverage">): string[] {
    const notes: string[] = [];
    const { contracts_pending: pending, contracts_not_searched: skipped } = answer.coverage;
    if (pending > 0) {
        notes.push(
            `${plural(pending, "contrato ainda está", "contratos ainda estão")} sendo indexado${pending === 1 ? "" : "s"}; a busca pode não ter visto tudo.`,
        );
    }
    if (skipped > 0) {
        notes.push(
            `${plural(skipped, "contrato não foi buscado", "contratos não foram buscados")} pelo limite por pergunta. Restrinja o escopo para cobrir todos.`,
        );
    }
    return notes;
}

/** "Respondido a partir de 3 contratos lidos." */
export function readSummary(searched: number): string {
    return `Respondido a partir de ${plural(searched, "contrato lido", "contratos lidos")}.`;
}

export const MODEL_REQUIRED_COPY =
    "Escolha um modelo de revisão tabular em Configurações para usar o Perguntar.";

/**
 * The one way forward a failed question offers. Retrying is only honest when
 * the same question could succeed: an expired session needs a sign-in, a
 * missing model needs Configurações, and a rejected question needs rewriting.
 */
export type FailureAction = "retry" | "sign_in" | "settings" | "rewrite";

export function failureAction(error: UserFacingError): FailureAction {
    if (error.code === "model_required") return "settings";
    if (error.kind === "unauthenticated") return "sign_in";
    if (error.kind === "validation") return "rewrite";
    return "retry";
}

export const FAILURE_ACTION_LABEL: Record<FailureAction, string> = {
    retry: "Tentar de novo",
    sign_in: "Entrar de novo",
    settings: "Abrir Configurações",
    rewrite: "Reescrever a pergunta",
};

/** The failure, in Portuguese, from its classification — never the raw message. */
export function failureCopy(error: UserFacingError): string {
    if (error.code === "model_required") return MODEL_REQUIRED_COPY;
    switch (error.kind) {
        case "unauthenticated":
            return "Sua sessão expirou. Entre de novo para perguntar.";
        case "forbidden":
            return "Você não tem acesso a esses contratos.";
        case "validation":
            return "Não entendi a pergunta. Reescreva e tente de novo.";
        case "rate_limited":
            return "Muitas perguntas seguidas. Aguarde um instante e tente de novo.";
        case "offline":
        case "network":
            return "Sem conexão com o servidor. Verifique a internet e tente de novo.";
        case "timeout":
            return "A resposta demorou demais. Tente de novo ou restrinja o escopo.";
        default:
            return "Não consegui responder agora. Tente de novo em instantes.";
    }
}
