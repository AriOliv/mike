// The legal team's chat agent, per organization: who it is, when it answers,
// who may ask for what, when a person of the legal team must decide, and what
// it brings up on its own. Pure parsing and the shape the bot reads; the
// reads and writes are in legalAgent.store.ts.
//
// Some lines are fixed and no setting moves them (FIXED_ESCALATIONS): the
// agent never signs, never sends anything outside the company and never
// accepts a risk on the legal team's behalf. It is an assistant, never
// presented as a lawyer: every answer carries DISCLAIMER and a way to ask a
// person of the legal team for review.

export const TONES = ["formal", "cordial", "direto"] as const;
export type Tone = (typeof TONES)[number];

export const REQUEST_KINDS = ["contrato_novo", "revisao", "aditivo", "nda", "parecer", "outro"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const RISK_LEVELS = ["baixo", "medio", "alto", "critico"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const OUTSIDE_HOURS = ["avisa_e_registra", "so_registra"] as const;

/** What always goes to a person, whatever the organization configures. */
export const FIXED_ESCALATIONS = [
    "Assinar ou aprovar a assinatura de qualquer documento",
    "Enviar documento ou resposta para fora da empresa",
    "Aceitar um risco em nome do Legal",
    "A pessoa pede para falar com alguém do Legal",
    "A pessoa diz que a resposta não ajudou",
    "Três trocas sem resolver a mesma dúvida",
    "Não há fonte no Mike para sustentar a resposta",
] as const;

/** Under every answer: the agent is an AI and its answer is not a legal opinion. */
export const DISCLAIMER = "Resposta de IA, não é parecer jurídico. Para revisão do Legal, peça aqui.";

/** Reminders to the person who asked before the request waits on them. */
export const MAX_REMINDERS = 2;

export type Hours = {
    timezone: string;
    /** ISO weekdays, 1 = Monday … 7 = Sunday. */
    days: number[];
    start: string;
    end: string;
    outside: (typeof OUTSIDE_HOURS)[number];
};

export type AreaPermission = { area: string; kinds: RequestKind[] };

export type Escalation = {
    risk_levels: RiskLevel[];
    kinds: RequestKind[];
    /** Hand over when the agent is not sure of the answer. */
    low_confidence: boolean;
    /** Who is told; empty sends it to the legal team's queue. */
    escalate_to_email: string;
};

export type Proactive = {
    /** Days before a notice deadline it warns the contract's owner (D-30, D-15, D-7). */
    deadline_days: number[];
    renewals: boolean;
    radar: boolean;
    /** When the daily digest goes out; empty means no digest. */
    digest_time: string;
};

export type AgentSettings = {
    enabled: boolean;
    display_name: string;
    persona: string;
    tone: Tone;
    hours: Hours;
    permissions: AreaPermission[];
    escalation: Escalation;
    proactive: Proactive;
    updated_at: string | null;
};

export const DEFAULT_PERSONA =
    "Sou o assistente do Legal no chat, uma IA. Recebo os pedidos das áreas, pergunto só o que falta, " +
    "reviso com o playbook do time e devolvo com o próximo passo. Aviso prazos, renovações e " +
    "mudanças regulatórias antes de alguém pedir. Quando a decisão é do Legal, passo para uma " +
    "pessoa do time e digo quem vai cuidar.";

export const DEFAULT_SETTINGS: AgentSettings = {
    enabled: false,
    display_name: "Assistente do Legal",
    persona: DEFAULT_PERSONA,
    tone: "cordial",
    hours: { timezone: "America/Sao_Paulo", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00", outside: "avisa_e_registra" },
    permissions: [],
    escalation: { risk_levels: ["alto", "critico"], kinds: ["parecer"], low_confidence: true, escalate_to_email: "" },
    proactive: { deadline_days: [30, 15, 7], renewals: true, radar: true, digest_time: "08:00" },
    updated_at: null,
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PERSONA = 2000;
const MAX_NAME = 60;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; detail: string };

const fail = (detail: string): { ok: false; detail: string } => ({ ok: false, detail });

function isObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function pick<T extends string>(allowed: readonly T[], value: unknown): T[] | null {
    if (!Array.isArray(value)) return null;
    const out: T[] = [];
    for (const item of value) {
        if (!allowed.includes(item as T)) return null;
        if (!out.includes(item as T)) out.push(item as T);
    }
    return out;
}

function validTimezone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/**
 * A full settings object from what the page sends. Every field is required
 * except `updated_at`: the page always sends the whole form, so a missing
 * field is a bug, not "leave as is". Errors are sentences for the person.
 */
export function parseSettings(input: unknown): ParseResult<Omit<AgentSettings, "updated_at">> {
    if (!isObject(input)) return fail("Envie as configurações do agente.");
    const { enabled, display_name, persona, tone, hours, permissions, escalation, proactive } = input;

    if (typeof enabled !== "boolean") return fail("Diga se o agente está ligado ou desligado.");
    if (typeof display_name !== "string" || !display_name.trim()) return fail("Dê um nome ao agente.");
    if (display_name.trim().length > MAX_NAME) return fail(`O nome do agente pode ter até ${MAX_NAME} caracteres.`);
    if (typeof persona !== "string") return fail("Descreva como o agente se apresenta.");
    if (persona.length > MAX_PERSONA) return fail(`A descrição do agente pode ter até ${MAX_PERSONA} caracteres.`);
    if (!TONES.includes(tone as Tone)) return fail("Escolha o tom: formal, cordial ou direto.");

    if (!isObject(hours)) return fail("Informe o horário de atendimento.");
    const days = Array.isArray(hours.days) ? [...new Set(hours.days)] : null;
    if (!days || days.length === 0 || !days.every((d) => Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 7))
        return fail("Escolha pelo menos um dia de atendimento.");
    if (typeof hours.start !== "string" || !HHMM.test(hours.start) || typeof hours.end !== "string" || !HHMM.test(hours.end))
        return fail("Use o formato HH:MM no horário de atendimento.");
    if (hours.start >= hours.end) return fail("O horário de início tem de ser antes do fim.");
    if (typeof hours.timezone !== "string" || !validTimezone(hours.timezone)) return fail("Fuso horário desconhecido.");
    if (!OUTSIDE_HOURS.includes(hours.outside as Hours["outside"]))
        return fail("Diga o que o agente faz fora do horário.");

    if (!Array.isArray(permissions)) return fail("Informe quem pode pedir o quê.");
    const seenAreas = new Set<string>();
    const parsedPermissions: AreaPermission[] = [];
    for (const rule of permissions) {
        if (!isObject(rule) || typeof rule.area !== "string" || !rule.area.trim())
            return fail("Cada regra de permissão precisa de uma área.");
        const area = rule.area.trim();
        if (seenAreas.has(area.toLowerCase())) return fail(`A área ${area} aparece duas vezes.`);
        seenAreas.add(area.toLowerCase());
        const kinds = pick(REQUEST_KINDS, rule.kinds);
        if (!kinds) return fail(`Tipo de pedido desconhecido na área ${area}.`);
        parsedPermissions.push({ area, kinds });
    }

    if (!isObject(escalation)) return fail("Informe quando o agente passa para uma pessoa.");
    const riskLevels = pick(RISK_LEVELS, escalation.risk_levels);
    if (!riskLevels) return fail("Nível de risco desconhecido na regra de escalada.");
    const escalationKinds = pick(REQUEST_KINDS, escalation.kinds);
    if (!escalationKinds) return fail("Tipo de pedido desconhecido na regra de escalada.");
    if (typeof escalation.low_confidence !== "boolean") return fail("Diga se o agente escala quando não tem certeza.");
    const escalateTo = typeof escalation.escalate_to_email === "string" ? escalation.escalate_to_email.trim().toLowerCase() : null;
    if (escalateTo === null || (escalateTo && !EMAIL.test(escalateTo)))
        return fail("O e-mail de quem recebe as escaladas não é válido.");

    if (!isObject(proactive)) return fail("Informe os avisos que o agente dá sozinho.");
    const deadlineDays = Array.isArray(proactive.deadline_days) ? [...new Set(proactive.deadline_days)] : null;
    if (!deadlineDays || !deadlineDays.every((d) => Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 180))
        return fail("Os avisos de prazo vão de 1 a 180 dias antes.");
    if (typeof proactive.renewals !== "boolean" || typeof proactive.radar !== "boolean")
        return fail("Diga se o agente avisa renovações e mudanças regulatórias.");
    if (typeof proactive.digest_time !== "string" || (proactive.digest_time !== "" && !HHMM.test(proactive.digest_time)))
        return fail("Use o formato HH:MM no horário do resumo diário.");

    return {
        ok: true,
        value: {
            enabled,
            display_name: display_name.trim(),
            persona: persona.trim(),
            tone: tone as Tone,
            hours: {
                timezone: hours.timezone,
                days: (days as number[]).sort((a, b) => a - b),
                start: hours.start,
                end: hours.end,
                outside: hours.outside as Hours["outside"],
            },
            permissions: parsedPermissions,
            escalation: { risk_levels: riskLevels, kinds: escalationKinds, low_confidence: escalation.low_confidence, escalate_to_email: escalateTo },
            proactive: {
                deadline_days: (deadlineDays as number[]).sort((a, b) => b - a),
                renewals: proactive.renewals,
                radar: proactive.radar,
                digest_time: proactive.digest_time,
            },
        },
    };
}

/** A stored row, defaults filled in for anything a newer field added. */
export function settingsFromRow(row: Record<string, unknown> | null): AgentSettings {
    if (!row) return DEFAULT_SETTINGS;
    const merge = <T extends object>(base: T, value: unknown): T => (isObject(value) ? { ...base, ...value } : base);
    return {
        enabled: row.enabled === true,
        display_name: typeof row.display_name === "string" && row.display_name ? row.display_name : DEFAULT_SETTINGS.display_name,
        persona: typeof row.persona === "string" && row.persona ? row.persona : DEFAULT_PERSONA,
        tone: TONES.includes(row.tone as Tone) ? (row.tone as Tone) : DEFAULT_SETTINGS.tone,
        hours: merge(DEFAULT_SETTINGS.hours, row.hours),
        permissions: Array.isArray(row.permissions) ? (row.permissions as AreaPermission[]) : [],
        escalation: merge(DEFAULT_SETTINGS.escalation, row.escalation),
        proactive: merge(DEFAULT_SETTINGS.proactive, row.proactive),
        updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
    };
}

const WEEKDAYS = ["", "seg", "ter", "qua", "qui", "sex", "sáb", "dom"];

/**
 * What the bot reads through the MCP (`mike_agente_config`): the persona, the
 * hours, who may ask for what and the escalation rules, in the shape agreed
 * with the MCP server. No secret, no member list.
 */
export function agentConfigForBot(settings: AgentSettings, channel: { kind: string; name: string } | null = null) {
    return {
        ativo: settings.enabled,
        nome: settings.display_name,
        persona: settings.persona,
        tom: settings.tone,
        horario: {
            tz: settings.hours.timezone,
            dias: settings.hours.days.map((d) => WEEKDAYS[d]),
            inicio: settings.hours.start,
            fim: settings.hours.end,
            fora_do_horario: settings.hours.outside,
        },
        permissoes_por_area: settings.permissions.map((p) => ({ area: p.area, pode_pedir: p.kinds })),
        escalada: [
            ...FIXED_ESCALATIONS.map((regra) => ({ regra, fixa: true })),
            ...settings.escalation.risk_levels.map((nivel) => ({ regra: `Risco ${nivel}`, fixa: false })),
            ...settings.escalation.kinds.map((kind) => ({ regra: `Pedido do tipo ${kind}`, fixa: false })),
            ...(settings.escalation.low_confidence ? [{ regra: "Quando não tiver certeza da resposta", fixa: false }] : []),
        ],
        escalar_para: settings.escalation.escalate_to_email || null,
        aviso: DISCLAIMER,
        proativo: {
            max_lembretes: MAX_REMINDERS,
            avisos_de_prazo_dias: settings.proactive.deadline_days,
            renovacoes: settings.proactive.renewals,
            radar: settings.proactive.radar,
            resumo_diario: settings.proactive.digest_time || null,
        },
        canal_atual: channel,
    };
}

/** Whether someone in `area` may ask for `kind`. No rules means anyone may ask anything. */
export function mayAsk(settings: AgentSettings, area: string | null, kind: RequestKind): boolean {
    if (settings.permissions.length === 0) return true;
    const rule = settings.permissions.find((p) => p.area.toLowerCase() === (area ?? "").toLowerCase());
    return !!rule && rule.kinds.includes(kind);
}

/** Whether `now` falls in the agent's hours, in its own time zone. */
export function withinHours(hours: Hours, now: Date): boolean {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: hours.timezone,
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday")) + 1;
    const time = `${get("hour")}:${get("minute")}`;
    return hours.days.includes(day) && time >= hours.start && time < hours.end;
}
