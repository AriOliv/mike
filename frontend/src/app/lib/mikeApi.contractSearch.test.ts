// The search behind "Qual é o contrato original?": two letters or more, the query encoded, the list unwrapped.
// Same harness as mikeApi.feedback.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/lib/errorReporting", () => ({
    trackPendingRequest: () => () => {},
    markErrorHandled: vi.fn(),
    reportApiFailure: vi.fn(),
    reportNetworkFailure: vi.fn(),
}));

import { searchRequestContracts } from "./mikeApi";

const fetchMock = vi.fn();
const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("searchRequestContracts", () => {
    it("asks for the query, encoded, and returns the contracts", async () => {
        const contracts = [{ id: "c1", name: "Prestação de serviços Alfa", counterparty: "Nuvem Fictícia S.A." }];
        fetchMock.mockResolvedValueOnce(jsonResponse({ contracts }));
        expect(await searchRequestContracts("alfa & beta")).toEqual(contracts);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toMatch(/\/requests\/contracts\?q=alfa%20%26%20beta$/);
        expect(((init as RequestInit | undefined)?.method ?? "GET").toUpperCase()).toBe("GET");
    });
});
