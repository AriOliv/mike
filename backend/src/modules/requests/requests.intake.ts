// The intake checklist of a request: what the legal team needs to know
// before it analyses a contract. Each organization may keep its own list
// (legal_teams.intake_template); without one, the generic list below.
//
// Answers live on the request by key. One the agent read from the attached
// contract is "inferred" and stays unconfirmed until the requester confirms
// or corrects it; the checklist is complete when every required item has a
// confirmed answer. Only the open items are asked again.

import { cleanText } from "./requests.shared";

export const INTAKE_KINDS = ["text", "long_text", "yes_no", "date", "money"] as const;
export type IntakeKind = (typeof INTAKE_KINDS)[number];

export type IntakeItem = {
    key: string;
    label: string;
    kind: IntakeKind;
    required: boolean;
    /** One line under the question ("Se sim, quem compartilha?"). */
    hint?: string;
    /** For yes_no: the detail asked when the answer is "sim". */
    detail_label?: string;
};

export type IntakeAnswer = {
    value: string;
    /** For yes_no: "sim" | "nao". */
    choice?: "sim" | "nao";
    /** For yes_no with a detail_label. */
    detail?: string;
    source: "requester" | "inferred";
    confirmed: boolean;
    /** For an inferred answer: the contract's own words it was read from. */
    quote?: string;
    updated_at: string;
};

export type IntakeAnswers = Record<string, IntakeAnswer>;

/**
 * The generic checklist (any company): who approved it, the other party,
 * which company of the group signs, why and on what terms, whether the
 * requester agrees, start date, value and recurrence, confidential
 * information, personal data. An organization replaces it through the API.
 */
export const DEFAULT_INTAKE_TEMPLATE: readonly IntakeItem[] = [
    { key: "aprovacao", label: "Quem aprovou a contratação?", kind: "text", required: true, hint: "Nome e cargo, ou \"ainda sem aprovação\"." },
    { key: "contraparte", label: "Nome da contraparte", kind: "text", required: true },
    { key: "empresa_signataria", label: "Empresa do grupo que assina", kind: "text", required: true },
    {
        key: "motivo_condicoes",
        label: "Motivo da contratação e principais condições comerciais",
        kind: "long_text",
        required: true,
    },
    { key: "de_acordo", label: "Você está de acordo com a proposta?", kind: "yes_no", required: true },
    { key: "inicio", label: "Previsão de início", kind: "date", required: true },
    { key: "valor_recorrencia", label: "Valor e recorrência de pagamento", kind: "money", required: true },
    {
        key: "confidencial",
        label: "Há compartilhamento de informação confidencial?",
        kind: "yes_no",
        required: true,
        detail_label: "Quem compartilha?",
    },
    {
        key: "dados_pessoais",
        label: "Há tratamento de dados pessoais?",
        kind: "yes_no",
        required: true,
        detail_label: "Quem trata os dados, e cada parte decide sozinha como tratá-los?",
    },
];

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const MAX_INTAKE_ITEMS = 20;

/**
 * An organization's checklist as sent to the API, checked and cleaned:
 * unique snake_case keys, a label, a known kind. Null with the reason when
 * it is not one; an empty list means "use the generic one".
 */
export function parseIntakeTemplate(value: unknown): { ok: true; items: IntakeItem[] } | { ok: false; detail: string } {
    if (!Array.isArray(value)) return { ok: false, detail: "Envie o checklist como uma lista de perguntas." };
    if (value.length > MAX_INTAKE_ITEMS) {
        return { ok: false, detail: `O checklist aceita no máximo ${MAX_INTAKE_ITEMS} perguntas.` };
    }
    const items: IntakeItem[] = [];
    const seen = new Set<string>();
    for (const [i, raw] of value.entries()) {
        const n = i + 1;
        if (!raw || typeof raw !== "object") return { ok: false, detail: `A pergunta ${n} está vazia.` };
        const r = raw as Record<string, unknown>;
        const key = typeof r.key === "string" ? r.key.trim() : "";
        if (!KEY_RE.test(key)) {
            return { ok: false, detail: `A pergunta ${n} precisa de um identificador curto, em minúsculas e sem espaços.` };
        }
        if (seen.has(key)) return { ok: false, detail: `Há duas perguntas com o mesmo identificador (pergunta ${n}).` };
        seen.add(key);
        const label = cleanText(r.label, 200);
        if (!label) return { ok: false, detail: `Escreva o texto da pergunta ${n}.` };
        const kind = INTAKE_KINDS.includes(r.kind as IntakeKind) ? (r.kind as IntakeKind) : null;
        if (!kind) return { ok: false, detail: `Escolha o tipo de resposta da pergunta ${n}.` };
        const item: IntakeItem = { key, label, kind, required: r.required !== false };
        const hint = cleanText(r.hint, 200);
        if (hint) item.hint = hint;
        const detail = kind === "yes_no" ? cleanText(r.detail_label, 200) : null;
        if (detail) item.detail_label = detail;
        items.push(item);
    }
    return { ok: true, items };
}

/** The checklist that applies: the organization's, or the generic one. */
export function effectiveTemplate(stored: unknown): IntakeItem[] {
    const parsed = parseIntakeTemplate(stored);
    return parsed.ok && parsed.items.length ? parsed.items : [...DEFAULT_INTAKE_TEMPLATE];
}

/** Stored answers, read defensively (a template change can orphan keys). */
export function readAnswers(stored: unknown): IntakeAnswers {
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    const out: IntakeAnswers = {};
    for (const [key, raw] of Object.entries(stored as Record<string, unknown>)) {
        if (!raw || typeof raw !== "object") continue;
        const a = raw as Record<string, unknown>;
        if (typeof a.value !== "string" || !a.value.trim()) continue;
        out[key] = {
            value: a.value,
            ...(a.choice === "sim" || a.choice === "nao" ? { choice: a.choice } : {}),
            ...(typeof a.detail === "string" && a.detail ? { detail: a.detail } : {}),
            source: a.source === "inferred" ? "inferred" : "requester",
            confirmed: a.confirmed === true,
            ...(typeof a.quote === "string" && a.quote ? { quote: a.quote } : {}),
            updated_at: typeof a.updated_at === "string" ? a.updated_at : "",
        };
    }
    return out;
}

const YES = /^(s|sim|yes|y|true|1)$/i;
const NO = /^(n|n[aã]o|no|false|0)$/i;

/**
 * One answer the person gave, normalized to the item's kind. A yes/no takes
 * "sim"/"não" (or true/false) plus an optional detail. Null with the reason
 * when it does not fit.
 */
export function normalizeAnswer(
    item: IntakeItem,
    raw: unknown,
    detailRaw?: unknown,
): { ok: true; answer: Pick<IntakeAnswer, "value" | "choice" | "detail"> } | { ok: false; detail: string } {
    if (item.kind === "yes_no") {
        const text = typeof raw === "boolean" ? (raw ? "sim" : "nao") : typeof raw === "string" ? raw.trim() : "";
        const choice = YES.test(text) ? "sim" : NO.test(text) ? "nao" : null;
        if (!choice) return { ok: false, detail: `Responda sim ou não em “${item.label}”.` };
        const detail = cleanText(detailRaw, 500);
        return {
            ok: true,
            answer: {
                choice,
                value: (choice === "sim" ? "Sim" : "Não") + (detail ? `. ${detail}` : ""),
                ...(detail ? { detail } : {}),
            },
        };
    }
    const max = item.kind === "long_text" ? 2000 : 300;
    const value = cleanText(raw, max);
    if (!value) return { ok: false, detail: `Responda “${item.label}”.` };
    if (item.kind === "date" && !/\d/.test(value) && !/imediat|assinatura|já/i.test(value)) {
        return { ok: false, detail: `Informe uma data ou um prazo em “${item.label}”.` };
    }
    return { ok: true, answer: { value } };
}

export type IntakeStatus = {
    items: (IntakeItem & { answer: IntakeAnswer | null; state: "confirmado" | "inferido" | "pendente" })[];
    /** Required items without a confirmed answer, in checklist order. */
    pending: string[];
    /** Inferred answers waiting for the requester's confirmation. */
    to_confirm: string[];
    complete: boolean;
    answered: number;
    total: number;
};

/** Where the checklist stands: what is confirmed, inferred, or still open. */
export function intakeStatus(template: IntakeItem[], answers: IntakeAnswers): IntakeStatus {
    const items = template.map((item) => {
        const answer = answers[item.key] ?? null;
        const state: "confirmado" | "inferido" | "pendente" = !answer
            ? "pendente"
            : answer.confirmed
              ? "confirmado"
              : "inferido";
        return { ...item, answer, state };
    });
    const pending = items.filter((i) => i.required && i.state !== "confirmado").map((i) => i.key);
    return {
        items,
        pending,
        to_confirm: items.filter((i) => i.state === "inferido").map((i) => i.key),
        complete: pending.length === 0,
        answered: items.filter((i) => i.state === "confirmado").length,
        total: items.length,
    };
}

/**
 * The person's answers merged over what is stored. Each one is theirs, so
 * it is confirmed; `confirm` (a list of keys) confirms inferred answers as
 * they stand. Unknown keys are refused, not dropped silently.
 */
export function applyAnswers(
    template: IntakeItem[],
    stored: IntakeAnswers,
    input: { answers?: unknown; confirm?: unknown },
    now: string,
): { ok: true; answers: IntakeAnswers; changed: string[] } | { ok: false; detail: string } {
    const byKey = new Map(template.map((i) => [i.key, i]));
    const next: IntakeAnswers = { ...stored };
    const changed: string[] = [];
    const given = input.answers && typeof input.answers === "object" && !Array.isArray(input.answers)
        ? (input.answers as Record<string, unknown>)
        : {};
    for (const [key, raw] of Object.entries(given)) {
        const item = byKey.get(key);
        if (!item) return { ok: false, detail: "Uma das respostas não corresponde a nenhuma pergunta do checklist." };
        const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : { value: raw };
        const normalized = normalizeAnswer(item, value.value, value.detail);
        if (!normalized.ok) return normalized;
        next[key] = { ...normalized.answer, source: "requester", confirmed: true, updated_at: now };
        changed.push(key);
    }
    const confirm = Array.isArray(input.confirm) ? input.confirm.filter((k): k is string => typeof k === "string") : [];
    for (const key of confirm) {
        const current = next[key];
        if (!byKey.has(key)) return { ok: false, detail: "Uma das confirmações não corresponde a nenhuma pergunta do checklist." };
        if (!current) return { ok: false, detail: `Ainda não há resposta para “${byKey.get(key)!.label}” para confirmar.` };
        if (current.confirmed) continue;
        next[key] = { ...current, confirmed: true, updated_at: now };
        changed.push(key);
    }
    return { ok: true, answers: next, changed };
}

/**
 * What the agent read from the contract, kept only where nobody answered yet:
 * a person's answer, confirmed or not, is never overwritten by an inference.
 */
export function mergeInferred(
    template: IntakeItem[],
    stored: IntakeAnswers,
    inferred: Record<string, { value: string; quote?: string | null; choice?: "sim" | "nao" | null }>,
    now: string,
): { answers: IntakeAnswers; filled: string[] } {
    const next: IntakeAnswers = { ...stored };
    const filled: string[] = [];
    for (const item of template) {
        if (next[item.key]) continue;
        const got = inferred[item.key];
        const value = cleanText(got?.value, item.kind === "long_text" ? 2000 : 300);
        if (!got || !value) continue;
        next[item.key] = {
            value,
            ...(item.kind === "yes_no" && (got.choice === "sim" || got.choice === "nao") ? { choice: got.choice } : {}),
            source: "inferred",
            confirmed: false,
            ...(got.quote ? { quote: cleanText(got.quote, 400) ?? undefined } : {}),
            updated_at: now,
        };
        filled.push(item.key);
    }
    return { answers: next, filled };
}

/**
 * The checklist flattened for the contract analysis (contract-review's
 * startAnalystAnalysis): label and value, readable, without the keys' meaning.
 */
export function intakeForAnalysis(
    template: IntakeItem[],
    answers: IntakeAnswers,
): { key: string; label: string; value: string; source: "requester" | "inferred" }[] {
    return template
        .filter((i) => answers[i.key])
        .map((i) => ({ key: i.key, label: i.label, value: answers[i.key].value, source: answers[i.key].source }));
}
