// Two-step confirmation of writes (doc 09 §6). A write tool's first call
// changes nothing: the tool's preview says what would happen and the server
// hands back a single-use confirm_token. Only the same call, with the same
// arguments, plus that token runs the write. The token is bound to the
// person, the access token, the chat identity link, the tool and the exact
// arguments, so a model cannot swap the target between proposal and ok.

import crypto from "crypto";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import type { McpContext } from "./mcp.types";

/** How long a proposal can be confirmed. */
export const CONFIRM_MINUTES = 10;
const PREFIX = "mike_cfm_";

const sha256 = (text: string) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/** JSON with keys sorted at every level, so equal arguments hash equally. */
export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    return JSON.stringify(value ?? null);
}

export function argumentsHash(args: Record<string, unknown>): string {
    return sha256(canonicalJson(args));
}

export type Proposal = { confirm_token: string; expira_em: string };

/** Records a proposal and returns the token the agent must send back. */
export async function propose(
    ctx: McpContext,
    tool: string,
    args: Record<string, unknown>,
    summary: string,
    now: Date = new Date(),
): Promise<ServiceResult<Proposal>> {
    const token = `${PREFIX}${crypto.randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(now.getTime() + CONFIRM_MINUTES * 60_000).toISOString();
    const { error } = await ctx.db.from("mcp_confirmations").insert({
        token_hash: sha256(token),
        user_id: ctx.caller.userId,
        access_token_id: ctx.tokenId,
        link_id: ctx.linkId,
        tool,
        args_hash: argumentsHash(args),
        summary: summary.slice(0, 500),
        expires_at: expiresAt,
    });
    if (error) return internalFailure(error);
    return ok({ confirm_token: token, expira_em: expiresAt });
}

const REFUSED = "Esta confirmação não vale mais: peça de novo, mostre o resumo à pessoa e confirme com o código novo.";

/**
 * Spends a confirmation: it must be this person's, through this access token
 * and link, for this tool and these exact arguments, unused and in time.
 * Marked used atomically (only a row still unused is updated), so two calls
 * racing with one token run the write once.
 */
export async function consume(
    ctx: McpContext,
    tool: string,
    args: Record<string, unknown>,
    confirmToken: string,
    now: Date = new Date(),
): Promise<ServiceResult<{ summary: string }>> {
    if (!confirmToken.startsWith(PREFIX)) return failure("validation", REFUSED, "confirmacao_invalida");
    const { data, error } = await ctx.db
        .from("mcp_confirmations")
        .select("id, user_id, access_token_id, link_id, tool, args_hash, summary, expires_at, used_at")
        .eq("token_hash", sha256(confirmToken))
        .maybeSingle();
    if (error) return internalFailure(error);
    const row = data as {
        id: string;
        user_id: string;
        access_token_id: string;
        link_id: string | null;
        tool: string;
        args_hash: string;
        summary: string;
        expires_at: string;
        used_at: string | null;
    } | null;
    const matches =
        !!row &&
        row.user_id === ctx.caller.userId &&
        row.access_token_id === ctx.tokenId &&
        (row.link_id ?? null) === (ctx.linkId ?? null) &&
        row.tool === tool &&
        row.args_hash === argumentsHash(args) &&
        !row.used_at &&
        Date.parse(row.expires_at) > now.getTime();
    if (!matches) return failure("validation", REFUSED, "confirmacao_invalida");

    const { data: spent, error: spendError } = await ctx.db
        .from("mcp_confirmations")
        .update({ used_at: now.toISOString() })
        .eq("id", row!.id)
        .is("used_at", null)
        .select("id");
    if (spendError) return internalFailure(spendError);
    if (((spent ?? []) as unknown[]).length !== 1) return failure("validation", REFUSED, "confirmacao_invalida");
    return ok({ summary: row!.summary });
}
