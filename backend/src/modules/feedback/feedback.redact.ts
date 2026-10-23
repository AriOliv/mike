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

/**
 * Every character a reader may take as the end of a line, plus the controls that hide text: C0 (including
 * \n, \r and tab), DEL, C1 (including NEL, U+0085), line separator U+2028 and paragraph separator U+2029.
 * The issue body is read line by line (the triage looks for "- Papel: ..."), so a value that carries one of
 * these can start a line of its own and say what the server did not.
 */
export const LINE_BREAKS_AND_CONTROLS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g;

/** One line of plain text: breaks and controls become a space, the ends are trimmed. */
export function oneLine(value: string): string {
    return value.replace(LINE_BREAKS_AND_CONTROLS, " ").trim();
}

/** A route without query or fragment, on one line, and with ids kept out of the log. */
export function cleanRoute(route: unknown): string | null {
    if (typeof route !== "string") return null;
    const path = oneLine(route.split(/[?#]/)[0]).slice(0, 200);
    return path.startsWith("/") ? path : null;
}
