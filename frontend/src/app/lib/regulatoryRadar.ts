// Presentation rules for the regulatory radar and the deadline badge: the
// Portuguese labels, how a change maps onto the review traffic light, and how
// many days are left before a notice period or a rule's effective date.
//
// Kept free of React so the arithmetic is tested to the last branch.

import type {
    RegulatoryChange,
    RegulatoryImpact,
    RegulatorySourceId,
    RegulatoryTab,
    RegulatoryTopic,
} from "./mikeApi";

/** "1 contrato", "3 contratos": the count and the word, agreeing. */
export function plural(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
}

export const IMPACT_LABEL: Record<RegulatoryImpact, string> = {
    alto: "Impacto alto",
    medio: "Impacto médio",
    baixo: "Impacto baixo",
};

/**
 * The traffic light a change speaks in. High impact asks for action (red),
 * medium asks someone to read it (amber), low is informative (green, nothing
 * to do). The words say the impact, so colour never stands alone.
 */
export function impactVerdict(impact: RegulatoryImpact): "diverge" | "precisa_revisao" | "alinhado" {
    if (impact === "alto") return "diverge";
    if (impact === "medio") return "precisa_revisao";
    return "alinhado";
}

export const SOURCE_SHORT: Record<RegulatorySourceId, string> = {
    bcb_normativos: "BCB",
    dou: "DOU",
    cvm_noticias: "CVM",
    rfb_noticias: "Receita",
};

export const TOPIC_LABEL: Record<RegulatoryTopic, string> = {
    psp: "Pagamentos/PSP",
    cripto: "Cripto/VASP",
    cambio: "Câmbio",
    lgpd: "Dados pessoais",
    pld: "PLD/FT",
};

export const TABS: { id: RegulatoryTab; label: string }[] = [
    { id: "todas", label: "Todas" },
    { id: "nao_lidas", label: "Não lidas" },
    { id: "favoritas", label: "Favoritas" },
    { id: "arquivadas", label: "Arquivadas" },
];

/** "2026-10-20" → "20/10/2026"; null stays null. */
export function brDate(iso: string | null | undefined): string | null {
    const m = typeof iso === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
    return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

/** Whole days from today (local midnight) to a YYYY-MM-DD date. */
export function daysUntil(isoDate: string, now: Date = new Date()): number {
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
    return Math.round((Date.UTC(y, m - 1, d) - today) / 86_400_000);
}

export type DeadlineTone = "vencido" | "d7" | "d30" | "d60" | "d90" | "longe" | "em_vigor";

/**
 * The badge's tone: D-90 grey, D-60 light amber, D-30 amber, D-7 red,
 * past due solid red. Further than 90 days stays grey.
 */
export function deadlineTone(days: number, kind: DeadlineKind = "aviso"): DeadlineTone {
    // A rule that already took effect is in force, not overdue.
    if (days < 0) return kind === "vigencia" ? "em_vigor" : "vencido";
    if (days <= 7) return "d7";
    if (days <= 30) return "d30";
    if (days <= 60) return "d60";
    if (days <= 90) return "d90";
    return "longe";
}

export type DeadlineKind = "aviso" | "vigencia" | "prazo";

export function deadlineLabel(days: number, kind: DeadlineKind = "aviso"): string {
    if (days < 0) return kind === "vigencia" ? "em vigor" : "vencido";
    if (days === 0) return "hoje";
    return `D-${days}`;
}

/**
 * The tooltip that shows the arithmetic, so nobody has to trust the badge:
 * "aviso até 11/10/2026 (vencimento 10/11/2026 − 30 dias de aviso)".
 */
export function deadlineTooltip(args: {
    date: string;
    kind?: DeadlineKind;
    endDate?: string | null;
    noticeDays?: number | null;
    /** The date has passed. */
    past?: boolean;
}): string {
    const when = brDate(args.date);
    const kind = args.kind ?? "aviso";
    if (kind === "vigencia") return `${args.past ? "em vigor desde" : "entra em vigor em"} ${when}`;
    if (kind === "prazo") return `prazo até ${when}`;
    const end = brDate(args.endDate ?? null);
    if (end && typeof args.noticeDays === "number") {
        return `aviso até ${when} (vencimento ${end} − ${plural(args.noticeDays, "dia", "dias")} de aviso)`;
    }
    return `aviso até ${when}`;
}

/** "Sua varredura LGPD encontrou 3 mudanças." — the fixed microcopy. */
export function scanHeadline(name: string, found: number): { lead: string; name: string; tail: string } {
    if (found === 0) return { lead: "Sua varredura", name, tail: "não encontrou mudanças novas." };
    return { lead: "Sua varredura", name, tail: `encontrou ${plural(found, "mudança", "mudanças")}.` };
}

/** The one line under a change's title in the list. */
export function changeMeta(change: Pick<RegulatoryChange, "source" | "act_type" | "published_at">): string {
    return [SOURCE_SHORT[change.source], change.act_type, brDate(change.published_at)].filter(Boolean).join(" · ");
}

/** "4 contratos afetados", plus how many the reader cannot open. */
export function affectedLabel(shown: number, hidden: number): string {
    const total = shown + hidden;
    if (total === 0) return "nenhum contrato afetado";
    const base = plural(total, "contrato afetado", "contratos afetados");
    return hidden > 0 ? `${base} (${hidden} sem acesso)` : base;
}

export function relativeRun(iso: string | null, now: number = Date.now()): string {
    if (!iso) return "ainda não rodou";
    const minutes = Math.floor(Math.max(0, now - Date.parse(iso)) / 60_000);
    if (minutes < 1) return "varrido agora";
    if (minutes < 60) return `varrido há ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `varrido há ${hours} h`;
    return `varrido há ${Math.floor(hours / 24)} d`;
}
