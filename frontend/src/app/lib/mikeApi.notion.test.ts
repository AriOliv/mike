// An organization's own Notion board (org settings → Integrações). Same
// harness as mikeApi.contracts.test.ts: a stubbed fetch and assertions on
// route, method and body.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/lib/errorReporting", () => ({
    trackPendingRequest: () => () => {},
    markErrorHandled: vi.fn(),
    reportApiFailure: vi.fn(),
    reportNetworkFailure: vi.fn(),
}));

import {
    getNotionSyncStatus,
    setNotionSyncEnabled,
    syncNotionNow,
    applyNotionImport,
    previewNotionImport,
    connectNotion,
    describeNotionBoard,
    disconnectNotion,
    getNotionConnection,
    listNotionDatabases,
    saveNotionMapping,
} from "./mikeApi";

const fetchMock = vi.fn();
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
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

describe("notion integration", () => {
    it("reads the connection, connects with a token in the body and disconnects", async () => {
        await getNotionConnection("org 1");
        expect(lastFetchCall().url).toMatch(/\/orgs\/org%201\/integrations\/notion$/);
        await connectNotion("org-1", "ntn_x");
        expect(lastFetchCall().url).toMatch(/\/orgs\/org-1\/integrations\/notion\/token$/);
        expect(lastFetchCall().init.method).toBe("PUT");
        expect(jsonBody()).toEqual({ token: "ntn_x" });
        await disconnectNotion("org-1");
        expect(lastFetchCall().url).toMatch(/\/integrations\/notion\/token$/);
        expect(lastFetchCall().init.method).toBe("DELETE");
    });

    it("lists bases, describes one and saves the mapping", async () => {
        await listNotionDatabases("org-1");
        expect(lastFetchCall().url).toMatch(/\/integrations\/notion\/databases$/);
        await describeNotionBoard("org-1", "db 1");
        expect(lastFetchCall().url).toMatch(/\/integrations\/notion\/board\?database_id=db%201$/);
        const mapping = { database_id: "db1", field_map: { Contrato: "name" }, stage_map: {}, poll_minutes: 10 };
        await saveNotionMapping("org-1", mapping);
        expect(lastFetchCall().url).toMatch(/\/integrations\/notion\/mapping$/);
        expect(lastFetchCall().init.method).toBe("PUT");
        expect(jsonBody()).toEqual(mapping);
    });
});

describe("notion import", () => {
    it("simulates with GET and imports with POST, writing back only when asked", async () => {
        await previewNotionImport("org-1");
        expect(lastFetchCall().url).toMatch(/\/integrations\/notion\/import$/);
        expect(lastFetchCall().init.method ?? "GET").toBe("GET");
        await applyNotionImport("org-1");
        expect(lastFetchCall().init.method).toBe("POST");
        expect(jsonBody()).toEqual({ write_back: false });
        await applyNotionImport("org-1", true);
        expect(jsonBody()).toEqual({ write_back: true });
    });
});

describe("notion sync", () => {
    it("reads the state, turns the sync on or off and syncs now", async () => {
        await getNotionSyncStatus("org-1");
        expect(lastFetchCall().url).toMatch(/\/integrations\/notion\/sync$/);
        await setNotionSyncEnabled("org-1", true);
        expect(lastFetchCall().init.method).toBe("PUT");
        expect(jsonBody()).toEqual({ enabled: true });
        await syncNotionNow("org-1");
        expect(lastFetchCall().url).toMatch(/\/integrations\/notion\/sync$/);
        expect(lastFetchCall().init.method).toBe("POST");
    });
});
