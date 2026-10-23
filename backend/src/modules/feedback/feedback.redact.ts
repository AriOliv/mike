// Redaction of what a person types before it is stored (doc 13 §7). E-mail,
// CNPJ, CPF, phone and long digit runs become a label; the original is not
// kept. A person's name is NOT caught (no rule can): the modal says so.

const CNPJ = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g;
const CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// (11) 91234-5678, +55 11 91234 5678, 11 3456-7890
const PHONE = /(?:\+?55[\s-]?)?\(?\b\d{2}\)?[\s-]?9?\d{4}[\s-]?\d{4}\b/g;
const LONG_DIGITS = /\b\d{7,}\b/g;
// A token or key pasted by mistake.
const SECRET = /\b(?:mike_(?:pat|svc|oat|ort|cfm)_[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g;

export type Redaction = { text: string; found: number };

/** Order matters: the longer, more specific patterns first. */
export function redact(input: string): Redaction {
    let found = 0;
    const swap = (re: RegExp, label: string) => {
        text = text.replace(re, () => {
            found++;
            return label;
        });
    };
    let text = input;
    swap(SECRET, "[segredo]");
    swap(EMAIL, "[e-mail]");
    swap(CNPJ, "[CNPJ]");
    swap(CPF, "[CPF]");
    swap(PHONE, "[telefone]");
    swap(LONG_DIGITS, "[número]");
    return { text, found };
}

/** A route without query or fragment, and with ids kept out of the log. */
export function cleanRoute(route: unknown): string | null {
    if (typeof route !== "string") return null;
    const path = route.split(/[?#]/)[0].trim().slice(0, 200);
    return path.startsWith("/") ? path : null;
}
