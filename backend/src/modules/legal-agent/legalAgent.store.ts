// Reads and writes of the legal team's chat agent, per organization. Every
// member may read the settings (they are what the bot tells them it does);
// only owners and admins change them or set up a channel. Each change goes to
// the organization's audit log.

import { recordAudit } from "../../lib/audit";
import { getOrgRole, isOrgAdmin, type OrgRole } from "../../lib/access";
import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import {
    agentConfigForBot,
    DISCLAIMER,
    FIXED_ESCALATIONS,
    parseSettings,
    REQUEST_KINDS,
    RISK_LEVELS,
    settingsFromRow,
    TONES,
    type AgentSettings,
} from "./legalAgent.settings";
import {
    CHANNEL_KINDS,
    channelSetup,
    parseChannelConfig,
    type ChannelKind,
    type ChannelSetup,
} from "./legalAgent.setup";

export type Caller = { userId: string; userEmail?: string | null };

export type AgentChannel = {
    id: string;
    kind: ChannelKind;
    status: "rascunho" | "configurado" | "pausado";
    name: string;
    /** The workspace id (Slack team id, WhatsApp number id, Telegram bot id): links count only here. */
    platform_team_id: string | null;
    config: Record<string, unknown>;
    created_at: string;
    updated_at: string;
};

export type LegalAgentView = {
    settings: AgentSettings;
    channels: AgentChannel[];
    can_manage: boolean;
    /** What the page offers in its pickers and shows as fixed. */
    options: {
        tones: readonly string[];
        kinds: readonly string[];
        risk_levels: readonly string[];
        fixed_escalations: readonly string[];
        disclaimer: string;
    };
};

const CHANNEL_COLUMNS = "id, kind, status, name, platform_team_id, config, created_at, updated_at";
const NOT_FOUND = failure("not_found", "Organização não encontrada.");
const ONLY_ADMINS = failure("forbidden", "Só quem administra a organização pode mudar o agente do Legal.");

/** Where the bot reaches Mike's MCP server (/mcp at the backend root); shown in the generated files. */
export function mcpUrl(): string {
    const base = (process.env.APP_BASE_URL?.trim() || process.env.FRONTEND_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");
    return `${base}/mcp`;
}

async function roleIn(db: Db, caller: Caller, orgId: string): Promise<OrgRole | null> {
    return getOrgRole(caller.userId, orgId, db);
}

async function readSettings(db: Db, orgId: string): Promise<AgentSettings> {
    const { data, error } = await db.from("legal_agent_settings").select("*").eq("org_id", orgId).maybeSingle();
    if (error) throw error;
    return settingsFromRow(data as Record<string, unknown> | null);
}

async function readChannels(db: Db, orgId: string): Promise<AgentChannel[]> {
    const { data, error } = await db
        .from("legal_agent_channels")
        .select(CHANNEL_COLUMNS)
        .eq("org_id", orgId)
        .order("created_at", { ascending: true });
    if (error) throw error;
    return (data ?? []) as AgentChannel[];
}

export async function getLegalAgent(db: Db, caller: Caller, orgId: string): Promise<ServiceResult<LegalAgentView>> {
    try {
        const role = await roleIn(db, caller, orgId);
        if (!role) return NOT_FOUND;
        const [settings, channels] = [await readSettings(db, orgId), await readChannels(db, orgId)];
        return ok({
            settings,
            channels,
            can_manage: isOrgAdmin(role),
            options: {
                tones: TONES,
                kinds: REQUEST_KINDS,
                risk_levels: RISK_LEVELS,
                fixed_escalations: FIXED_ESCALATIONS,
                disclaimer: DISCLAIMER,
            },
        });
    } catch (error) {
        return internalFailure(error);
    }
}

export async function saveLegalAgentSettings(
    db: Db,
    caller: Caller,
    orgId: string,
    input: unknown,
): Promise<ServiceResult<AgentSettings>> {
    try {
        const role = await roleIn(db, caller, orgId);
        if (!role) return NOT_FOUND;
        if (!isOrgAdmin(role)) return ONLY_ADMINS;
        const parsed = parseSettings(input);
        if (!parsed.ok) return failure("validation", parsed.detail);
        const now = new Date().toISOString();
        const { data, error } = await db
            .from("legal_agent_settings")
            .upsert({ org_id: orgId, ...parsed.value, updated_by: caller.userId, updated_at: now }, { onConflict: "org_id" })
            .select("*")
            .single();
        if (error) throw error;
        await recordAudit(db, {
            userId: caller.userId,
            orgId,
            userEmail: caller.userEmail ?? null,
            action: "legal_agent.settings_updated",
            title: "Agente do Legal",
            surface: "settings",
            detail: { enabled: parsed.value.enabled, tone: parsed.value.tone },
        });
        return ok(settingsFromRow(data as Record<string, unknown>));
    } catch (error) {
        return internalFailure(error);
    }
}

function parseKind(value: unknown): ChannelKind | null {
    return CHANNEL_KINDS.includes(value as ChannelKind) ? (value as ChannelKind) : null;
}

/**
 * Saves a channel's non-secret details and returns the installation
 * assistant's output for it. Nothing is connected: the channel starts as a
 * draft and only someone of the team marks it installed.
 */
export async function saveLegalAgentChannel(
    db: Db,
    caller: Caller,
    orgId: string,
    input: { id?: unknown; kind?: unknown; name?: unknown; config?: unknown; platform_team_id?: unknown },
): Promise<ServiceResult<{ channel: AgentChannel; setup: ChannelSetup }>> {
    try {
        const role = await roleIn(db, caller, orgId);
        if (!role) return NOT_FOUND;
        if (!isOrgAdmin(role)) return ONLY_ADMINS;
        const kind = parseKind(input.kind);
        if (!kind) return failure("validation", "Escolha o canal: Slack, WhatsApp ou Telegram.");
        const name = typeof input.name === "string" ? input.name.trim() : "";
        if (!name || name.length > 80) return failure("validation", "Dê um nome ao canal, com até 80 caracteres.");
        const config = parseChannelConfig(kind, input.config);
        if (!config.ok) return failure("validation", config.detail);
        const teamRaw = typeof input.platform_team_id === "string" ? input.platform_team_id.trim() : "";
        if (teamRaw && !/^[A-Za-z0-9_.-]{1,64}$/.test(teamRaw))
            return failure("validation", "O ID do workspace usa só letras, números, ponto, hífen e sublinhado.");

        const now = new Date().toISOString();
        const row = { org_id: orgId, kind, name, platform_team_id: teamRaw || null, config: config.value, updated_at: now };
        const query =
            typeof input.id === "string"
                ? db.from("legal_agent_channels").update(row).eq("id", input.id).eq("org_id", orgId)
                : db.from("legal_agent_channels").insert({ ...row, created_by: caller.userId, status: "rascunho" });
        const { data, error } = await query.select(CHANNEL_COLUMNS).maybeSingle();
        if (error) {
            if ((error as { code?: string }).code === "23505")
                return failure("conflict", "Este workspace já está ligado a outro canal desta organização.");
            throw error;
        }
        if (!data) return failure("not_found", "Canal não encontrado.");
        const settings = await readSettings(db, orgId);
        await recordAudit(db, {
            userId: caller.userId,
            orgId,
            userEmail: caller.userEmail ?? null,
            action: "legal_agent.channel_saved",
            title: name,
            surface: "settings",
            detail: { kind },
        });
        return ok({
            channel: data as AgentChannel,
            setup: channelSetup(kind, config.value, settings, mcpUrl()),
        });
    } catch (error) {
        return internalFailure(error);
    }
}

/** The installation assistant's output for a saved channel. Admins only: it names where secrets go. */
export async function getLegalAgentChannelSetup(
    db: Db,
    caller: Caller,
    orgId: string,
    channelId: string,
): Promise<ServiceResult<ChannelSetup>> {
    try {
        const role = await roleIn(db, caller, orgId);
        if (!role) return NOT_FOUND;
        if (!isOrgAdmin(role)) return ONLY_ADMINS;
        const { data, error } = await db
            .from("legal_agent_channels")
            .select(CHANNEL_COLUMNS)
            .eq("id", channelId)
            .eq("org_id", orgId)
            .maybeSingle();
        if (error) throw error;
        if (!data) return failure("not_found", "Canal não encontrado.");
        const channel = data as AgentChannel;
        const config = parseChannelConfig(channel.kind, channel.config);
        if (!config.ok) return failure("conflict", "Os dados deste canal estão incompletos. Edite e salve de novo.");
        return ok(channelSetup(channel.kind, config.value, await readSettings(db, orgId), mcpUrl()));
    } catch (error) {
        return internalFailure(error);
    }
}

export async function setLegalAgentChannelStatus(
    db: Db,
    caller: Caller,
    orgId: string,
    channelId: string,
    status: unknown,
): Promise<ServiceResult<AgentChannel>> {
    try {
        const role = await roleIn(db, caller, orgId);
        if (!role) return NOT_FOUND;
        if (!isOrgAdmin(role)) return ONLY_ADMINS;
        if (status !== "rascunho" && status !== "configurado" && status !== "pausado")
            return failure("validation", "Situação do canal desconhecida.");
        const { data, error } = await db
            .from("legal_agent_channels")
            .update({ status, updated_at: new Date().toISOString() })
            .eq("id", channelId)
            .eq("org_id", orgId)
            .select(CHANNEL_COLUMNS)
            .maybeSingle();
        if (error) throw error;
        if (!data) return failure("not_found", "Canal não encontrado.");
        await recordAudit(db, {
            userId: caller.userId,
            orgId,
            userEmail: caller.userEmail ?? null,
            action: "legal_agent.channel_status",
            title: (data as AgentChannel).name,
            surface: "settings",
            detail: { status },
        });
        return ok(data as AgentChannel);
    } catch (error) {
        return internalFailure(error);
    }
}

export async function deleteLegalAgentChannel(
    db: Db,
    caller: Caller,
    orgId: string,
    channelId: string,
): Promise<ServiceResult<{ deleted: true }>> {
    try {
        const role = await roleIn(db, caller, orgId);
        if (!role) return NOT_FOUND;
        if (!isOrgAdmin(role)) return ONLY_ADMINS;
        const { data, error } = await db
            .from("legal_agent_channels")
            .delete()
            .eq("id", channelId)
            .eq("org_id", orgId)
            .select("id, name")
            .maybeSingle();
        if (error) throw error;
        if (!data) return failure("not_found", "Canal não encontrado.");
        await recordAudit(db, {
            userId: caller.userId,
            orgId,
            userEmail: caller.userEmail ?? null,
            action: "legal_agent.channel_deleted",
            title: (data as { name: string }).name,
            surface: "settings",
        });
        return ok({ deleted: true });
    } catch (error) {
        return internalFailure(error);
    }
}

/**
 * What the chat bot reads about itself (the MCP tool `mike_agente_config`):
 * the organization's settings in the agreed shape, and the channel it is
 * speaking on when it says which. The MCP server decides who may call it.
 */
export async function getAgentConfigForBot(
    db: Db,
    orgId: string,
    channelKind: string | null = null,
): Promise<ServiceResult<ReturnType<typeof agentConfigForBot>>> {
    try {
        const settings = await readSettings(db, orgId);
        const kind = parseKind(channelKind);
        let channel: { kind: string; name: string } | null = null;
        if (kind) {
            const { data, error } = await db
                .from("legal_agent_channels")
                .select("kind, name")
                .eq("org_id", orgId)
                .eq("kind", kind)
                .eq("status", "configurado")
                .limit(1);
            if (error) throw error;
            channel = ((data ?? []) as { kind: string; name: string }[])[0] ?? null;
        }
        return ok(agentConfigForBot(settings, channel));
    } catch (error) {
        return internalFailure(error);
    }
}
