// Service tokens (doc 09 §3.2): made and revoked by an org's owners and
// admins, acting only for the member whose chat identity the header names
// and who confirmed it on Mike; never for an e-mail, never without act_as,
// never past the org. Fictional people and ids only.

import { beforeEach, describe, expect, it, vi } from "vitest";

const links = vi.hoisted(() => ({ resolveChatIdentity: vi.fn(), createLinkChallenge: vi.fn() }));
vi.mock("../../legal-agent/legalAgent.service", async (orig) => {
    const actual = await orig<typeof import("../../legal-agent/legalAgent.service")>();
    return { ...actual, resolveChatIdentity: links.resolveChatIdentity, createLinkChallenge: links.createLinkChallenge };
});
const who = vi.hoisted(() => ({ role: "team" as "head" | "team" | "requester" }));
vi.mock("../../requests/requests.service", async (orig) => ({
    ...(await orig<object>()),
    whoAmI: vi.fn(async () => ({ ok: true, data: { configured: true, role: who.role, area: null, areas: [] } })),
}));

import { failure, ok } from "../../../lib/serviceResult";
import { resetCallLimits } from "../mcp.limits";
import { openMcpCall, SERVICE_LIMITS } from "../mcp.service";
import { createAccessToken, createServiceToken, hashToken, listServiceTokens, revokeAccessToken, revokeServiceToken } from "../mcp.tokens";
import { fakeDb } from "./fakeDb";

const NOW = new Date("2026-10-22T12:00:00Z");
const ORG = "00000000-0000-4000-a000-0000000000aa";
const TOTP = [{ factor_type: "totp", status: "verified" }];
const admin = { userId: "00000000-0000-4000-b000-000000000001", userEmail: "admin@exemplo.test" };
const duda = { userId: "00000000-0000-4000-b000-000000000002", userEmail: "duda@exemplo.test" };
const users = {
    [admin.userId]: { email: "admin@exemplo.test", email_confirmed_at: "2026-01-01T00:00:00Z", factors: TOTP },
    [duda.userId]: { email: "duda@exemplo.test", email_confirmed_at: "2026-01-01T00:00:00Z", factors: TOTP },
};
const members = (adminRole = "admin") => [
    { org_id: ORG, user_id: admin.userId, role: adminRole },
    { org_id: ORG, user_id: duda.userId, role: "member" },
];
const body = (over: Record<string, unknown> = {}) => ({
    name: "Hermes docbot",
    org_id: ORG,
    scopes: ["contratos:read", "pedidos:read"],
    can_act_as: true,
    ...over,
});

async function service(seed: Record<string, Record<string, unknown>[]> = {}) {
    const fake = fakeDb({ org_members: members(), user_profiles: [{ user_id: duda.userId, display_name: "Duda" }], ...seed }, users);
    const r = await createServiceToken(fake.db, admin, body(), NOW);
    if (!r.ok) throw new Error(`setup: ${JSON.stringify(r)}`);
    return { ...fake, token: r.data.token, id: r.data.access_token.id };
}

const call = (db: unknown, token: string, actingUser?: string) =>
    openMcpCall(db as never, { authorization: `Bearer ${token}`, body: { method: "initialize", params: { clientInfo: { name: "hermes-docbot" } } }, userAgent: undefined, actingUser }, NOW);

beforeEach(() => {
    resetCallLimits();
    links.resolveChatIdentity.mockReset().mockResolvedValue({ userId: duda.userId, linkId: "link-1" });
    links.createLinkChallenge.mockReset().mockResolvedValue(ok({ url: "https://mike.exemplo.test/vincular-chat?t=abc", expires_at: "2026-10-22T12:15:00Z" }));
    who.role = "team";
});

describe("creating and revoking service tokens", () => {
    it("lets an org admin create one, shown once, stored as a hash, with act_as granted", async () => {
        const { tables, token } = await service();
        expect(token).toMatch(/^mike_svc_[A-Za-z0-9_-]{43}$/);
        const row = tables.mcp_access_tokens[0];
        expect(row).toMatchObject({ kind: "servico", org_id: ORG, user_id: admin.userId, can_act_as: true, token_hash: hashToken(token) });
        expect(JSON.stringify(tables)).not.toContain(token);
    });

    it("refuses a member who does not run the org, a missing act_as, a bad org and an account without MFA", async () => {
        const plain = fakeDb({ org_members: members("member") }, users);
        expect(await createServiceToken(plain.db, admin, body(), NOW)).toMatchObject({ kind: "forbidden", detail: "Só quem administra a organização cria e revoga tokens de serviço." });

        const fake = fakeDb({ org_members: members() }, users);
        expect(await createServiceToken(fake.db, admin, body({ can_act_as: false }), NOW)).toMatchObject({ kind: "validation" });
        expect(await createServiceToken(fake.db, admin, body({ org_id: "x" }), NOW)).toMatchObject({ kind: "validation" });
        expect(await createServiceToken(fake.db, admin, body({ scopes: [] }), NOW)).toMatchObject({ kind: "validation" });
        expect(await createServiceToken(fake.db, admin, body({ expires_in_days: 91 }), NOW)).toMatchObject({ kind: "validation" });

        const noMfa = fakeDb({ org_members: members() }, { [admin.userId]: { ...users[admin.userId], factors: [] } });
        expect(await createServiceToken(noMfa.db, admin, body(), NOW)).toMatchObject({ kind: "forbidden", code: "mfa_enrollment_required" });
        expect(fake.tables.mcp_access_tokens ?? []).toEqual([]);
    });

    it("caps active service tokens per org, apart from the admin's own personal tokens", async () => {
        const active = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, org_id: ORG, kind: "servico", revoked_at: null, expires_at: "2027-01-01T00:00:00Z" }));
        const fake = fakeDb({ org_members: members(), mcp_access_tokens: active }, users);
        expect(await createServiceToken(fake.db, admin, body(), NOW)).toMatchObject({ kind: "conflict" });
        // The org's service tokens do not use up the admin's personal allowance.
        expect((await createAccessToken(fake.db, admin, { name: "Claude" }, NOW)).ok).toBe(true);
    });

    it("lets any admin of the org list and revoke it, a former admin or plain member not even see it", async () => {
        const { db, tables, id } = await service();
        expect(await listServiceTokens(db, admin, ORG)).toMatchObject({ ok: true, data: [{ id, kind: "servico", can_act_as: true }] });
        expect(await listServiceTokens(db, duda, ORG)).toMatchObject({ kind: "forbidden" });
        expect(await revokeServiceToken(db, duda, id, NOW)).toMatchObject({ kind: "not_found" });
        // Nor through the personal route, even for whoever made it.
        expect(await revokeAccessToken(db, admin, id, NOW)).toMatchObject({ kind: "not_found" });

        const other = "00000000-0000-4000-b000-000000000003";
        tables.org_members.push({ org_id: ORG, user_id: other, role: "owner" });
        const revoked = await revokeServiceToken(db, { userId: other, userEmail: "dona@exemplo.test" }, id, NOW);
        expect(revoked).toMatchObject({ ok: true, data: { revoked_at: NOW.toISOString() } });
        expect(await revokeServiceToken(db, admin, "nao-e-uuid", NOW)).toMatchObject({ kind: "not_found" });
    });
});

describe("a call with a service token", () => {
    it("acts as the member whose confirmed chat identity the header names", async () => {
        const { db, token, id } = await service();
        const r = await call(db, token, "slack:T0LEGAL:U0DUDA");
        expect(links.resolveChatIdentity).toHaveBeenCalledWith(db, ORG, "slack", "T0LEGAL", "U0DUDA", NOW);
        expect(r).toMatchObject({
            ok: true,
            data: {
                caller: { userId: duda.userId, userEmail: "duda@exemplo.test" },
                displayName: "Duda",
                role: "team",
                workspace: ORG,
                scopes: ["contratos:read", "pedidos:read"],
                tokenId: id,
                tokenKind: "servico",
                linkId: "link-1",
                actor: { actorId: "mcp:hermes-docbot", actorName: "hermes-docbot em nome de Duda", onBehalfOf: "duda@exemplo.test" },
            },
        });
    });

    it("needs the header, in the platform:team:user form, never an e-mail", async () => {
        const { db, token } = await service();
        expect(await call(db, token)).toMatchObject({ kind: "auth", auth: { status: 400, message: expect.stringMatching(/exige o cabeçalho/) } });
        for (const header of ["duda@exemplo.test", "slack:T0LEGAL", "fax:T1:U1", "slack:T0 LEGAL:U0DUDA"])
            expect(await call(db, token, header)).toMatchObject({ kind: "auth", auth: { status: 400 } });
        expect(links.resolveChatIdentity).not.toHaveBeenCalled();
    });

    it("answers 'vinculo_necessario' with a one-time link when the person has not confirmed", async () => {
        const { db, token, id } = await service();
        links.resolveChatIdentity.mockResolvedValue(null);
        expect(await call(db, token, "slack:T0LEGAL:U0NOVO")).toEqual({
            ok: false,
            kind: "auth",
            auth: {
                status: 403,
                code: "vinculo_necessario",
                message: expect.stringMatching(/confirmar/),
                link: { url: "https://mike.exemplo.test/vincular-chat?t=abc", expires_at: "2026-10-22T12:15:00Z" },
            },
        });
        expect(links.createLinkChallenge).toHaveBeenCalledWith(db, { orgId: ORG, tokenId: id, platform: "slack", teamId: "T0LEGAL", userId: "U0NOVO" }, NOW);

        links.createLinkChallenge.mockResolvedValueOnce(failure("forbidden", "Este workspace não está ligado ao assistente do Legal desta organização."));
        expect(await call(db, token, "slack:T0OUTRO:U0X")).toMatchObject({ auth: { status: 403, code: "workspace_nao_registrado" } });
    });

    it("stops when the linked person left the org", async () => {
        const { db, tables, token } = await service();
        tables.org_members = tables.org_members.filter((m) => m.user_id !== duda.userId);
        expect(await call(db, token, "slack:T0LEGAL:U0DUDA")).toMatchObject({ auth: { status: 403, message: expect.stringMatching(/não faz mais parte/) } });
    });

    it("refuses a service token without act_as, revoked or expired, and a personal token with the header", async () => {
        const { db, tables, token } = await service();
        tables.mcp_access_tokens[0].can_act_as = false;
        expect(await call(db, token, "slack:T0LEGAL:U0DUDA")).toMatchObject({ auth: { status: 401 } });
        tables.mcp_access_tokens[0].can_act_as = true;
        tables.mcp_access_tokens[0].revoked_at = NOW.toISOString();
        expect(await call(db, token, "slack:T0LEGAL:U0DUDA")).toMatchObject({ auth: { status: 401, message: "Este token foi revogado." } });

        const personal = await createAccessToken(db, duda, { name: "Claude" }, NOW);
        if (!personal.ok) throw new Error("setup");
        expect(await call(db, personal.data.token, "slack:T0LEGAL:U0DUDA")).toMatchObject({ auth: { status: 400 } });
        // A service-shaped secret stored as personal is not a service token.
        tables.mcp_access_tokens.push({ ...tables.mcp_access_tokens[0], id: "x", kind: "pessoal", token_hash: hashToken("mike_svc_falso"), revoked_at: null });
        expect(await call(db, "mike_svc_falso", "slack:T0LEGAL:U0DUDA")).toMatchObject({ auth: { status: 401 } });
    });

    it("limits calls per service token and per linked person", async () => {
        const { db, token } = await service();
        for (let i = 0; i < SERVICE_LIMITS.perPerson; i++) expect((await call(db, token, "slack:T0LEGAL:U0DUDA")).ok).toBe(true);
        expect(await call(db, token, "slack:T0LEGAL:U0DUDA")).toMatchObject({ auth: { status: 429, message: expect.stringMatching(/desta pessoa/) } });

        resetCallLimits();
        let refused = 0;
        for (let i = 0; i < SERVICE_LIMITS.perToken + 1; i++) {
            links.resolveChatIdentity.mockResolvedValueOnce({ userId: duda.userId, linkId: `link-${i}` });
            const r = await call(db, token, "slack:T0LEGAL:U0DUDA");
            if (!r.ok && r.kind === "auth" && r.auth.status === 429) refused++;
        }
        expect(refused).toBe(1);
    });
});
