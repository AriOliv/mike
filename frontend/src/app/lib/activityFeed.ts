// Turns the pipeline's activity log (card_events) into the lines of the
// activity feed: who did what, in Portuguese, newest first, with repeated
// events from the same actor folded together.

export type ActivityActorType = "user" | "agent" | "system" | "hermes";

/** One row of card_events as the API returns it. */
export type CardEventRow = {
    id: number;
    project_id: string;
    at: string;
    actor_type: ActivityActorType;
    actor_id: string;
    actor_name: string | null;
    on_behalf_of?: string | null;
    action: string;
    field?: string | null;
    before?: unknown;
    after?: unknown;
    run_id?: string | null;
    source?: string;
};

/** One line of the feed. */
export type ActivityItem = {
    id: string;
    actorType: ActivityActorType;
    actorName: string;
    verb: string;
    object?: string;
    /** How many sources the agent used, shown as "com N fontes". */
    sources?: number;
    at: string;
    href?: string;
    /** How many events this line stands for, when several were folded. */
    count?: number;
    /** What an agent did, step by step, shown under "ver o que fez" when there is no link. */
    steps?: string[];
    /** Who accepted an agent's suggestion: "confirmado por Fernanda". */
    confirmedBy?: string;
};

/** Fixed Portuguese names for the agents; the id prefix picks one. */
export const AGENT_NAMES: Record<string, string> = {
    intake: "Agente de intake",
    triagem: "Agente de triagem",
    atribuicao: "Agente de atribuição",
    extrator: "Agente de extração",
    revisor: "Agente de revisão",
    redator: "Agente de redação",
    vigia: "Agente de prazos",
    regulatorio: "Agente regulatório",
};

const LANE_LABEL: Record<string, string> = {
    entrada: "Entrada",
    triagem: "Triagem",
    revisao: "Revisão",
    negociacao: "Negociação",
    assinatura: "Assinatura",
    arquivado: "Arquivado",
};

const KIND_LABEL: Record<string, string> = {
    contrato_novo: "Contrato novo",
    revisao: "Revisão de contrato",
    aditivo: "Aditivo ou renovação",
    nda: "NDA",
    parecer: "Parecer ou dúvida",
    outro: "Outro",
};

const STATUS_LABEL: Record<string, string> = {
    a_fazer: "A fazer",
    em_andamento: "Em andamento",
    bloqueado: "Bloqueado",
    concluido: "Concluído",
};

/** Card and Ficha fields as people name them. */
export const FIELD_LABEL: Record<string, string> = {
    lane: "etapa",
    status: "progresso",
    assignee_email: "responsável",
    priority: "prioridade",
    deadline: "prazo",
    risk_level: "risco",
    contract_type: "tipo de contrato",
    counterparty: "contraparte",
    requester_name: "solicitante",
    triage: "triagem",
    notice_days: "aviso prévio",
    notice_deadline: "prazo do aviso",
    term_end: "vencimento",
    auto_renewal: "renovação automática",
    penalty_value: "multa",
    liability_cap: "limite de responsabilidade",
};

/**
 * A field in words: its label when known, the text as is when it already
 * reads as words ("Cessão do contrato"), and nothing for an unknown internal
 * name ("risk_level", "identificacao.tipo"), which never reaches the screen.
 */
export function fieldLabel(field: string | null | undefined): string | undefined {
    const name = field?.trim();
    if (!name) return undefined;
    if (FIELD_LABEL[name]) return FIELD_LABEL[name];
    return /[_.]/.test(name) || /^[a-z]+[A-Z]/.test(name) ? undefined : name;
}

/** "agent:revisor@1" → "revisor". */
function agentKey(actorId: string): string {
    return actorId.replace(/^agent:/, "").split("@")[0];
}

export function actorLabel(event: Pick<CardEventRow, "actor_type" | "actor_id" | "actor_name">): string {
    if (event.actor_name?.trim()) return event.actor_name.trim();
    if (event.actor_type === "agent") return AGENT_NAMES[agentKey(event.actor_id)] ?? "Agente";
    if (event.actor_type === "hermes") return "Assistente no Slack";
    if (event.actor_type === "system") return "Mike";
    return event.actor_id.includes("@") ? event.actor_id.split("@")[0] : "Alguém";
}

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** The verb and object of one event, in the past tense. */
export function describeEvent(event: CardEventRow): { verb: string; object?: string; sources?: number } {
    const after = record(event.after);
    const sources = typeof after.sources === "number" ? after.sources : undefined;
    switch (event.action) {
        case "lane.changed": {
            const lane = text(event.after);
            return { verb: "moveu para", object: (lane && LANE_LABEL[lane]) ?? lane ?? "fora da esteira" };
        }
        case "assignee.changed": {
            // A plain e-mail from the pipeline, or { name, email } from an agent.
            const who = text(event.after) ?? text(after.name) ?? text(after.email);
            return who ? { verb: "atribuiu a", object: who.split("@")[0] } : { verb: "removeu o responsável" };
        }
        case "assignee.suggested": {
            const who = text(after.name) ?? text(after.email);
            return { verb: "sugeriu como responsável", object: who?.split("@")[0] };
        }
        case "status.changed": {
            const status = text(event.after);
            return { verb: "mudou o progresso para", object: (status && STATUS_LABEL[status]) ?? status ?? "vazio" };
        }
        case "review.started":
            return { verb: "começou a revisar", object: text(after.document) };
        case "review.completed":
            return { verb: "revisou", object: text(after.document), sources };
        case "review.failed":
            return { verb: "não conseguiu revisar", object: text(after.document) };
        case "document.added":
            return { verb: "adicionou", object: text(after.document) };
        case "folder.watched":
            return { verb: "passou a monitorar a pasta", object: text(after.folder) };
        case "request.created":
            return { verb: "criou o pedido", object: text(after.request) ?? text(after.code) };
        case "request.triaged":
            return { verb: "fez a triagem", object: text(after.kind) && KIND_LABEL[text(after.kind)!] };
        case "triage.accepted":
            return { verb: "aceitou a triagem" };
        case "triage.edited":
            return { verb: "ajustou a triagem" };
        case "triage.rejected":
            return { verb: "recusou a triagem" };
        case "request.question":
            return { verb: "perguntou ao solicitante" };
        case "request.answered":
            return { verb: "respondeu" };
        case "request.delivered":
            return { verb: "entregou o pedido" };
        case "participant.invited":
            return { verb: "convidou", object: text(after.label) ?? text(after.email) };
        case "participant.revoked":
            return { verb: "removeu o acesso de", object: text(after.email) };
        case "comment.added":
            return { verb: "comentou" };
        case "review.accepted":
            return { verb: "aceitou a revisão" };
        case "field.updated": {
            const what = fieldLabel(event.field);
            return what ? { verb: "atualizou", object: what } : { verb: "atualizou o contrato" };
        }
        case "review.clause_aceito":
        case "review.clause_editado":
        case "review.clause_rejeitado":
            return clauseDecision(event, after);
        case "agent.started":
            return { verb: "começou a trabalhar neste contrato" };
        case "agent.suggested": {
            // The field it suggested ("risco alto", "Duda como responsável"), else a plain sentence.
            const what = fieldLabel(event.field) ?? text(after.suggestion) ?? text(after.value);
            return what ? { verb: "sugeriu", object: what, sources } : { verb: "fez uma sugestão", sources };
        }
        case "agent.failed":
            return { verb: "não conseguiu terminar o trabalho" };
        case "document.version_added":
            return { verb: "adicionou uma nova versão", object: text(after.document) };
        case "notification.sent":
            return { verb: "avisou", object: text(after.to) };
        case "kb.ask":
            return { verb: "perguntou à base" };
        default:
            // An action this screen does not know yet: say something true, never the raw name.
            return { verb: "registrou uma atualização" };
    }
}

const CLAUSE_VERB = {
    "review.clause_aceito": "aceitou a edição",
    "review.clause_editado": "editou a edição",
    "review.clause_rejeitado": "rejeitou a sugestão",
} as const;

/**
 * A person's decision on one clause of a playbook review. `after.clause` is a
 * clause number ("9", "12.1") or the rule's name ("Cessão do contrato"); a
 * reason, when given, follows after a colon.
 */
function clauseDecision(event: CardEventRow, after: Record<string, unknown>): { verb: string; object?: string } {
    const verb = CLAUSE_VERB[event.action as keyof typeof CLAUSE_VERB];
    const clause = text(after.clause) ?? event.field?.trim() ?? undefined;
    const reason = text(after.reason);
    const suffix = reason ? `: ${reason}` : "";
    if (!clause) return { verb: `${verb}${suffix}` };
    return { verb, object: `${/^\d/.test(clause) ? `da cl. ${clause}` : `em ${clause}`}${suffix}` };
}

// Events from the same actor with the same action on different contracts
// within this window fold into one line ("revisou 4 contratos"). Only actions
// that read naturally with a count fold.
export const FOLD_WINDOW_MS = 10 * 60 * 1000;
const FOLDABLE = new Set(["review.completed", "review.started", "document.added"]);

/** Feed lines, newest first. `hrefFor` links a line to its evidence. */
export function toActivityItems(
    events: CardEventRow[],
    hrefFor?: (event: CardEventRow) => string | undefined,
): ActivityItem[] {
    const sorted = [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const items: ActivityItem[] = [];
    let last: { item: ActivityItem; event: CardEventRow } | null = null;
    for (const event of sorted) {
        if (
            last &&
            FOLDABLE.has(event.action) &&
            last.event.actor_id === event.actor_id &&
            last.event.action === event.action &&
            last.event.project_id !== event.project_id &&
            Date.parse(last.event.at) - Date.parse(event.at) <= FOLD_WINDOW_MS
        ) {
            last.item.count = (last.item.count ?? 1) + 1;
            last.item.object = undefined;
            continue;
        }
        const { verb, object, sources } = describeEvent(event);
        const after = record(event.after);
        const steps = Array.isArray(after.steps) ? after.steps.filter((x): x is string => typeof x === "string") : [];
        const item: ActivityItem = {
            id: String(event.id),
            actorType: event.actor_type,
            actorName: actorLabel(event),
            verb,
            object,
            sources,
            at: event.at,
            href: hrefFor?.(event),
            ...(steps.length ? { steps } : {}),
            ...(text(after.confirmed_by) ? { confirmedBy: text(after.confirmed_by) } : {}),
        };
        items.push(item);
        last = { item, event };
    }
    return items;
}

/** The sentence a line reads as, without the time. */
export function activitySentence(item: ActivityItem): string {
    const verb =
        item.count && item.count > 1
            ? `${item.verb} ${item.count} contratos`
            : item.object
              ? `${item.verb} ${item.object}`
              : item.verb;
    const sources =
        item.sources && item.sources > 0 ? ` com ${item.sources} ${item.sources === 1 ? "fonte" : "fontes"}` : "";
    return `${item.actorName} ${verb}${sources}`;
}

/** "agora", "há 5 min", "há 2 h", "ontem", "há 3 d", or the date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return "";
    const minutes = Math.floor(Math.max(0, now - then) / 60_000);
    if (minutes < 1) return "agora";
    if (minutes < 60) return `há ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `há ${hours} h`;
    const days = Math.floor(hours / 24);
    if (days === 1) return "ontem";
    if (days < 7) return `há ${days} d`;
    return new Date(then).toLocaleDateString("pt-BR", { timeZone: "UTC" });
}
