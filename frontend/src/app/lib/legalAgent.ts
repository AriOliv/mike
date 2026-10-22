// Labels and form helpers for the "Agente do Legal" settings page. The
// server validates everything again; these only keep the form honest.

import type { LegalAgentChannel, LegalAgentChannelKind, LegalAgentSettings, LegalAgentTone } from "./mikeApi";

export const TONE_LABEL: Record<LegalAgentTone, { label: string; hint: string }> = {
    formal: { label: "Formal", hint: "Trata por senhor/senhora, sem gírias." },
    cordial: { label: "Cordial", hint: "Próximo e educado, como um colega do Legal." },
    direto: { label: "Direto", hint: "Frases curtas, vai ao ponto." },
};

export const KIND_LABEL: Record<string, string> = {
    contrato_novo: "Contrato novo",
    revisao: "Revisão",
    aditivo: "Aditivo",
    nda: "NDA",
    parecer: "Parecer",
    outro: "Outro",
};

export const RISK_LABEL: Record<string, string> = { baixo: "Baixo", medio: "Médio", alto: "Alto", critico: "Crítico" };

export const WEEKDAYS: { day: number; short: string }[] = [
    { day: 1, short: "Seg" },
    { day: 2, short: "Ter" },
    { day: 3, short: "Qua" },
    { day: 4, short: "Qui" },
    { day: 5, short: "Sex" },
    { day: 6, short: "Sáb" },
    { day: 7, short: "Dom" },
];

export const CHANNEL_LABEL: Record<LegalAgentChannelKind, { label: string; hint: string }> = {
    slack: { label: "Slack", hint: "App do Slack em Socket Mode: menções e mensagens diretas." },
    whatsapp: { label: "WhatsApp", hint: "API oficial da Meta. Precisa de um endereço público." },
    telegram: { label: "Telegram", hint: "Bot do BotFather. Só para demonstração e piloto." },
};

export const CHANNEL_STATUS_LABEL: Record<LegalAgentChannel["status"], { label: string; status: "a_fazer" | "concluido" | "bloqueado" }> = {
    rascunho: { label: "Rascunho", status: "a_fazer" },
    configurado: { label: "Instalado", status: "concluido" },
    pausado: { label: "Pausado", status: "bloqueado" },
};

/** "Seg a sex, 09:00 às 18:00" — the hours in one line. */
export function hoursSummary(hours: LegalAgentSettings["hours"]): string {
    const days = [...hours.days].sort((a, b) => a - b);
    const name = (d: number) => WEEKDAYS[d - 1].short.toLowerCase();
    const contiguous = days.length > 2 && days.every((d, i) => i === 0 || d === days[i - 1] + 1);
    const which =
        days.length === 0
            ? "Nenhum dia"
            : contiguous
              ? `${name(days[0])} a ${name(days[days.length - 1])}`
              : days.map(name).join(", ");
    return `${which[0].toUpperCase()}${which.slice(1)}, ${hours.start} às ${hours.end}`;
}

export function toggle<T>(list: readonly T[], item: T): T[] {
    return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/** "30, 15, 7" ⇄ [30, 15, 7]: what a person types for the deadline warnings. */
export function parseDays(text: string): number[] | null {
    const parts = text.split(/[\s,;]+/).filter(Boolean);
    const days = parts.map(Number);
    if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 180)) return null;
    return [...new Set(days)].sort((a, b) => b - a);
}

/** The settings without the server's stamp, ready to send. */
export function toPayload(settings: LegalAgentSettings): Omit<LegalAgentSettings, "updated_at"> {
    const { updated_at: _updated, ...rest } = settings;
    void _updated;
    return rest;
}

/** The fields the channel form asks for, per kind, from what is stored. */
export function channelDraft(kind: LegalAgentChannelKind, config: Record<string, unknown> = {}): Record<string, string> {
    const text = (v: unknown) => (typeof v === "string" ? v : "");
    if (kind === "slack")
        return {
            workspace: text(config.workspace),
            channels: Array.isArray(config.channels) ? config.channels.join(", ") : "",
            bot_name: text(config.bot_name) || "advogado-mike",
        };
    if (kind === "telegram") return { bot_username: text(config.bot_username), mode: text(config.mode) || "polling" };
    return { phone_last4: text(config.phone_last4), business_name: text(config.business_name) };
}

/** The form back into the config the server stores. */
export function channelConfig(kind: LegalAgentChannelKind, draft: Record<string, string>): Record<string, unknown> {
    if (kind === "slack")
        return {
            workspace: draft.workspace ?? "",
            channels: (draft.channels ?? "").split(/[\s,]+/).filter(Boolean),
            bot_name: draft.bot_name ?? "",
        };
    if (kind === "telegram") return { bot_username: draft.bot_username ?? "", mode: draft.mode ?? "polling" };
    return { phone_last4: draft.phone_last4 ?? "", business_name: draft.business_name ?? "" };
}
