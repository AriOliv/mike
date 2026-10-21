// The regulatory radar and the Legal dashboard endpoints. Same harness as
// mikeApi.contracts.test.ts: a stubbed fetch and assertions on route, method
// and body.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/lib/errorReporting", () => ({
    trackPendingRequest: () => () => {},
    markErrorHandled: vi.fn(),
    reportApiFailure: vi.fn(),
    reportNetworkFailure: vi.fn(),
}));

import {
    createObligationFromRegulatoryChange,
    createRegulatoryScan,
    createRequestFromRegulatoryChange,
    decideRegulatoryRuleSuggestion,
    listRegulatoryRuleSuggestions,
    suggestRuleFromRegulatoryChange,
    deleteRegulatoryScan,
    getLegalDashboard,
    getRegulatoryCatalog,
    listRegulatoryChanges,
    listRegulatoryScans,
    runRegulatoryScan,
    updateRegulatoryChange,
    updateRegulatoryScan,
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

describe("regulatory scans", () => {
    it("reads the catalog and the scans", async () => {
        await getRegulatoryCatalog();
        expect(lastFetchCall().url).toMatch(/\/regulatory\/presets$/);
        await listRegulatoryScans();
        expect(lastFetchCall().url).toMatch(/\/regulatory\/scans$/);
    });

    it("creates, edits, runs and deletes a scan", async () => {
        await createRegulatoryScan({ preset: "lgpd_anpd", org_id: "o1" });
        expect(lastFetchCall().init.method).toBe("POST");
        expect(jsonBody()).toEqual({ preset: "lgpd_anpd", org_id: "o1" });

        await updateRegulatoryScan("s1", { enabled: false });
        expect(lastFetchCall().url).toMatch(/\/regulatory\/scans\/s1$/);
        expect(lastFetchCall().init.method).toBe("PATCH");
        expect(jsonBody()).toEqual({ enabled: false });

        await runRegulatoryScan("s1");
        expect(lastFetchCall().url).toMatch(/\/regulatory\/scans\/s1\/run$/);
        expect(lastFetchCall().init.method).toBe("POST");

        fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
        await deleteRegulatoryScan("s1");
        expect(lastFetchCall().init.method).toBe("DELETE");
    });
});

describe("regulatory changes", () => {
    it("lists with and without filters", async () => {
        await listRegulatoryChanges();
        expect(lastFetchCall().url).toMatch(/\/regulatory\/changes$/);
        await listRegulatoryChanges({ scanId: "s1", tab: "favoritas", q: "pix" });
        expect(lastFetchCall().url).toMatch(/\/regulatory\/changes\?scan_id=s1&tab=favoritas&q=pix$/);
        await listRegulatoryChanges({ scanId: null });
        expect(lastFetchCall().url).toMatch(/\/regulatory\/changes$/);
    });

    it("triages and turns a change into work", async () => {
        await updateRegulatoryChange("c1", { status: "arquivada" });
        expect(lastFetchCall().init.method).toBe("PATCH");
        expect(jsonBody()).toEqual({ status: "arquivada" });

        await createRequestFromRegulatoryChange("c1");
        expect(lastFetchCall().url).toMatch(/\/regulatory\/changes\/c1\/request$/);
        expect(jsonBody()).toEqual({});
        await createRequestFromRegulatoryChange("c1", { assignee_email: "duda@avenia.io" });
        expect(jsonBody()).toEqual({ assignee_email: "duda@avenia.io" });

        await createObligationFromRegulatoryChange("c1");
        expect(lastFetchCall().url).toMatch(/\/regulatory\/changes\/c1\/obligation$/);
        expect(jsonBody()).toEqual({});
        await createObligationFromRegulatoryChange("c1", { due_date: "2026-12-01" });
        expect(jsonBody()).toEqual({ due_date: "2026-12-01" });
    });
});

describe("playbook rule suggestions", () => {
    it("suggests, lists and decides a rule", async () => {
        await suggestRuleFromRegulatoryChange("c1");
        expect(lastFetchCall().url).toMatch(/\/regulatory\/changes\/c1\/rule$/);
        expect(jsonBody()).toEqual({});
        await suggestRuleFromRegulatoryChange("c1", { guidance: "Exigir segregação", playbook_id: "pb1" });
        expect(jsonBody()).toEqual({ guidance: "Exigir segregação", playbook_id: "pb1" });

        await listRegulatoryRuleSuggestions();
        expect(lastFetchCall().url).toMatch(/\/regulatory\/rules$/);
        await listRegulatoryRuleSuggestions("pendente");
        expect(lastFetchCall().url).toMatch(/\/regulatory\/rules\?status=pendente$/);

        await decideRegulatoryRuleSuggestion("r1", { status: "aprovada" });
        expect(lastFetchCall().init.method).toBe("PATCH");
        expect(jsonBody()).toEqual({ status: "aprovada" });
    });
});

describe("legal dashboard", () => {
    it("asks for the period and the assumptions it was given", async () => {
        await getLegalDashboard();
        expect(lastFetchCall().url).toMatch(/\/dashboard$/);
        await getLegalDashboard({
            period: 30,
            assumptions: { minutes_per_review: 60, minutes_per_terms: 10, minutes_per_regulatory_triage: 5 },
        });
        expect(lastFetchCall().url).toMatch(/\/dashboard\?period=30&min_review=60&min_terms=10&min_regulatory=5$/);
        await getLegalDashboard({ assumptions: {} });
        expect(lastFetchCall().url).toMatch(/\/dashboard$/);
    });
});
