/**
 * The contract's terms asked on "Pedir ao Legal" (part 2): the start, the
 * term in months, and the end computed from them. The same rules as the
 * server's (requests.terms.ts), so the sentence under the fields and what
 * the team later reads are the same date.
 */

export const MIN_TERM_MONTHS = 1;
export const MAX_TERM_MONTHS = 600;

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(value: string): { y: number; m: number; d: number } | null {
    const match = ISO.exec(value);
    if (!match) return null;
    const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
    return { y, m, d };
}

/**
 * The day the term ends: the start plus the months, on the same day, or the
 * last day of a shorter month ("31/01 + 1 mês = 28/02"). Null until both are
 * valid.
 */
export function termEndDate(start: string, months: number | null): string | null {
    const p = parts(start);
    if (!p || months === null || !Number.isInteger(months) || months < MIN_TERM_MONTHS || months > MAX_TERM_MONTHS) return null;
    const index = p.y * 12 + (p.m - 1) + months;
    const year = Math.floor(index / 12);
    const month = index % 12;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const day = Math.min(p.d, lastDay);
    return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "12/11/2027" from "2027-11-12". */
export function brDate(iso: string): string {
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
}

/** The sentence under the two fields, or null until there is something to say. */
export function termEndSentence(start: string, months: number | null): string | null {
    const end = termEndDate(start, months);
    if (!end || months === null) return null;
    return `Termina em ${brDate(end)} (início + ${months} ${months === 1 ? "mês" : "meses"})`;
}

/** The months field as typed: null when empty, NaN-safe, never throws. */
export function parseMonths(raw: string): number | null {
    const text = raw.trim();
    if (!text) return null;
    return /^\d+$/.test(text) ? Number(text) : Number.NaN;
}

/** An error under the months field, in the words the server uses; null when fine or empty. */
export function monthsError(raw: string): string | null {
    const months = parseMonths(raw);
    if (months === null) return null;
    if (Number.isNaN(months)) return "Use um prazo em meses, com número inteiro.";
    if (months < MIN_TERM_MONTHS) return "Use um prazo de 1 mês ou mais.";
    if (months > MAX_TERM_MONTHS) return "Confira o prazo: isso passa de 50 anos.";
    return null;
}

/** A start date far in the past is legitimate (an old contract): a notice, never an error. */
export function startNotice(start: string, today: Date = new Date()): string | null {
    const p = parts(start);
    if (!p) return null;
    const years = today.getUTCFullYear() - p.y;
    return years > 5 ? "Essa data de início é de mais de 5 anos atrás. Confira se está certa." : null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The same plain check as the server's: empty is fine, anything else must look like an e-mail. */
export function emailError(raw: string): string | null {
    const email = raw.trim();
    if (!email) return null;
    return EMAIL.test(email) && email.length <= 254 ? null : "Esse e-mail não parece certo. Confira e tente de novo.";
}
