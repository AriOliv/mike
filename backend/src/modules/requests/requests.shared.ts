// Vocabulary and pure rules of requests to the legal team: kinds, statuses,
// the readable number, the SLA clock and the requester-facing steps. Nothing
// here touches the database, so the rules are tested on their own.

export const REQUEST_KINDS = [
    "contrato_novo",
    "revisao",
    "aditivo",
    "nda",
    "parecer",
    "outro",
] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const KIND_LABELS: Record<RequestKind, string> = {
    contrato_novo: "Contrato novo",
    revisao: "Revisão de contrato",
    aditivo: "Aditivo ou renovação",
    nda: "NDA",
    parecer: "Parecer ou dúvida",
    outro: "Outro",
};

/**
 * The areas a request comes from. A short fixed list, so the dashboard
 * groups cleanly; anything else is "Outra".
 */
export const REQUESTER_AREAS = [
    "Comercial",
    "Produto",
    "Tecnologia",
    "Operações",
    "Financeiro",
    "Compras",
    "Pessoas",
    "Marketing",
    "Compliance",
    "Diretoria",
    "Outra",
] as const;
export type RequesterArea = (typeof REQUESTER_AREAS)[number];

const AREA_ALIASES: Record<string, RequesterArea> = {
    vendas: "Comercial",
    sales: "Comercial",
    "business development": "Comercial",
    bd: "Comercial",
    tech: "Tecnologia",
    engenharia: "Tecnologia",
    ti: "Tecnologia",
    ops: "Operações",
    operacoes: "Operações",
    finance: "Financeiro",
    finanças: "Financeiro",
    financas: "Financeiro",
    rh: "Pessoas",
    "recursos humanos": "Pessoas",
    people: "Pessoas",
    founders: "Diretoria",
    "c-level": "Diretoria",
    diretoria: "Diretoria",
    procurement: "Compras",
};

/** Maps free text ("vendas", "RH", "Comercial") onto the fixed list; null when empty. */
export function normalizeArea(value: unknown): RequesterArea | null {
    if (typeof value !== "string" || !value.trim()) return null;
    const text = value.trim().toLowerCase();
    const exact = REQUESTER_AREAS.find((a) => a.toLowerCase() === text);
    if (exact) return exact;
    return AREA_ALIASES[text] ?? "Outra";
}

export const URGENCIES = ["normal", "alta", "urgente"] as const;
export type Urgency = (typeof URGENCIES)[number];

export const REQUEST_STATUSES = [
    "novo",
    "em_triagem",
    "em_andamento",
    "aguardando_solicitante",
    "entregue",
    "cancelado",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const OPEN_STATUSES: readonly RequestStatus[] = [
    "novo",
    "em_triagem",
    "em_andamento",
    "aguardando_solicitante",
];

/**
 * Default SLA in business days by kind (03-ux-spec §4.2, to validate with the
 * Head): NDA 1, review and amendment 3, new contract 5, opinion 2. The team's
 * own table (legal_teams.sla_days) overrides any of them.
 */
export const DEFAULT_SLA_DAYS: Record<RequestKind, number> = {
    nda: 1,
    parecer: 2,
    revisao: 3,
    aditivo: 3,
    contrato_novo: 5,
    outro: 3,
};

/** An urgent request takes a third of the time, a high one two thirds, never under a day. */
const URGENCY_FACTOR: Record<Urgency, number> = { normal: 1, alta: 2 / 3, urgente: 1 / 3 };

export function slaDays(
    kind: RequestKind,
    urgency: Urgency,
    overrides: Record<string, unknown> = {},
): number {
    const custom = Number(overrides[kind]);
    const base = Number.isFinite(custom) && custom > 0 ? custom : DEFAULT_SLA_DAYS[kind];
    return Math.max(1, Math.round(base * URGENCY_FACTOR[urgency]));
}

/** `days` business days after `from` (Saturday and Sunday skipped), same time of day. */
export function addBusinessDays(from: Date, days: number): Date {
    const out = new Date(from.getTime());
    let left = days;
    while (left > 0) {
        out.setUTCDate(out.getUTCDate() + 1);
        const day = out.getUTCDay();
        if (day !== 0 && day !== 6) left -= 1;
    }
    return out;
}

/**
 * When the request is due: the SLA from now, unless the requester needs it
 * sooner — then their date (end of that day, UTC). A date in the past is
 * ignored rather than producing a request born late.
 */
export function computeDueAt(
    now: Date,
    kind: RequestKind,
    urgency: Urgency,
    neededBy: string | null,
    overrides: Record<string, unknown> = {},
): Date {
    const bySla = addBusinessDays(now, slaDays(kind, urgency, overrides));
    if (!neededBy) return bySla;
    const needed = new Date(`${neededBy}T23:59:59Z`);
    if (Number.isNaN(needed.getTime()) || needed <= now) return bySla;
    return needed < bySla ? needed : bySla;
}

export type SlaClock = {
    due_at: string;
    status: RequestStatus;
    paused_at: string | null;
    paused_seconds: number;
};

/**
 * The effective deadline: the due date pushed back by every second the
 * request spent waiting on the requester, including a pause still running.
 */
export function effectiveDueAt(clock: SlaClock, now: Date): Date {
    let paused = clock.paused_seconds || 0;
    if (clock.paused_at) {
        paused += Math.max(0, (now.getTime() - new Date(clock.paused_at).getTime()) / 1000);
    }
    return new Date(new Date(clock.due_at).getTime() + paused * 1000);
}

export type SlaState = "no_prazo" | "estourando" | "estourado" | "pausado" | "encerrado";

/** On time, due within a day ("estourando"), late, paused or closed. */
export function slaState(clock: SlaClock, now: Date): SlaState {
    if (clock.status === "entregue" || clock.status === "cancelado") return "encerrado";
    if (clock.status === "aguardando_solicitante") return "pausado";
    const left = effectiveDueAt(clock, now).getTime() - now.getTime();
    if (left < 0) return "estourado";
    if (left < 24 * 3600 * 1000) return "estourando";
    return "no_prazo";
}

/** LEG-0001. Numbers past 9999 keep growing (LEG-12345). */
export function requestCode(number: number): string {
    return `LEG-${String(number).padStart(4, "0")}`;
}

/** Accepts "LEG-0042", "leg-42" or "42"; null when it is none of those. */
export function parseRequestCode(value: string): number | null {
    const match = /^(?:leg-?)?0*(\d{1,9})$/i.exec(value.trim());
    if (!match) return null;
    const n = Number(match[1]);
    return n > 0 ? n : null;
}

/**
 * The four steps a requester sees (03-ux-spec §3). The team's six pipeline
 * lanes and its internal statuses stay behind them.
 */
export const REQUESTER_STEPS = ["recebido", "em_analise", "assinatura", "concluido"] as const;
export type RequesterStep = (typeof REQUESTER_STEPS)[number];

/**
 * The pipeline's lanes (the contracts module's LANES), kept here too so the
 * MCP tools' input schemas do not need another module loaded to be built.
 */
export const PIPELINE_LANES = ["entrada", "triagem", "revisao", "negociacao", "assinatura", "arquivado"] as const;

/** The pipeline's lanes as the team reads them. */
export const LANE_LABELS: Record<string, string> = {
    entrada: "Entrada",
    triagem: "Triagem",
    revisao: "Revisão",
    negociacao: "Negociação",
    assinatura: "Assinatura",
    arquivado: "Arquivado",
};

export function requesterStep(status: RequestStatus, lane: string | null): RequesterStep {
    if (status === "entregue" || status === "cancelado" || lane === "arquivado") return "concluido";
    if (lane === "assinatura") return "assinatura";
    if (status === "novo" || status === "em_triagem" || lane === "entrada" || lane === "triagem") {
        return status === "em_andamento" || status === "aguardando_solicitante"
            ? "em_analise"
            : "recebido";
    }
    return "em_analise";
}

export function isEmail(value: unknown): value is string {
    return typeof value === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
}

export function cleanText(value: unknown, max: number): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : null;
}

export type PlanStep = {
    id: string;
    owner: { kind: "agent" | "person" | "requester"; name: string };
    task: string;
    state: "feito" | "rodando" | "a_fazer" | "aguardando";
    /** The step leaves the Mike (e-mail, chat): it asks before acting. */
    asksFirst?: boolean;
};

export type PlanInput = {
    status: string;
    assignee_name: string | null;
    requester_name: string | null;
    requester_email: string;
    triage: {
        kind?: string | null;
        assignee_name?: string | null;
        playbook_name?: string | null;
        missing?: string[] | null;
    } | null;
    answered: boolean;
};

/**
 * The orchestration plan of a request: who does what, in order, and where it
 * stands, agents and people on the same list. The same plan the team panel
 * draws (frontend lib/requests.ts requestPlan); the MCP tools return it.
 * `forRequester` leaves out the internal review step (which playbook runs).
 */
export function requestPlan(request: PlanInput, options: { forRequester?: boolean } = {}): PlanStep[] {
    const triage = request.triage;
    const closed = request.status === "entregue" || request.status === "cancelado";
    const person = request.assignee_name ?? triage?.assignee_name ?? "Responsável";
    const kindLabel = triage?.kind ? (KIND_LABELS[triage.kind as RequestKind] ?? triage.kind) : null;
    const steps: PlanStep[] = [
        {
            id: "triagem",
            owner: { kind: "agent", name: "Agente de triagem" },
            task: kindLabel ? `classificou como ${kindLabel} e listou o que falta` : "classificar e listar o que falta",
            state: triage ? "feito" : "rodando",
        },
        {
            id: "atribuicao",
            owner: { kind: "agent", name: "Agente de atribuição" },
            task: triage?.assignee_name ? `sugeriu ${triage.assignee_name} pela carga do time` : "sugerir quem pega",
            state: triage ? "feito" : "a_fazer",
        },
    ];
    if (triage?.playbook_name && !options.forRequester) {
        steps.push({
            id: "revisao",
            owner: { kind: "agent", name: "Agente de revisão" },
            task: `rodar o playbook "${triage.playbook_name}" quando o documento chegar`,
            state: closed ? "feito" : "a_fazer",
        });
    }
    const missing = triage?.missing ?? [];
    if (missing.length > 0 || request.status === "aguardando_solicitante") {
        steps.push({
            id: "solicitante",
            owner: { kind: "requester", name: request.requester_name ?? request.requester_email },
            task: missing.length ? `enviar: ${missing.join(", ")}` : "responder a pergunta do Legal",
            state:
                request.status === "aguardando_solicitante"
                    ? "aguardando"
                    : closed || request.answered
                      ? "feito"
                      : "a_fazer",
        });
    }
    steps.push({
        id: "analise",
        owner: { kind: "person", name: person },
        task: "analisar e decidir",
        state: closed ? "feito" : request.assignee_name && request.status === "em_andamento" ? "rodando" : "a_fazer",
    });
    steps.push({
        id: "devolutiva",
        owner: { kind: "person", name: person },
        task: "devolver ao solicitante por e-mail",
        state: request.status === "entregue" ? "feito" : "a_fazer",
        asksFirst: true,
    });
    return steps;
}
