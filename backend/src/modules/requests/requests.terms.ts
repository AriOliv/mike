// The contract's terms asked on the form (U-05 part 2, U-07, U-08): the other
// party's e-mail, the start date and the term in months. The end is computed
// (start + months), never stored. Pure functions; messages are for the
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
 * The day the term ends: the start plus the months, on the same day of the
 * month, or the last day of a shorter month ("31/01 + 1 mês = 28/02"). Null
 * until both values are known.
 */
export function termEnd(termStart: string | null, termMonths: number | null): string | null {
    if (!termStart || termMonths === null) return null;
    const parts = validDate(termStart);
    if (!parts) return null;
    const index = parts.y * 12 + (parts.m - 1) + termMonths;
    const year = Math.floor(index / 12);
    const month = index % 12;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const day = Math.min(parts.d, lastDay);
    return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
