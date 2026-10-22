import { describe, expect, it, vi } from "vitest";

const workspace = vi.hoisted(() => ({
    resolveWorkspaceFilter: vi.fn(async (_db: unknown, _user: string, raw: unknown) =>
        raw === "personal"
            ? { ok: true, workspace: "personal" }
            : raw === "00000000-0000-4000-a000-0000000000aa"
              ? { ok: true, workspace: raw }
              : { ok: false, kind: "not_found" },
    ),
}));
vi.mock("../../../lib/workspace", async (orig) => ({ ...(await orig<object>()), ...workspace }));

import { authenticateToken, createAccessToken, hashToken, listAccessTokens, revokeAccessToken, touchToken } from "../mcp.tokens";
import { DEFAULT_SCOPES } from "../mcp.types";
import { fakeDb } from "./fakeDb";

const NOW = new Date("2026-10-21T12:00:00Z");
const ORG = "00000000-0000-4000-a000-0000000000aa";
const ana = { userId: "00000000-0000-4000-b000-000000000001", userEmail: "ana@exemplo.test" };
const users = { [ana.userId]: { email: "Ana@Exemplo.test", email_confirmed_at: "2026-01-01T00:00:00Z" } };

describe("access tokens", () => {
    it("creates a token shown once, storing only its hash, with the default read scopes", async () => {
        const { db, tables } = fakeDb({}, users);
        const r = await createAccessToken(db, ana, { name: "Claude Code do notebook" }, NOW);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.data.token).toMatch(/^mike_pat_[A-Za-z0-9_-]{43}$/);
        const row = tables.mcp_access_tokens[0];
        expect(row.token_hash).toBe(hashToken(r.data.token));
        expect(JSON.stringify(tables)).not.toContain(r.data.token);
        expect(row).toMatchObject({ kind: "pessoal", org_id: null, user_id: ana.userId, expires_at: "2026-11-20T12:00:00.000Z" });
        expect(row.scopes).toEqual([...DEFAULT_SCOPES]);
        expect(DEFAULT_SCOPES).not.toContain("revisao:run");
        expect(r.data.access_token).toMatchObject({ workspace: "personal", prefix: `mike_pat_${r.data.token.slice(9, 13)}…` });
        expect(r.data.access_token).not.toHaveProperty("token_hash");
    });

    it("scopes the token to an org the person belongs to, and refuses bad input in Portuguese", async () => {
        const { db, tables } = fakeDb({}, users);
        const inOrg = await createAccessToken(db, ana, { name: "Codex", workspace: ORG, scopes: ["contratos:read"], expires_in_days: 90 }, NOW);
        expect(inOrg.ok && inOrg.data.access_token.workspace).toBe(ORG);
        expect(tables.mcp_access_tokens[0].org_id).toBe(ORG);

        expect(await createAccessToken(db, ana, { name: "" }, NOW)).toMatchObject({ kind: "validation", detail: expect.stringMatching(/nome/) });
        expect(await createAccessToken(db, ana, { name: "x", scopes: ["tudo:write"] }, NOW)).toMatchObject({ kind: "validation" });
        expect(await createAccessToken(db, ana, { name: "x", scopes: [] }, NOW)).toMatchObject({ kind: "validation" });
        expect(await createAccessToken(db, ana, { name: "x", expires_in_days: 91 }, NOW)).toMatchObject({ kind: "validation", detail: "A validade vai de 1 a 90 dias." });
        expect(await createAccessToken(db, ana, { name: "x", workspace: "00000000-0000-4000-a000-0000000000bb" }, NOW)).toMatchObject({ kind: "not_found" });
    });

    it("caps active tokens per person", async () => {
        const active = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, user_id: ana.userId, kind: "pessoal", revoked_at: null, expires_at: "2027-01-01T00:00:00Z" }));
        const { db } = fakeDb({ mcp_access_tokens: active }, users);
        expect(await createAccessToken(db, ana, { name: "mais um" }, NOW)).toMatchObject({ kind: "conflict" });
    });

    it("lists and revokes only the person's own tokens; revoking keeps the row", async () => {
        const { db, tables } = fakeDb({}, users);
        const created = await createAccessToken(db, ana, { name: "Claude" }, NOW);
        if (!created.ok) throw new Error("setup");
        const id = created.data.access_token.id;
        const other = { userId: "00000000-0000-4000-b000-000000000002", userEmail: "beto@exemplo.test" };
        expect(await revokeAccessToken(db, other, id, NOW)).toMatchObject({ kind: "not_found" });
        expect(await revokeAccessToken(db, ana, "not-a-uuid", NOW)).toMatchObject({ kind: "not_found" });
        const revoked = await revokeAccessToken(db, ana, id, NOW);
        expect(revoked.ok && revoked.data.revoked_at).toBe(NOW.toISOString());
        expect(await revokeAccessToken(db, ana, id, new Date("2026-10-22T00:00:00Z"))).toMatchObject({ ok: true, data: { revoked_at: NOW.toISOString() } });
        expect(tables.mcp_access_tokens).toHaveLength(1);
        const list = await listAccessTokens(db, ana);
        expect(list.ok && list.data.map((t) => t.id)).toEqual([id]);
        const none = await listAccessTokens(db, other);
        expect(none.ok && none.data).toEqual([]);
    });
});

describe("authenticateToken", () => {
    async function withToken(over: Record<string, unknown> = {}, seed: Record<string, Record<string, unknown>[]> = {}) {
        const { db, tables } = fakeDb(seed, users);
        const created = await createAccessToken(db, ana, { name: "Claude", ...over }, NOW);
        if (!created.ok) throw new Error("setup");
        return { db, tables, token: created.data.token };
    }

    it("resolves a valid token to the person, with the session's e-mail rule", async () => {
        const { db, token } = await withToken();
        const r = await authenticateToken(db, `Bearer ${token}`, NOW);
        expect(r).toMatchObject({ ok: true, token: { userId: ana.userId, userEmail: "ana@exemplo.test", orgId: null, displayName: "ana@exemplo.test" } });

        const unconfirmed = fakeDb({}, { [ana.userId]: { email: "ana@exemplo.test", email_confirmed_at: null } });
        const c = await createAccessToken(unconfirmed.db, ana, { name: "x" }, NOW);
        if (!c.ok) throw new Error("setup");
        expect(await authenticateToken(unconfirmed.db, `Bearer ${c.data.token}`, NOW)).toMatchObject({ ok: true, token: { userEmail: "" } });
    });

    it("rejects missing, malformed, unknown, revoked and expired tokens", async () => {
        const { db, tables, token } = await withToken({ expires_in_days: 1 });
        expect(await authenticateToken(db, undefined, NOW)).toEqual({ ok: false, reason: "missing" });
        expect(await authenticateToken(db, "Basic abc", NOW)).toEqual({ ok: false, reason: "missing" });
        expect(await authenticateToken(db, "Bearer eyJhbGciOi.supabase.jwt", NOW)).toEqual({ ok: false, reason: "invalid" });
        expect(await authenticateToken(db, `Bearer ${token}x`, NOW)).toEqual({ ok: false, reason: "invalid" });
        expect(await authenticateToken(db, `Bearer ${token}`, new Date("2026-10-22T12:00:00Z"))).toEqual({ ok: false, reason: "expired" });
        tables.mcp_access_tokens[0].revoked_at = NOW.toISOString();
        expect(await authenticateToken(db, `Bearer ${token}`, NOW)).toEqual({ ok: false, reason: "revoked" });
    });

    it("stops working when the person leaves the org, is deleted, or is being deleted", async () => {
        const member = { org_members: [{ org_id: ORG, user_id: ana.userId }] };
        const { db, tables, token } = await withToken({ workspace: ORG }, member);
        expect(await authenticateToken(db, `Bearer ${token}`, NOW)).toMatchObject({ ok: true, token: { orgId: ORG } });
        tables.org_members = [];
        expect(await authenticateToken(db, `Bearer ${token}`, NOW)).toEqual({ ok: false, reason: "not_member" });

        const deleting = await withToken({}, { user_profiles: [{ user_id: ana.userId, account_deletion_requested_at: "2026-10-20T00:00:00Z" }] });
        expect(await authenticateToken(deleting.db, `Bearer ${deleting.token}`, NOW)).toEqual({ ok: false, reason: "invalid" });

        const gone = fakeDb({}, {});
        const g = await createAccessToken(gone.db, ana, { name: "x" }, NOW);
        if (!g.ok) throw new Error("setup");
        expect(await authenticateToken(gone.db, `Bearer ${g.data.token}`, NOW)).toEqual({ ok: false, reason: "invalid" });
    });

    it("records the last use at most once a minute per client", async () => {
        const { db, tables, token } = await withToken();
        const r = await authenticateToken(db, `Bearer ${token}`, NOW);
        if (!r.ok) throw new Error("setup");
        await touchToken(db, r.token, "claude-code", NOW);
        expect(tables.mcp_access_tokens[0]).toMatchObject({ last_used_at: NOW.toISOString(), last_client: "claude-code" });
        const soon = new Date(NOW.getTime() + 30_000);
        await touchToken(db, { ...r.token, lastUsedAt: NOW.toISOString(), lastClient: "claude-code" }, "claude-code", soon);
        expect(tables.mcp_access_tokens[0].last_used_at).toBe(NOW.toISOString());
        await touchToken(db, { ...r.token, lastUsedAt: NOW.toISOString(), lastClient: "claude-code" }, "codex", soon);
        expect(tables.mcp_access_tokens[0]).toMatchObject({ last_used_at: soon.toISOString(), last_client: "codex" });
    });
});
