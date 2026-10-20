// Contract review by playbook and the Ficha (/projects/:id/contract-review).
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
    decideFichaField,
    decideReviewClause,
    extractContractFicha,
    getContractFicha,
    getContractReview,
    listContractReviews,
    startContractReview,
} from "./mikeApi";

const fetchMock = vi.fn();
const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const lastCall = () => {
    const call = fetchMock.mock.calls.at(-1)!;
    return { url: call[0] as string, init: (call[1] ?? {}) as RequestInit };
};

beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true }));
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("contract review", () => {
    it("lists, starts and reads a contract's reviews", async () => {
        await listContractReviews("p 1");
        expect(lastCall().url).toMatch(/\/projects\/p%201\/contract-review\/reviews$/);

        await startContractReview("p1");
        expect(lastCall().init.method).toBe("POST");
        expect(JSON.parse(lastCall().init.body as string)).toEqual({});
        await startContractReview("p1", { playbook_id: "pb", model: "m" });
        expect(JSON.parse(lastCall().init.body as string)).toEqual({ playbook_id: "pb", model: "m" });

        await getContractReview("p1", "run/1");
        expect(lastCall().url).toMatch(/\/contract-review\/reviews\/run%2F1$/);
    });

    it("sends one decision per clause", async () => {
        await decideReviewClause("p1", "r1", "f 1", { decision: "rejeitado", reason: "não" });
        expect(lastCall().url).toMatch(/\/reviews\/r1\/clauses\/f%201\/decision$/);
        expect(lastCall().init.method).toBe("POST");
        expect(JSON.parse(lastCall().init.body as string)).toEqual({ decision: "rejeitado", reason: "não" });
    });
});

describe("Ficha", () => {
    it("reads, extracts and validates the Ficha", async () => {
        await getContractFicha("p1");
        expect(lastCall().url).toMatch(/\/contract-review\/ficha$/);
        await extractContractFicha("p1");
        expect(lastCall().url).toMatch(/\/ficha\/extract$/);
        expect(lastCall().init.method).toBe("POST");
        await decideFichaField("p1", { path: "foro.lei_aplicavel", action: "corrigir", value: { jurisdicao: "BR" } });
        expect(lastCall().url).toMatch(/\/ficha\/fields$/);
        expect(lastCall().init.method).toBe("PATCH");
        expect(JSON.parse(lastCall().init.body as string)).toEqual({
            path: "foro.lei_aplicavel",
            action: "corrigir",
            value: { jurisdicao: "BR" },
        });
    });
});
