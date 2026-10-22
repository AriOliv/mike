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
    decideAnalysisRedline,
    decideFichaField,
    decideReviewClause,
    exportAnalysis,
    extractContractFicha,
    getContractFicha,
    getContractReview,
    getLatestAnalysis,
    listAnalysisDecisions,
    listContractFichas,
    listContractReviews,
    startAnalystAnalysis,
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

describe("analyst's analysis", () => {
    it("reads, starts and lists the decisions of an analysis", async () => {
        await getLatestAnalysis("p 1");
        expect(lastCall().url).toMatch(/\/projects\/p%201\/contract-review\/analysis$/);

        await startAnalystAnalysis("p1");
        expect(lastCall().init.method).toBe("POST");
        expect(JSON.parse(lastCall().init.body as string)).toEqual({});
        const intake = [{ key: "objeto", label: "Objeto", value: "Suporte", source: "pedido" }];
        await startAnalystAnalysis("p1", { request_id: "r1", intake });
        expect(JSON.parse(lastCall().init.body as string)).toEqual({ request_id: "r1", intake });

        await listAnalysisDecisions("p1", "a/1");
        expect(lastCall().url).toMatch(/\/analysis\/a%2F1\/decisions$/);
    });

    it("sends one decision per redline", async () => {
        await decideAnalysisRedline("p1", "a1", "r 1", { decision: "editado", edited_text: "multa de 10%" });
        expect(lastCall().url).toMatch(/\/analysis\/a1\/redlines\/r%201\/decision$/);
        expect(lastCall().init.method).toBe("POST");
        expect(JSON.parse(lastCall().init.body as string)).toEqual({ decision: "editado", edited_text: "multa de 10%" });
    });

    it("downloads the export with its filename", async () => {
        fetchMock.mockImplementationOnce(
            async () =>
                new Response("# Análise", {
                    status: 200,
                    headers: { "Content-Type": "text/markdown", "Content-Disposition": 'attachment; filename="Analise.md"' },
                }),
        );
        const file = await exportAnalysis("p1", "a1", "md");
        expect(lastCall().url).toMatch(/\/analysis\/a1\/export\?format=md$/);
        expect(file.filename).toBe("Analise.md");
        expect(await file.blob.text()).toBe("# Análise");
    });
});

describe("contract portfolio", () => {
    it("lists the portfolio with paging and sort", async () => {
        await listContractFichas();
        expect(lastCall().url).toMatch(/\/contracts\/fichas$/);
        await listContractFichas({ limit: 25, offset: 50, sort: "aviso" });
        expect(lastCall().url).toMatch(/\/contracts\/fichas\?limit=25&offset=50&sort=aviso$/);
    });
});

