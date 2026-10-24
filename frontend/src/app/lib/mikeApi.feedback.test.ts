// The two endpoints behind "Algo errado? Conte": whether the feature is on, and sending a report.
// Same harness as mikeApi.cnpj.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/lib/errorReporting", () => ({
    trackPendingRequest: () => () => {},
    markErrorHandled: vi.fn(),
    reportApiFailure: vi.fn(),
    reportNetworkFailure: vi.fn(),
}));

import { getFeedbackStatus, sendFeedback } from "./mikeApi";

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

describe("getFeedbackStatus", () => {
    it("asks the server whether the feature is on", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ enabled: true }));
        expect(await getFeedbackStatus()).toEqual({ enabled: true });
        expect(lastCall().url).toMatch(/\/feedback\/status$/);
        expect((lastCall().init.method ?? "GET").toUpperCase()).toBe("GET");
    });

    it("says off when the server does", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ enabled: false }));
        expect(await getFeedbackStatus()).toEqual({ enabled: false });
    });
});

describe("sendFeedback", () => {
    it("posts the report as JSON and returns the receipt with the number the person is given", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ number: 42, label: "REL-0042", redacted: true }, { status: 201 }));
        const body = { kind: "bug" as const, body: "O botão Salvar não responde", expected: "Salvar", route: "/pedidos", app_version: "abc123", browser: "Firefox", org_id: null };
        expect(await sendFeedback(body)).toEqual({ number: 42, label: "REL-0042", redacted: true });
        expect(lastCall().url).toMatch(/\/feedback$/);
        expect(lastCall().init.method).toBe("POST");
        expect(JSON.parse(lastCall().init.body as string)).toEqual(body);
    });

    it("sends no credential of its own in the body: only what the modal collected", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ number: 1, label: "REL-0001", redacted: false }, { status: 201 }));
        await sendFeedback({ kind: "feature", body: "Uma ideia" });
        expect(Object.keys(JSON.parse(lastCall().init.body as string)).sort()).toEqual(["body", "kind"]);
    });

    it("surfaces the server's code, so the modal can say what happened", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ code: "feedback_rate_limited", detail: "muitos" }, { status: 409 }));
        await expect(sendFeedback({ kind: "bug", body: "de novo" })).rejects.toMatchObject({ status: 409, code: "feedback_rate_limited" });
    });
});
