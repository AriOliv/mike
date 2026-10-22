// The legal team's chat agent endpoints (org settings → Agente do Legal).
// Same harness as mikeApi.contracts.test.ts: a stubbed fetch and assertions
// on route, method and body.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/lib/errorReporting", () => ({
    trackPendingRequest: () => () => {},
    markErrorHandled: vi.fn(),
    reportApiFailure: vi.fn(),
    reportNetworkFailure: vi.fn(),
}));

import {
    deleteLegalAgentChannel,
    getLegalAgent,
    getLegalAgentChannelSetup,
    saveLegalAgentChannel,
    saveLegalAgentSettings,
    setLegalAgentChannelStatus,
    type LegalAgentSettings,
} from "./mikeApi";

const fetchMock = vi.fn();
const jsonResponse = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
const lastFetchCall = () => {
    const call = fetchMock.mock.calls.at(-1);
    if (!call) throw new Error("fetch was not called");
    return { url: call[0] as string, init: (call[1] ?? {}) as RequestInit };
};
const jsonBody = () => JSON.parse(lastFetchCall().init.body as string);

beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(async () => jsonResponse({}));
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("legal agent", () => {
    it("reads and saves the organization's settings", async () => {
        await getLegalAgent("org 1");
        expect(lastFetchCall().url).toMatch(/\/orgs\/org%201\/legal-agent$/);

        const settings = { enabled: true, tone: "formal" } as unknown as Omit<LegalAgentSettings, "updated_at">;
        await saveLegalAgentSettings("org-1", settings);
        expect(lastFetchCall().url).toMatch(/\/orgs\/org-1\/legal-agent$/);
        expect(lastFetchCall().init.method).toBe("PUT");
        expect(jsonBody()).toEqual({ enabled: true, tone: "formal" });
    });

    it("creates a channel with POST and edits one with PUT, the id in the path only", async () => {
        await saveLegalAgentChannel("org-1", { kind: "slack", name: "Slack", config: { workspace: "A" } });
        expect(lastFetchCall().url).toMatch(/\/orgs\/org-1\/legal-agent\/channels$/);
        expect(lastFetchCall().init.method).toBe("POST");
        expect(jsonBody()).toEqual({ kind: "slack", name: "Slack", config: { workspace: "A" } });

        await saveLegalAgentChannel("org-1", { id: "c/1", kind: "telegram", name: "Bot", config: {} });
        expect(lastFetchCall().url).toMatch(/\/orgs\/org-1\/legal-agent\/channels\/c%2F1$/);
        expect(lastFetchCall().init.method).toBe("PUT");
        expect(jsonBody()).toEqual({ kind: "telegram", name: "Bot", config: {} });
    });

    it("reads a channel's setup, changes its status and deletes it", async () => {
        await getLegalAgentChannelSetup("org-1", "c1");
        expect(lastFetchCall().url).toMatch(/\/orgs\/org-1\/legal-agent\/channels\/c1\/setup$/);

        await setLegalAgentChannelStatus("org-1", "c1", "configurado");
        expect(lastFetchCall().url).toMatch(/\/orgs\/org-1\/legal-agent\/channels\/c1$/);
        expect(lastFetchCall().init.method).toBe("PATCH");
        expect(jsonBody()).toEqual({ status: "configurado" });

        await deleteLegalAgentChannel("org-1", "c1");
        expect(lastFetchCall().url).toMatch(/\/orgs\/org-1\/legal-agent\/channels\/c1$/);
        expect(lastFetchCall().init.method).toBe("DELETE");
    });
});
