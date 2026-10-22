import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const access = vi.hoisted(() => ({ getOrgRole: vi.fn(), isOrgAdmin: (r: string | null) => r === "owner" || r === "admin" }));
vi.mock("../../../lib/access", () => access);
const audit = vi.hoisted(() => ({ recordAudit: vi.fn() }));
vi.mock("../../../lib/audit", () => audit);

import {
    confirmChatLink,
    createLinkChallenge,
    listMyChatLinks,
    previewChatLink,
    resolveChatIdentity,
    revokeMyChatLink,
    validIdentity,
} from "../legalAgent.service";

const NOW = new Date("2026-10-22T03:00:00Z");
const ORG = "o1";
const duda = { userId: "u-duda", userEmail: "duda@avenia.io" };
const TOKEN = "A".repeat(32);
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const challenge = (over: Record<string, unknown> = {}) => ({
    id: "ch1",
    org_id: ORG,
    platform: "slack",
    platform_team_id: "T01",
    platform_user_id: "U09",
    created_via_token_id: "svc1",
    expires_at: "2026-10-22T03:10:00Z",
    used_at: null,
    ...over,
});

beforeEach(() => {
    access.getOrgRole.mockReset();
    audit.recordAudit.mockReset();
    delete process.env.APP_BASE_URL;
    delete process.env.FRONTEND_URL;
});

describe("validIdentity", () => {
    it("takes only known platforms and plain ids", () => {
        expect(validIdentity("slack", "T01", "U09")).toBe(true);
        expect(validIdentity("discord", "T01", "U09")).toBe(false);
        expect(validIdentity("slack", "T:01", "U09")).toBe(false);
        expect(validIdentity("slack", "T01", "U09\r\nX: y")).toBe(false);
        expect(validIdentity("slack", "", "U09")).toBe(false);
        expect(validIdentity("slack", "T01", 9)).toBe(false);
        expect(validIdentity("slack", "T".repeat(65), "U09")).toBe(false);
    });
});

describe("resolveChatIdentity", () => {
    it("finds the person through a confirmed, live link on a registered workspace", async () => {
        const fake = scriptedDb([
            { table: "legal_agent_channels", data: [{ id: "c1" }] },
            { table: "chat_identity_links", data: { id: "l1", user_id: "u-duda" } },
        ]);
        expect(await resolveChatIdentity(fake.db, ORG, "slack", "T01", "U09", NOW)).toEqual({ userId: "u-duda", linkId: "l1" });
        expect(fake.calls[0].filters).toEqual([
            ["eq", "org_id", ORG],
            ["eq", "kind", "slack"],
            ["eq", "platform_team_id", "T01"],
            ["limit", 1],
        ]);
        expect(fake.calls[1].filters).toEqual([
            ["eq", "org_id", ORG],
            ["eq", "platform", "slack"],
            ["eq", "platform_team_id", "T01"],
            ["eq", "platform_user_id", "U09"],
            ["is", "revoked_at", null],
            ["gte", "expires_at", NOW.toISOString()],
        ]);
        fake.done();
    });

    it("refuses a malformed identity, another company's workspace and a missing link", async () => {
        expect(await resolveChatIdentity(scriptedDb([]).db, ORG, "slack", "T01", "U 09", NOW)).toBeNull();
        expect(await resolveChatIdentity(scriptedDb([{ table: "legal_agent_channels", data: [] }]).db, ORG, "slack", "T99", "U09", NOW)).toBeNull();
        expect(await resolveChatIdentity(scriptedDb([{ table: "legal_agent_channels", data: null }]).db, ORG, "slack", "T99", "U09", NOW)).toBeNull();
        expect(
            await resolveChatIdentity(
                scriptedDb([{ table: "legal_agent_channels", data: [{ id: "c1" }] }, { table: "chat_identity_links", data: null }]).db,
                ORG,
                "slack",
                "T01",
                "U09",
                NOW,
            ),
        ).toBeNull();
    });

    it("throws on a read failure instead of answering 'not linked'", async () => {
        await expect(
            resolveChatIdentity(scriptedDb([{ table: "legal_agent_channels", error: { message: "down" } }]).db, ORG, "slack", "T01", "U09"),
        ).rejects.toMatchObject({ message: "down" });
        await expect(
            resolveChatIdentity(
                scriptedDb([{ table: "legal_agent_channels", data: [{ id: "c1" }] }, { table: "chat_identity_links", error: { message: "x" } }]).db,
                ORG,
                "slack",
                "T01",
                "U09",
            ),
        ).rejects.toMatchObject({ message: "x" });
    });
});

describe("createLinkChallenge", () => {
    it("stores only the hash, bound to the chat identity, for 15 minutes", async () => {
        process.env.APP_BASE_URL = "https://mike.example/";
        const fake = scriptedDb([{ table: "legal_agent_channels", data: [{ id: "c1" }] }, { table: "chat_link_challenges", op: "insert" }]);
        const result = await createLinkChallenge(fake.db, { orgId: ORG, tokenId: "svc1", platform: "slack", teamId: "T01", userId: "U09" }, NOW);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.expires_at).toBe("2026-10-22T03:15:00.000Z");
        const token = new URL(result.data.url).searchParams.get("t")!;
        expect(result.data.url.startsWith("https://mike.example/vincular-chat?t=")).toBe(true);
        expect(fake.calls[1].payload).toEqual({
            token_hash: sha(token),
            org_id: ORG,
            platform: "slack",
            platform_team_id: "T01",
            platform_user_id: "U09",
            created_via_token_id: "svc1",
            expires_at: "2026-10-22T03:15:00.000Z",
        });
        expect(JSON.stringify(fake.calls[1].payload)).not.toContain(token);
    });

    it("refuses a bad identity, an unregistered workspace, and maps write failures", async () => {
        const input = { orgId: ORG, tokenId: null, platform: "slack", teamId: "T01", userId: "U09" };
        expect(await createLinkChallenge(scriptedDb([]).db, { ...input, platform: "email" })).toMatchObject({ kind: "validation" });
        expect(await createLinkChallenge(scriptedDb([{ table: "legal_agent_channels", data: [] }]).db, input)).toMatchObject({
            kind: "forbidden",
            detail: "Este workspace não está ligado ao assistente do Legal desta organização.",
        });
        expect(
            await createLinkChallenge(
                scriptedDb([{ table: "legal_agent_channels", data: [{ id: "c1" }] }, { table: "chat_link_challenges", op: "insert", error: { message: "x" } }]).db,
                input,
            ),
        ).toMatchObject({ kind: "error" });
    });
});

describe("confirming a link", () => {
    it("previews for a member, then links the chat account to whoever confirms, replacing the old link", async () => {
        access.getOrgRole.mockResolvedValue("member");
        const preview = scriptedDb([{ table: "chat_link_challenges", data: challenge() }, { table: "organizations", data: { name: "Avenia" } }]);
        expect(await previewChatLink(preview.db, duda, TOKEN, NOW)).toEqual({
            ok: true,
            data: { platform: "slack", org_name: "Avenia", email: "duda@avenia.io" },
        });
        expect(preview.calls[0].filters).toEqual([["eq", "token_hash", sha(TOKEN)]]);

        const link = { id: "l2", platform: "slack", platform_team_id: "T01", platform_user_id: "U09", confirmed_at: NOW.toISOString(), expires_at: "x", revoked_at: null };
        const fake = scriptedDb([
            { table: "chat_link_challenges", data: challenge() },
            { table: "chat_link_challenges", op: "update", data: { id: "ch1" } },
            { table: "chat_identity_links", op: "update" },
            { table: "chat_identity_links", op: "insert", data: link },
        ]);
        expect(await confirmChatLink(fake.db, duda, TOKEN, NOW)).toEqual({ ok: true, data: { link } });
        expect(fake.calls[1].filters).toEqual([
            ["eq", "id", "ch1"],
            ["is", "used_at", null],
        ]);
        expect(fake.calls[2].payload).toEqual({ revoked_at: NOW.toISOString() });
        expect(fake.calls[3].payload).toEqual({
            org_id: ORG,
            platform: "slack",
            platform_team_id: "T01",
            platform_user_id: "U09",
            // The caller of this request, never anyone named in the link.
            user_id: "u-duda",
            confirmed_at: NOW.toISOString(),
            expires_at: "2027-04-20T03:00:00.000Z",
            created_via_token_id: "svc1",
        });
        expect(audit.recordAudit).toHaveBeenCalledWith(fake.db, expect.objectContaining({ action: "legal_agent.chat_linked", orgId: ORG }));
        fake.done();
    });

    it("refuses an expired, used, malformed or unknown link, and a non-member", async () => {
        access.getOrgRole.mockResolvedValue("member");
        const expired = "Este link expirou ou já foi usado. Peça um novo ao assistente no chat.";
        expect(await confirmChatLink(scriptedDb([]).db, duda, "curto", NOW)).toMatchObject({ detail: expired });
        expect(await confirmChatLink(scriptedDb([]).db, duda, undefined, NOW)).toMatchObject({ detail: expired });
        expect(await confirmChatLink(scriptedDb([{ table: "chat_link_challenges", data: null }]).db, duda, TOKEN, NOW)).toMatchObject({ detail: expired });
        expect(
            await confirmChatLink(scriptedDb([{ table: "chat_link_challenges", data: challenge({ used_at: "2026-10-22T02:59:00Z" }) }]).db, duda, TOKEN, NOW),
        ).toMatchObject({ detail: expired });
        expect(
            await previewChatLink(scriptedDb([{ table: "chat_link_challenges", data: challenge({ expires_at: "2026-10-22T02:59:00Z" }) }]).db, duda, TOKEN, NOW),
        ).toMatchObject({ detail: expired });
        // Someone else already burned it between the read and the update.
        expect(
            await confirmChatLink(
                scriptedDb([{ table: "chat_link_challenges", data: challenge() }, { table: "chat_link_challenges", op: "update", data: null }]).db,
                duda,
                TOKEN,
                NOW,
            ),
        ).toMatchObject({ detail: expired });

        access.getOrgRole.mockResolvedValue(null);
        const notMember = "Sua conta não faz parte da organização deste assistente.";
        expect(await confirmChatLink(scriptedDb([{ table: "chat_link_challenges", data: challenge() }]).db, duda, TOKEN, NOW)).toMatchObject({
            kind: "forbidden",
            detail: notMember,
        });
        expect(await previewChatLink(scriptedDb([{ table: "chat_link_challenges", data: challenge() }]).db, duda, TOKEN, NOW)).toMatchObject({
            detail: notMember,
        });
        expect(audit.recordAudit).not.toHaveBeenCalled();
    });

    it("maps read and write failures", async () => {
        access.getOrgRole.mockResolvedValue("member");
        expect(await previewChatLink(scriptedDb([{ table: "chat_link_challenges", error: { message: "x" } }]).db, duda, TOKEN)).toMatchObject({ kind: "error" });
        expect(
            await previewChatLink(
                scriptedDb([{ table: "chat_link_challenges", data: challenge({ expires_at: "2999-01-01T00:00:00Z" }) }, { table: "organizations", error: { message: "x" } }]).db,
                duda,
                TOKEN,
            ),
        ).toMatchObject({ kind: "error" });
        const preview = scriptedDb([{ table: "chat_link_challenges", data: challenge() }, { table: "organizations", data: null }]);
        expect(await previewChatLink(preview.db, { userId: "u" }, TOKEN, NOW)).toMatchObject({ data: { org_name: "sua organização", email: null } });
        for (const failingStep of [1, 2, 3]) {
            const steps = [
                { table: "chat_link_challenges", data: challenge() },
                { table: "chat_link_challenges", op: "update", data: { id: "ch1" } },
                { table: "chat_identity_links", op: "update" },
                { table: "chat_identity_links", op: "insert", data: {} },
            ].slice(0, failingStep + 1) as { table: string; op?: string; data?: unknown; error?: unknown }[];
            steps[failingStep] = { ...steps[failingStep], error: { message: "x" } };
            expect(await confirmChatLink(scriptedDb(steps).db, { userId: "u" }, TOKEN, NOW)).toMatchObject({ kind: "error" });
        }
    });
});

describe("a person's own links", () => {
    it("lists and revokes only the caller's", async () => {
        const list = scriptedDb([{ table: "chat_identity_links", data: [{ id: "l1" }] }]);
        expect(await listMyChatLinks(list.db, duda, ORG)).toEqual({ ok: true, data: [{ id: "l1" }] });
        expect(list.calls[0].filters).toContainEqual(["eq", "user_id", "u-duda"]);
        expect(await listMyChatLinks(scriptedDb([{ table: "chat_identity_links", data: null }]).db, duda, ORG)).toEqual({ ok: true, data: [] });
        expect(await listMyChatLinks(scriptedDb([{ table: "chat_identity_links", error: { message: "x" } }]).db, duda, ORG)).toMatchObject({ kind: "error" });

        const revoke = scriptedDb([{ table: "chat_identity_links", op: "update", data: { id: "l1" } }]);
        expect(await revokeMyChatLink(revoke.db, duda, ORG, "l1")).toEqual({ ok: true, data: { revoked: true } });
        expect(revoke.calls[0].filters).toEqual([
            ["eq", "id", "l1"],
            ["eq", "org_id", ORG],
            ["eq", "user_id", "u-duda"],
            ["is", "revoked_at", null],
        ]);
        expect(audit.recordAudit).toHaveBeenCalledWith(revoke.db, expect.objectContaining({ action: "legal_agent.chat_unlinked" }));
        expect(await revokeMyChatLink(scriptedDb([{ table: "chat_identity_links", op: "update", data: null }]).db, duda, ORG, "l9")).toMatchObject({
            kind: "not_found",
        });
        expect(await revokeMyChatLink(scriptedDb([{ table: "chat_identity_links", op: "update", error: { message: "x" } }]).db, duda, ORG, "l1")).toMatchObject({
            kind: "error",
        });
    });
});
