// Who is talking on a chat channel (doc 10 §6.2). The chat bot names a person
// only by <platform>:<team>:<user>; Mike acts as someone only through a link
// that person confirmed once, logged in. The MCP module calls
// resolveChatIdentity on every agent call and createLinkChallenge to build
// the 403 that asks for a link; the person confirms on /vincular-chat.
//
// Every check that makes a link count lives here: confirmed, not revoked, not
// expired, and on a workspace the organization registered on one of its
// agent channels. Org membership is re-checked by the MCP module per call.

import { createHash, randomBytes } from "node:crypto";
import { recordAudit } from "../../lib/audit";
import { getOrgRole } from "../../lib/access";
import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { CHANNEL_KINDS, type ChannelKind } from "./legalAgent.setup";
import type { Caller } from "./legalAgent.store";

export const LINK_DAYS = 180;
export const CHALLENGE_MINUTES = 15;
const ID = /^[A-Za-z0-9_.-]{1,64}$/;

export type ChatIdentity = { orgId: string; platform: ChannelKind; teamId: string; userId: string };

export type ChatLink = {
    id: string;
    platform: ChannelKind;
    platform_team_id: string;
    platform_user_id: string;
    confirmed_at: string;
    expires_at: string;
    revoked_at: string | null;
};

const LINK_COLUMNS = "id, platform, platform_team_id, platform_user_id, confirmed_at, expires_at, revoked_at";

/** The chat identity is well-formed: a known platform and plain ids that cannot split a header. */
export function validIdentity(platform: unknown, teamId: unknown, userId: unknown): platform is ChannelKind {
    return (
        CHANNEL_KINDS.includes(platform as ChannelKind) &&
        typeof teamId === "string" &&
        ID.test(teamId) &&
        typeof userId === "string" &&
        ID.test(userId)
    );
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

function appBase(): string {
    return (process.env.APP_BASE_URL?.trim() || process.env.FRONTEND_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");
}

/** Whether the organization registered this workspace on one of its agent channels. */
async function teamRegistered(db: Db, orgId: string, platform: ChannelKind, teamId: string): Promise<boolean> {
    const { data, error } = await db
        .from("legal_agent_channels")
        .select("id")
        .eq("org_id", orgId)
        .eq("kind", platform)
        .eq("platform_team_id", teamId)
        .limit(1);
    if (error) throw error;
    return ((data ?? []) as unknown[]).length > 0;
}

/**
 * The Mike person behind a chat identity, or null. Null for anything that
 * does not hold up: a malformed identity, an unregistered workspace, no
 * confirmed link, or one revoked or expired. Throws on a read failure, so
 * the MCP server answers an error rather than "not linked".
 */
export async function resolveChatIdentity(
    db: Db,
    orgId: string,
    platform: string,
    teamId: string,
    userId: string,
    now: Date = new Date(),
): Promise<{ userId: string; linkId: string } | null> {
    if (!validIdentity(platform, teamId, userId)) return null;
    if (!(await teamRegistered(db, orgId, platform, teamId))) return null;
    const { data, error } = await db
        .from("chat_identity_links")
        .select("id, user_id")
        .eq("org_id", orgId)
        .eq("platform", platform)
        .eq("platform_team_id", teamId)
        .eq("platform_user_id", userId)
        .is("revoked_at", null)
        .gte("expires_at", now.toISOString())
        .maybeSingle();
    if (error) throw error;
    const row = data as { id: string; user_id: string } | null;
    return row ? { userId: row.user_id, linkId: row.id } : null;
}

/**
 * A one-time link for the person to confirm who they are on Mike. Bound to
 * the chat identity; only its SHA-256 is kept. Refuses an unregistered
 * workspace, so a stranger's Slack cannot even start a link here.
 */
export async function createLinkChallenge(
    db: Db,
    input: { orgId: string; tokenId: string | null; platform: string; teamId: string; userId: string },
    now: Date = new Date(),
): Promise<ServiceResult<{ url: string; expires_at: string }>> {
    try {
        if (!validIdentity(input.platform, input.teamId, input.userId))
            return failure("validation", "Identidade de chat inválida.");
        if (!(await teamRegistered(db, input.orgId, input.platform, input.teamId)))
            return failure("forbidden", "Este workspace não está ligado ao assistente do Legal desta organização.");
        const token = randomBytes(24).toString("base64url");
        const expiresAt = new Date(now.getTime() + CHALLENGE_MINUTES * 60_000).toISOString();
        const { error } = await db.from("chat_link_challenges").insert({
            token_hash: hash(token),
            org_id: input.orgId,
            platform: input.platform,
            platform_team_id: input.teamId,
            platform_user_id: input.userId,
            created_via_token_id: input.tokenId,
            expires_at: expiresAt,
        });
        if (error) throw error;
        return ok({ url: `${appBase()}/vincular-chat?t=${token}`, expires_at: expiresAt });
    } catch (error) {
        return internalFailure(error);
    }
}

type Challenge = {
    id: string;
    org_id: string;
    platform: ChannelKind;
    platform_team_id: string;
    platform_user_id: string;
    created_via_token_id: string | null;
    expires_at: string;
    used_at: string | null;
};

async function readChallenge(db: Db, token: unknown, now: Date): Promise<Challenge | null> {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    const { data, error } = await db
        .from("chat_link_challenges")
        .select("id, org_id, platform, platform_team_id, platform_user_id, created_via_token_id, expires_at, used_at")
        .eq("token_hash", hash(token))
        .maybeSingle();
    if (error) throw error;
    const row = data as Challenge | null;
    if (!row || row.used_at || Date.parse(row.expires_at) < now.getTime()) return null;
    return row;
}

const EXPIRED = failure("not_found", "Este link expirou ou já foi usado. Peça um novo ao assistente no chat.");
const NOT_MEMBER = failure("forbidden", "Sua conta não faz parte da organização deste assistente.");

/** What the confirm page shows before the person says "sou eu". */
export async function previewChatLink(
    db: Db,
    caller: Caller,
    token: unknown,
    now: Date = new Date(),
): Promise<ServiceResult<{ platform: ChannelKind; org_name: string; email: string | null }>> {
    try {
        const challenge = await readChallenge(db, token, now);
        if (!challenge) return EXPIRED;
        if (!(await getOrgRole(caller.userId, challenge.org_id, db))) return NOT_MEMBER;
        const { data, error } = await db.from("organizations").select("name").eq("id", challenge.org_id).maybeSingle();
        if (error) throw error;
        return ok({
            platform: challenge.platform,
            org_name: (data as { name?: string } | null)?.name ?? "sua organização",
            email: caller.userEmail ?? null,
        });
    } catch (error) {
        return internalFailure(error);
    }
}

/**
 * The person, logged in, confirms the chat account is theirs. The link is
 * made for the caller of this request (never anyone named in the challenge),
 * replaces any earlier link of that chat identity in the org, and burns the
 * challenge.
 */
export async function confirmChatLink(
    db: Db,
    caller: Caller,
    token: unknown,
    now: Date = new Date(),
): Promise<ServiceResult<{ link: ChatLink }>> {
    try {
        const challenge = await readChallenge(db, token, now);
        if (!challenge) return EXPIRED;
        if (!(await getOrgRole(caller.userId, challenge.org_id, db))) return NOT_MEMBER;

        // Burn first: a second confirm with the same link finds it used.
        const { data: burned, error: burnError } = await db
            .from("chat_link_challenges")
            .update({ used_at: now.toISOString() })
            .eq("id", challenge.id)
            .is("used_at", null)
            .select("id")
            .maybeSingle();
        if (burnError) throw burnError;
        if (!burned) return EXPIRED;

        const nowIso = now.toISOString();
        const { error: revokeError } = await db
            .from("chat_identity_links")
            .update({ revoked_at: nowIso })
            .eq("org_id", challenge.org_id)
            .eq("platform", challenge.platform)
            .eq("platform_team_id", challenge.platform_team_id)
            .eq("platform_user_id", challenge.platform_user_id)
            .is("revoked_at", null);
        if (revokeError) throw revokeError;

        const { data, error } = await db
            .from("chat_identity_links")
            .insert({
                org_id: challenge.org_id,
                platform: challenge.platform,
                platform_team_id: challenge.platform_team_id,
                platform_user_id: challenge.platform_user_id,
                user_id: caller.userId,
                confirmed_at: nowIso,
                expires_at: new Date(now.getTime() + LINK_DAYS * 86_400_000).toISOString(),
                created_via_token_id: challenge.created_via_token_id,
            })
            .select(LINK_COLUMNS)
            .single();
        if (error) throw error;
        await recordAudit(db, {
            userId: caller.userId,
            orgId: challenge.org_id,
            userEmail: caller.userEmail ?? null,
            action: "legal_agent.chat_linked",
            title: challenge.platform,
            surface: "settings",
            detail: { platform: challenge.platform },
        });
        return ok({ link: data as ChatLink });
    } catch (error) {
        return internalFailure(error);
    }
}

/** The caller's own live links in an organization. */
export async function listMyChatLinks(db: Db, caller: Caller, orgId: string): Promise<ServiceResult<ChatLink[]>> {
    try {
        const { data, error } = await db
            .from("chat_identity_links")
            .select(LINK_COLUMNS)
            .eq("org_id", orgId)
            .eq("user_id", caller.userId)
            .is("revoked_at", null)
            .order("confirmed_at", { ascending: false });
        if (error) throw error;
        return ok((data ?? []) as ChatLink[]);
    } catch (error) {
        return internalFailure(error);
    }
}

/** The caller revokes one of their own links. */
export async function revokeMyChatLink(
    db: Db,
    caller: Caller,
    orgId: string,
    linkId: string,
): Promise<ServiceResult<{ revoked: true }>> {
    try {
        const { data, error } = await db
            .from("chat_identity_links")
            .update({ revoked_at: new Date().toISOString() })
            .eq("id", linkId)
            .eq("org_id", orgId)
            .eq("user_id", caller.userId)
            .is("revoked_at", null)
            .select("id")
            .maybeSingle();
        if (error) throw error;
        if (!data) return failure("not_found", "Vínculo não encontrado.");
        await recordAudit(db, {
            userId: caller.userId,
            orgId,
            userEmail: caller.userEmail ?? null,
            action: "legal_agent.chat_unlinked",
            surface: "settings",
        });
        return ok({ revoked: true });
    } catch (error) {
        return internalFailure(error);
    }
}
