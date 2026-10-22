// Presentation rules of requests to the legal team: the words, the filters
// behind the counters, the SLA line, the requester's four steps and the
// orchestration plan the card shows. Pure functions, so the pages stay thin.

import type {
    LegalRequest,
    RequestKind,
    RequestListItem,
    RequesterStep,
    RequestSla,
    RequestStatus,
    RequestUrgency,
} from "./mikeApi";

export const KIND_OPTIONS: { value: RequestKind; label: string; hint: string }[] = [
    { value: "revisao", label: "Revisar um contrato", hint: "Recebeu um contrato e quer o ok do Legal" },
    { value: "contrato_novo", label: "Contrato novo", hint: "Precisa de um contrato que ainda não existe" },
    { value: "nda", label: "NDA", hint: "Confidencialidade antes de conversar ou trocar dados" },
    { value: "aditivo", label: "Aditivo ou renovação", hint: "Mudar, renovar ou encerrar um contrato" },
    { value: "parecer", label: "Dúvida jurídica", hint: "Uma pergunta, sem documento para revisar" },
    { value: "outro", label: "Outro", hint: "Nenhuma das opções" },
];

export const URGENCY_OPTIONS: { value: RequestUrgency; label: string }[] = [
    { value: "normal", label: "Normal" },
    { value: "alta", label: "Alta" },
    { value: "urgente", label: "Urgente" },
];

export const STATUS_LABEL: Record<RequestStatus, string> = {
    novo: "Novo",
    em_triagem: "Em triagem",
    em_andamento: "Em análise",
    aguardando_solicitante: "Aguardando solicitante",
    entregue: "Entregue",
    cancelado: "Cancelado",
};

export type RequestChip = {
    status: "a_fazer" | "rodando" | "pronto" | "em_andamento" | "aguardando" | "concluido";
    label: string;
};

/**
 * How a request's state reads on a StatusChip. "rodando" only while the
 * triage agent is actually working; once its suggestion waits for a person
 * it is "pronto". Waiting on the requester is amber "aguardando", never red:
 * it is not the team's problem.
 */
export function requestChip(status: RequestStatus, triage: { triaged: boolean; pending: boolean }): RequestChip {
    switch (status) {
        case "novo":
            return { status: "a_fazer", label: STATUS_LABEL.novo };
        case "em_triagem":
            if (triage.pending) return { status: "pronto", label: "Triagem pronta" };
            if (triage.triaged) return { status: "em_andamento", label: STATUS_LABEL.em_triagem };
            return { status: "rodando", label: "Fazendo a triagem…" };
        case "em_andamento":
            return { status: "em_andamento", label: STATUS_LABEL.em_andamento };
        case "aguardando_solicitante":
            return { status: "aguardando", label: STATUS_LABEL.aguardando_solicitante };
        default:
            return { status: "concluido", label: STATUS_LABEL[status] };
    }
}

export const CHANNEL_LABEL: Record<string, string> = {
    form: "Formulário",
    slack: "Slack",
    whatsapp: "WhatsApp",
    email: "E-mail",
    mcp: "Assistente",
};

export const STEP_LABELS: { step: RequesterStep; label: string }[] = [
    { step: "recebido", label: "Recebido" },
    { step: "em_analise", label: "Em análise" },
    { step: "assinatura", label: "Assinatura" },
    { step: "concluido", label: "Concluído" },
];

export function stepIndex(step: RequesterStep): number {
    return STEP_LABELS.findIndex((s) => s.step === step);
}

/** "vence em 2 d", "vence em 5 h", "atrasado 1 d", "pausado", "encerrado". */
export function slaText(sla: RequestSla, dueAt: string, now: number = Date.now()): string {
    if (sla === "pausado") return "pausado";
    if (sla === "encerrado") return "encerrado";
    const ms = Date.parse(dueAt) - now;
    const hours = Math.round(Math.abs(ms) / 3_600_000);
    const days = Math.round(Math.abs(ms) / 86_400_000);
    if (ms < 0) return hours < 24 ? `atrasado ${Math.max(hours, 1)} h` : `atrasado ${days} d`;
    if (hours < 24) return hours <= 1 ? "vence em 1 h" : `vence em ${hours} h`;
    return `vence em ${days} d`;
}

export function slaTone(sla: RequestSla): "default" | "atencao" | "critico" {
    if (sla === "estourado") return "critico";
    if (sla === "estourando") return "atencao";
    return "default";
}

/**
 * "agora", "há 2 h", "ontem", "há 3 dias", then the date ("12/10") past a
 * week: relative is easier to read while it is recent, and a date is easier
 * to find later.
 */
export function sinceText(iso: string, now: number = Date.now()): string {
    const ms = now - Date.parse(iso);
    if (!Number.isFinite(ms)) return "";
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) return "agora";
    if (minutes < 60) return `há ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `há ${hours} h`;
    const days = Math.floor(hours / 24);
    if (days === 1) return "ontem";
    if (days <= 7) return `há ${days} dias`;
    return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" });
}

/**
 * Who has the ball and since when, in words: "com Fulano, desde ontem",
 * "aguardando Ana, há 2 h", "sem responsável, desde ontem". Without a `since`
 * (a request older than the history) the time is left out.
 */
export function stageHolderText(
    owner: { kind: "agent" | "person" | "requester" | "none"; name: string | null },
    since: string | null,
    now: number = Date.now(),
): string {
    const when = since ? sinceText(since, now) : "";
    const time = when ? (when.startsWith("há") || when === "agora" ? `, ${when}` : `, desde ${when}`) : "";
    if (owner.kind === "requester") return `aguardando ${owner.name ?? "quem pediu"}${time}`;
    if (owner.kind === "agent") return `com o ${(owner.name ?? "agente").toLowerCase()}${time}`;
    if (owner.kind === "person" && owner.name) return `com ${owner.name}${time}`;
    return `sem responsável${time}`;
}

/** "Etapa 3 de 5", or null on the two ends, which do not count. */
export function positionText(position: { index: number; of: number } | null): string | null {
    return position ? `Etapa ${position.index} de ${position.of}` : null;
}

/** dd/mm/aaaa in São Paulo time. */
export function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

export type QueueFilter = "sem_dono" | "sla_estourando" | "aguardando_solicitante" | "concluidos_semana" | "meus";
export type QueueTab = "abertos" | "meus" | "todos";

const OPEN: RequestStatus[] = ["novo", "em_triagem", "em_andamento", "aguardando_solicitante"];

/** The rows a tab and a counter leave, with a text search over code, title, counterparty and requester. */
export function filterQueue(
    items: RequestListItem[],
    options: { tab: QueueTab; filter: QueueFilter | null; userId: string | null; query: string; now?: number },
): RequestListItem[] {
    const q = options.query.trim().toLowerCase();
    const weekAgo = (options.now ?? Date.now()) - 7 * 86_400_000;
    return items.filter((item) => {
        const open = OPEN.includes(item.status);
        if (options.tab === "abertos" && !open && options.filter !== "concluidos_semana") return false;
        if (options.tab === "meus" && item.assignee_id !== options.userId) return false;
        switch (options.filter) {
            case "sem_dono":
                if (!open || item.assignee_id) return false;
                break;
            case "sla_estourando":
                if (!open || (item.sla !== "estourando" && item.sla !== "estourado")) return false;
                break;
            case "aguardando_solicitante":
                if (item.status !== "aguardando_solicitante") return false;
                break;
            case "concluidos_semana":
                if (item.status !== "entregue" || Date.parse(item.updated_at) < weekAgo) return false;
                break;
            case "meus":
                if (!open || item.assignee_id !== options.userId) return false;
                break;
        }
        if (!q) return true;
        return [item.code, item.title, item.counterparty, item.requester_name, item.requester_email, item.requester_area]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(q));
    });
}

/** Overdue first, then due soonest; closed ones last, newest first. */
export function sortQueue(items: RequestListItem[]): RequestListItem[] {
    return [...items].sort((a, b) => {
        const ao = OPEN.includes(a.status) ? 0 : 1;
        const bo = OPEN.includes(b.status) ? 0 : 1;
        if (ao !== bo) return ao - bo;
        if (ao === 1) return Date.parse(b.updated_at) - Date.parse(a.updated_at);
        return Date.parse(a.due_at) - Date.parse(b.due_at);
    });
}

export type PlanStep = {
    id: string;
    owner: { kind: "agent" | "person" | "requester"; name: string };
    task: string;
    state: "feito" | "rodando" | "a_fazer" | "aguardando";
    /** The step leaves the Mike (e-mail, chat): it asks before acting. */
    asksFirst?: boolean;
};

/**
 * The orchestration plan of a request: who does what, in order, and where it
 * stands. Agents and people sit on the same list; changing the person on a
 * step never resets the others.
 */
export function requestPlan(request: LegalRequest): PlanStep[] {
    const triage = request.triage ?? null;
    const closed = request.status === "entregue" || request.status === "cancelado";
    const person = request.assignee_name ?? triage?.assignee_name ?? "Responsável";
    const steps: PlanStep[] = [
        {
            id: "triagem",
            owner: { kind: "agent", name: "Agente de triagem" },
            task: triage?.kind
                ? `classificou como ${KIND_OPTIONS.find((k) => k.value === triage.kind)?.label ?? triage.kind} e listou o que falta`
                : "classificar e listar o que falta",
            state: triage ? "feito" : "rodando",
        },
        {
            id: "atribuicao",
            owner: { kind: "agent", name: "Agente de atribuição" },
            task: triage?.assignee_name ? `sugeriu ${triage.assignee_name} pela carga do time` : "sugerir quem pega",
            state: triage ? "feito" : "a_fazer",
        },
    ];
    if (triage?.playbook_name) {
        steps.push({
            id: "revisao",
            owner: { kind: "agent", name: "Agente de revisão" },
            task: `rodar o playbook "${triage.playbook_name}" quando o documento chegar`,
            state: closed ? "feito" : "a_fazer",
        });
    }
    if ((triage?.missing?.length ?? 0) > 0 || request.status === "aguardando_solicitante") {
        steps.push({
            id: "solicitante",
            owner: { kind: "requester", name: request.requester_name ?? request.requester_email },
            task: triage?.missing?.length ? `enviar: ${triage.missing.join(", ")}` : "responder a pergunta do Legal",
            state:
                request.status === "aguardando_solicitante"
                    ? "aguardando"
                    : closed || request.messages.some((m) => m.kind === "answer")
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
