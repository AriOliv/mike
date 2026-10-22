// The access-token endpoints behind Configurações → Tokens de acesso para
// agentes. Same harness as mikeApi.regulatory.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/lib/errorReporting", () => ({
    trackPendingRequest: () => () => {},
    markErrorHandled: vi.fn(),
    reportApiFailure: vi.fn(),
    reportNetworkFailure: vi.fn(),
}));

import { createMcpToken, listMcpTokens, revokeMcpToken } from "./mikeApi";

const fetchMock = vi.fn();
const jsonResponse = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
const lastCall = () => {
    const call = fetchMock.mock.calls.at(-1);
    if (!call) throw new Error("fetch was not called");
    return { url: call[0] as string, init: (call[1] ?? {}) as RequestInit };
};

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("access tokens for agents", () => {
    it("lists, creates and revokes", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ tokens: [{ id: "t1" }] }));
        expect(await listMcpTokens()).toEqual([{ id: "t1" }]);
        expect(lastCall().url).toMatch(/\/mcp-tokens$/);

        fetchMock.mockResolvedValueOnce(jsonResponse({ token: "mike_pat_x", access_token: { id: "t2" } }, { status: 201 }));
        const body = { name: "Claude Code", workspace: "personal", scopes: ["contratos:read" as const], expires_in_days: 30 };
        expect(await createMcpToken(body)).toEqual({ token: "mike_pat_x", access_token: { id: "t2" } });
        expect(lastCall().init.method).toBe("POST");
        expect(JSON.parse(lastCall().init.body as string)).toEqual(body);

        fetchMock.mockResolvedValueOnce(jsonResponse({ id: "t/3", revoked_at: "x" }));
        await revokeMcpToken("t/3");
        expect(lastCall().url).toMatch(/\/mcp-tokens\/t%2F3$/);
        expect(lastCall().init.method).toBe("DELETE");
    });
});
