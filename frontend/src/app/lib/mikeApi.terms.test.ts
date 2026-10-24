// The contract's terms on a request (GET and PUT /requests/:id/terms). Same harness as
// mikeApi.cnpj.test.ts: fetch is the only thing mocked, so the real apiRequest runs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/lib/errorReporting", () => ({
    trackPendingRequest: () => () => {},
    markErrorHandled: vi.fn(),
    reportApiFailure: vi.fn(),
    reportNetworkFailure: vi.fn(),
}));

import { getRequestTerms, MikeApiError, saveRequestTerms } from "./mikeApi";

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

const terms = {
    counterparty: "Polaris",
    counterparty_email: null,
    term_start: "2026-11-12",
    term_months: 12,
    term_end: "2027-11-11",
    inferred: {},
    can_answer: true,
};

describe("getRequestTerms", () => {
    it("reads the terms of one request", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(terms));
        expect(await getRequestTerms("req-1")).toEqual(terms);
        const { url, init } = lastCall();
        expect(url).toMatch(/\/requests\/req-1\/terms$/);
        expect(init.method ?? "GET").toBe("GET");
    });
});

describe("saveRequestTerms", () => {
    it("puts what the person typed, as JSON", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(terms));
        const saved = await saveRequestTerms("req-1", { term_start: "2026-11-12", term_months: 12 });
        expect(saved).toEqual(terms);
        const { url, init } = lastCall();
        expect(url).toMatch(/\/requests\/req-1\/terms$/);
        expect(init.method).toBe("PUT");
        expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
        expect(JSON.parse(init.body as string)).toEqual({ term_start: "2026-11-12", term_months: 12 });
    });

    it("confirms what the agent read by naming the fields", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(terms));
        await saveRequestTerms("req-1", { confirm: ["term_months", "counterparty"] });
        expect(JSON.parse(lastCall().init.body as string)).toEqual({ confirm: ["term_months", "counterparty"] });
    });

    it("keeps the field a 422 names, so the form can paint it", async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ detail: "Use um prazo de 1 mês ou mais.", field: "term_months" }, { status: 422 }),
        );
        const error = await saveRequestTerms("req-1", { term_months: 0 }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MikeApiError);
        expect(error).toMatchObject({ status: 422, field: "term_months", message: "Use um prazo de 1 mês ou mais." });
    });
});
