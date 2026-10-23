// Reads the contract value out of the checklist's free-text money answer
// ("R$ 12.000,00 mensais", "12 mil por mês", "R$ 1,5 mi"). Conservative on
// purpose: an assignment rule by value must never fire on a guess, so
// anything ambiguous (two different amounts, another currency, no number)
// returns null and the rule simply does not match.

const FOREIGN = /\b(?:us\$|usd|usdc|usdt|eur|eurc|€|£|d[oó]lar(?:es)?|euros?)\b|us\$|€|£/i;
const AMOUNT = /(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?|\d+(?:\.\d+)?)(?:\s*(mil|mi|milh[aã]o|milh[õo]es|k|m)\b)?/gi;
const SCALE: Record<string, number> = { mil: 1e3, k: 1e3, mi: 1e6, m: 1e6, milhao: 1e6, milhão: 1e6, milhoes: 1e6, milhões: 1e6 };

function toNumber(raw: string): number {
    // Brazilian: "." groups thousands, "," is the decimal. A lone "." with 1-2 digits after is a decimal ("1.5").
    const normalized = /,/.test(raw)
        ? raw.replace(/\./g, "").replace(",", ".")
        : /^\d{1,3}(?:\.\d{3})+$/.test(raw)
          ? raw.replace(/\./g, "")
          : raw;
    // The pattern above only lets digits, "." and "," through, so this is always a finite number.
    return Number(normalized);
}

/** The value in reais when the text carries exactly one amount in reais, else null. */
export function parseMoney(text: string): number | null {
    if (!text || FOREIGN.test(text)) return null;
    const found = new Set<number>();
    for (const match of text.matchAll(AMOUNT)) {
        const base = toNumber(match[1]);
        const unit = match[2]?.toLowerCase();
        found.add(Math.round(base * (unit ? (SCALE[unit] ?? 1) : 1) * 100) / 100);
    }
    // Digits that are not an amount of money (a "12 meses" term) would make a second number: ambiguous.
    return found.size === 1 ? [...found][0] : null;
}
