/**
 * The Contratos portfolio: one row per contract with the Ficha's columns,
 * the Legal team's spreadsheet kept by the Mike instead of by hand
 * (docs/product/03 §4.6). Rows come from GET /contracts/fichas.
 */

/** Same shape as mikeApi's ContractPortfolioRow (GET /contracts/fichas). */
export type PortfolioRow = {
    project_id: string;
    name: string;
    counterparty: string | null;
    contract_type: string | null;
    lane: string | null;
    /** YYYY-MM-DD. */
    term_end: string | null;
    notice_days: number | null;
    /** YYYY-MM-DD: the last day to give notice. */
    notice_deadline: string | null;
    filled: number;
    verified: number;
    total: number;
    risk: "critico" | "atencao" | "ok" | null;
};

export type PortfolioSort = "aviso" | "nome";

/** Whole days from `today` (local calendar day) to a YYYY-MM-DD date. */
export function daysUntil(isoDate: string, today: Date): number {
    const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
    return Math.round((Date.UTC(y, m - 1, d) - start) / 86_400_000);
}

/**
 * Soonest notice first, so what needs a decision is on top; contracts with
 * no known notice date go last, by name.
 */
export function sortPortfolio(rows: readonly PortfolioRow[], sort: PortfolioSort): PortfolioRow[] {
    const byName = (a: PortfolioRow, b: PortfolioRow) => a.name.localeCompare(b.name, "pt-BR");
    const copy = [...rows];
    if (sort === "nome") return copy.sort(byName);
    return copy.sort((a, b) => {
        if (a.notice_deadline && b.notice_deadline) {
            return a.notice_deadline.localeCompare(b.notice_deadline) || byName(a, b);
        }
        if (a.notice_deadline) return -1;
        if (b.notice_deadline) return 1;
        return byName(a, b);
    });
}

/** "12 de 24 preenchidos", or "sem Ficha" before the first extraction. */
export function fichaProgress(row: Pick<PortfolioRow, "filled" | "total">): string {
    if (row.total === 0) return "sem Ficha";
    return `${row.filled} de ${row.total} preenchidos`;
}

/** Formats YYYY-MM-DD as dd/mm/aaaa without shifting the day across time zones. */
export function brDate(isoDate: string | null): string {
    if (!isoDate) return "—";
    const [y, m, d] = isoDate.slice(0, 10).split("-");
    return `${d}/${m}/${y}`;
}

export type PortfolioLoad =
    | { status: "ok"; rows: PortfolioRow[] }
    | { status: "unavailable" };
