// The contract's terms asked on the form (U-05 part 2, U-07, U-08): the other
// party's e-mail, the start date and the term in months. The end is computed
// (start + months − 1 day), never stored. Pure functions; messages are for the
// requester, in Portuguese, and name the field so the form can paint it.

import { isEmail } from "./requests.shared";

export const MIN_TERM_MONTHS = 1;
export const MAX_TERM_MONTHS = 600;

export type TermsInput = {
    counterparty_email?: unknown;
    term_start?: unknown;
    term_months?: unknown;
};

export type Terms = {
    counterpartyEmail: string | null;
    termStart: string | null;
    termMonths: number | null;
};

export type TermsFailure = { ok: false; field: "counterparty_email" | "term_start" | "term_months"; detail: string };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(value: string): { y: number; m: number; d: number } | null {
    const match = ISO_DATE.exec(value);
    if (!match) return null;
    const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
    return { y, m, d };
}

const blank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** Check what the form sent. Everything is optional; an empty field never errors. */
export function parseTerms(input: TermsInput): ({ ok: true } & Terms) | TermsFailure {
    let counterpartyEmail: string | null = null;
    if (!blank(input.counterparty_email)) {
        const email = typeof input.counterparty_email === "string" ? input.counterparty_email.trim().toLowerCase() : "";
        if (!isEmail(email) || email.length > 254) {
            return { ok: false, field: "counterparty_email", detail: "Esse e-mail não parece certo. Confira e tente de novo." };
        }
        counterpartyEmail = email;
    }

    let termStart: string | null = null;
    if (!blank(input.term_start)) {
        if (typeof input.term_start !== "string" || !validDate(input.term_start.trim())) {
            return { ok: false, field: "term_start", detail: "Escolha uma data de início válida." };
        }
        termStart = input.term_start.trim();
    }

    let termMonths: number | null = null;
    if (!blank(input.term_months)) {
        const raw = typeof input.term_months === "string" ? Number(input.term_months.trim()) : input.term_months;
        if (typeof raw !== "number" || !Number.isInteger(raw)) {
            return { ok: false, field: "term_months", detail: "Use um prazo em meses, com número inteiro." };
        }
        if (raw < MIN_TERM_MONTHS) return { ok: false, field: "term_months", detail: "Use um prazo de 1 mês ou mais." };
        if (raw > MAX_TERM_MONTHS) {
            return { ok: false, field: "term_months", detail: "Confira o prazo: isso passa de 50 anos." };
        }
        termMonths = raw;
    }
    return { ok: true, counterpartyEmail, termStart, termMonths };
}

/**
 * The day the term ends: start + N months, minus one day. A term that starts
 * on 12/11/2026 and lasts 12 months ends on 11/11/2027; one that starts on
 * 01/01 and lasts a year ends on 31/12.
 *
 * The day is taken one before the start's day, in the month the term lands
 * on. When that day does not exist there, the term ends on the month's last
 * day and never spills into the next: 31/01 + 1 month ends on 28/02 (29/02 in
 * a leap year). A start on the 1st ends on the last day of the month before.
 * Null until both values are known.
 *
 * Código Civil, art. 132, §3º: prazos de meses e anos expiram no dia de igual
 * número ao do início, ou no imediato se faltar correspondência exata. A
 * vigência termina na véspera, daí o "- 1 dia" (decisão do Legal, 22/10).
 */
export function termEnd(termStart: string | null, termMonths: number | null): string | null {
    if (!termStart || termMonths === null) return null;
    const parts = validDate(termStart);
    if (!parts) return null;
    const index = parts.y * 12 + (parts.m - 1) + termMonths;
    const year = Math.floor(index / 12);
    const month = index % 12;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const day = parts.d - 1;
    const end = day < 1 ? new Date(Date.UTC(year, month, 0)) : new Date(Date.UTC(year, month, Math.min(day, lastDay)));
    return end.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// What the intake agent reads from the contract.
// ---------------------------------------------------------------------------

export type InferredTerm = { value: string; quote: string };
export type InferredTerms = Partial<Record<"counterparty" | "term_start" | "term_months", InferredTerm>>;

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/** A date the model wrote ("2026-11-12", "12/11/2026", "12 de novembro de 2026", "1º de novembro de 2026") as AAAA-MM-DD, or null. */
export function readDate(text: string): string | null {
    const value = text.trim().toLowerCase();
    let y: number, m: number, d: number;
    let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value))) [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
    else if ((match = /^(\d{1,2})\s*[º°o]?\s+de\s+([a-zç]+)\s+de\s+(\d{4})$/.exec(value))) {
        const index = MONTHS.indexOf(match[2]);
        if (index === -1) return null;
        [d, m, y] = [Number(match[1]), index + 1, Number(match[3])];
    } else return null;
    const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return validDate(iso) ? iso : null;
}

/** A term the model wrote ("12 meses", "2 anos", "24") as whole months in range, or null. */
export function readMonths(text: string): number | null {
    const match = /^(\d{1,3})\s*(meses|mês|mes|m|anos?|a)?$/.exec(text.trim().toLowerCase());
    if (!match) return null;
    const n = Number(match[1]) * (match[2] && /^a/.test(match[2]) ? 12 : 1);
    return n >= MIN_TERM_MONTHS && n <= MAX_TERM_MONTHS ? n : null;
}

// ---------------------------------------------------------------------------
// Reading and answering the terms of a request.
// ---------------------------------------------------------------------------

import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { isTeam, loadRequestFor, type Caller, type RequestRow } from "./requests.access";

export type TermKey = "counterparty" | "term_start" | "term_months";

export type RequestTerms = {
    counterparty: string | null;
    /** Only the team gets the other party's e-mail: it is kept for later, never mailed. */
    counterparty_email: string | null;
    term_start: string | null;
    term_months: number | null;
    /** start + months, on the same day or the last day of a shorter month. Null until both are known. */
    term_end: string | null;
    /** What the agent read from the contract and waits for a person to confirm, each with its own words. */
    inferred: InferredTerms;
    can_answer: boolean;
};

function termsView(row: RequestRow, team: boolean, canAnswer: boolean): RequestTerms {
    return {
        counterparty: row.counterparty,
        counterparty_email: team ? row.counterparty_email : null,
        term_start: row.term_start,
        term_months: row.term_months,
        term_end: termEnd(row.term_start, row.term_months),
        inferred: (row.terms_inferred ?? {}) as InferredTerms,
        can_answer: canAnswer,
    };
}

const mayAnswerTerms = (row: RequestRow, kind: string, team: boolean) =>
    row.status !== "entregue" && row.status !== "cancelado" && (kind === "requester" || team);

export async function getTerms(db: Db, caller: Caller, requestId: string): Promise<ServiceResult<RequestTerms>> {
    const loaded = await loadRequestFor(db, caller, requestId);
    if (!loaded.ok) return loaded;
    const team = isTeam(loaded.audience);
    return ok(termsView(loaded.row, team, mayAnswerTerms(loaded.row, loaded.audience.kind, team)));
}

/**
 * Save the terms. Each field comes as the person's own value or, for what the
 * agent read, as `confirm`: the suggestion becomes the real value. A value the
 * person typed always wins, and any field answered one way or the other stops
 * being a suggestion. An empty value clears the field.
 */
export async function setTerms(
    db: Db,
    caller: Caller,
    requestId: string,
    body: TermsInput & { counterparty?: unknown; confirm?: unknown },
): Promise<ServiceResult<RequestTerms>> {
    const loaded = await loadRequestFor(db, caller, requestId);
    if (!loaded.ok) return loaded;
    const row = loaded.row;
    const team = isTeam(loaded.audience);
    if (!mayAnswerTerms(row, loaded.audience.kind, team)) {
        if (row.status === "entregue" || row.status === "cancelado") return failure("conflict", "Este pedido já foi encerrado.");
        return failure("forbidden", "Os dados do contrato são de quem pediu e do time do Legal.");
    }

    const inferred = { ...((row.terms_inferred ?? {}) as InferredTerms) };
    const patch: Record<string, unknown> = {};

    const confirm = Array.isArray(body.confirm) ? body.confirm.filter((k): k is TermKey => k === "counterparty" || k === "term_start" || k === "term_months") : [];
    for (const key of confirm) {
        const suggestion = inferred[key];
        if (!suggestion) continue;
        if (key === "counterparty") patch.counterparty = suggestion.value.slice(0, 200);
        if (key === "term_start") patch.term_start = suggestion.value;
        if (key === "term_months") patch.term_months = Number(suggestion.value);
        delete inferred[key];
    }

    // What the person typed overrides a confirmation of the same field.
    if ("counterparty" in body) {
        const value = typeof body.counterparty === "string" ? body.counterparty.trim().slice(0, 200) : "";
        patch.counterparty = value || null;
        delete inferred.counterparty;
    }
    const typed = parseTerms({
        counterparty_email: "counterparty_email" in body ? body.counterparty_email : undefined,
        term_start: "term_start" in body ? body.term_start : undefined,
        term_months: "term_months" in body ? body.term_months : undefined,
    });
    if (!typed.ok) return failure("validation", typed.detail, `field:${typed.field}`);
    // The requester may write the other party's e-mail (the form asks for it) but is never
    // handed it back: it is kept for the validation by link, not for display to them.
    if ("counterparty_email" in body) patch.counterparty_email = typed.counterpartyEmail;
    if ("term_start" in body) {
        patch.term_start = typed.termStart;
        delete inferred.term_start;
    }
    if ("term_months" in body) {
        patch.term_months = typed.termMonths;
        delete inferred.term_months;
    }

    if (Object.keys(patch).length === 0 && confirm.length === 0) return ok(termsView(row, team, true));
    const { data, error } = await db
        .from("legal_requests")
        .update({ ...patch, terms_inferred: inferred, updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .select("id")
        .single();
    if (error || !data) return internalFailure(error);
    return ok(termsView({ ...row, ...(patch as Partial<RequestRow>), terms_inferred: inferred }, team, true));
}
