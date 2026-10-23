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
    /** Who holds the contract's request, by name. */
    assignee: string | null;
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

/** The tabs: where a contract stands, in the words the Legal team uses. */
export type Situation = "andamento" | "assinatura" | "vigente" | "vencido";
export type SituationTab = "todos" | Situation;

export const SITUATION_TABS: readonly { id: SituationTab; label: string }[] = [
    { id: "todos", label: "Todos" },
    { id: "andamento", label: "Em andamento" },
    { id: "assinatura", label: "Em assinatura" },
    { id: "vigente", label: "Vigentes" },
    { id: "vencido", label: "Vencidos" },
];

/**
 * Where a contract stands. Before the archive it is still moving (in
 * signature, or in progress); once archived it is in force until its term
 * ends, then expired. No term end read yet: it stays in force.
 */
export function situationOf(row: Pick<PortfolioRow, "lane" | "term_end">, today: Date): Situation {
    if (row.lane === "assinatura") return "assinatura";
    if (row.lane !== "arquivado") return "andamento";
    return row.term_end && daysUntil(row.term_end, today) < 0 ? "vencido" : "vigente";
}

const STAGE_LABEL: Record<string, string> = {
    entrada: "Entrada",
    triagem: "Triagem",
    revisao: "Análise",
    negociacao: "Negociação",
    assinatura: "Assinatura",
    arquivado: "Concluído",
};

/** The current stage, the same words as the request's strip (a lane's name for the stage it holds). */
export function stageLabel(lane: string | null): string {
    return (lane && STAGE_LABEL[lane]) || "—";
}

export type PortfolioFilter = { tab: SituationTab; query: string; assignee: string };

export const NO_ASSIGNEE = "__sem__";

const fold = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** The rows a tab, a search (name, counterparty, type) and an owner leave in. */
export function filterPortfolio(rows: readonly PortfolioRow[], filter: PortfolioFilter, today: Date): PortfolioRow[] {
    const needle = fold(filter.query.trim());
    return rows.filter((row) => {
        if (filter.tab !== "todos" && situationOf(row, today) !== filter.tab) return false;
        if (filter.assignee === NO_ASSIGNEE ? row.assignee !== null : filter.assignee !== "" && row.assignee !== filter.assignee) return false;
        if (!needle) return true;
        return fold(`${row.name} ${row.counterparty ?? ""} ${contractTypeLabel(row.contract_type)}`).includes(needle);
    });
}

/** The owners to pick from, as many as the list has, by name. */
export function assigneeOptions(rows: readonly PortfolioRow[]): string[] {
    return [...new Set(rows.map((r) => r.assignee).filter((a): a is string => !!a))].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

const SITUATION_LABEL: Record<Situation, string> = {
    andamento: "Em andamento",
    assinatura: "Em assinatura",
    vigente: "Vigente",
    vencido: "Vencido",
};

/** A spreadsheet cell that Excel cannot read as a formula, quoted for ";" files. */
function csvCell(value: string): string {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[;"\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The list as a CSV Excel opens in pt-BR (";" and a BOM), one line per contract. */
export function portfolioCsv(rows: readonly PortfolioRow[], today: Date): string {
    const header = ["Contrato", "Contraparte", "Tipo", "Situação", "Etapa", "Responsável", "Vencimento", "Aviso até"];
    const lines = rows.map((row) =>
        [
            row.name,
            row.counterparty ?? "",
            contractTypeLabel(row.contract_type),
            SITUATION_LABEL[situationOf(row, today)],
            stageLabel(row.lane),
            row.assignee ?? "",
            row.term_end ? brDate(row.term_end) : "",
            row.notice_deadline ? brDate(row.notice_deadline) : "",
        ]
            .map(csvCell)
            .join(";"),
    );
    return `\uFEFF${[header.join(";"), ...lines].join("\r\n")}\r\n`;
}

/** "12 de 24 preenchidos", or "sem Ficha" before the first extraction. */
export function fichaProgress(row: Pick<PortfolioRow, "filled" | "total">): string {
    if (row.total === 0) return "sem Ficha";
    return `${row.filled} de ${row.total} preenchidos`;
}

const CONTRACT_TYPE_LABELS: Record<string, string> = {
    nda: "NDA",
    prestacao_servicos: "Prestação de serviços",
    msa: "MSA",
    pedido_sow: "Pedido / SOW",
    licenca_saas: "Licença SaaS",
    saas: "SaaS",
    licenca: "Licença de software",
    parceria: "Parceria",
    parceria_comercial: "Parceria comercial",
    indicacao_rebate: "Indicação e rebate",
    parceiro_bancario_baas: "Parceiro bancário / BaaS",
    arranjo_psp_adquirencia: "PSP e adquirência",
    liquidez_otc_cambio: "Liquidez, OTC e câmbio",
    custodia_cripto: "Custódia cripto",
    cliente_api_plataforma: "Cliente de API / plataforma",
    locacao: "Locação",
    prestador_pj: "Prestador PJ",
    mutuo_emprestimo: "Mútuo e empréstimo",
    carta_intencao_mou: "Carta de intenção / MOU",
    procuracao: "Procuração",
    tratamento_dados: "Tratamento de dados",
    aditivo: "Aditivo",
    distrato: "Distrato",
    outro: "Outro",
};

/** The contract type as a person reads it, never the stored key ("prestacao_servicos"). */
export function contractTypeLabel(type: string | null): string {
    if (!type) return "—";
    const known = CONTRACT_TYPE_LABELS[type];
    if (known) return known;
    const words = type.replace(/_/g, " ").trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : "—";
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
