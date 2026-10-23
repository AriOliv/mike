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
