// The CNPJ lookup behind "Buscar CNPJ" in the request form (L-54). Same harness as
// mikeApi.mcpTokens.test.ts. The CNPJs are the well-known made-up test number.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/lib/errorReporting", () => ({
    trackPendingRequest: () => () => {},
    markErrorHandled: vi.fn(),
    reportApiFailure: vi.fn(),
    reportNetworkFailure: vi.fn(),
}));

import { lookupCnpj } from "./mikeApi";

const fetchMock = vi.fn();
const jsonResponse = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
const lastUrl = () => {
    const call = fetchMock.mock.calls.at(-1);
    if (!call) throw new Error("fetch was not called");
    return call[0] as string;
};

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("lookupCnpj", () => {
    const record = { cnpj: "12345678000190", razao_social: "EMPRESA FICTICIA LTDA", fonte: "brasilapi" };

    it("sends only the digits, so the punctuation never reaches the route", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(record));
        expect(await lookupCnpj("12.345.678/0001-90")).toEqual(record);
        expect(lastUrl()).toMatch(/\/cnpj\/12345678000190$/);
        expect(lastUrl()).not.toMatch(/[./-]0001|%2F/);
    });

    it("accepts a CNPJ that is already clean, and ignores spaces around it", async () => {
        fetchMock.mockImplementation(async () => jsonResponse(record));
        await lookupCnpj("12345678000190");
        expect(lastUrl()).toMatch(/\/cnpj\/12345678000190$/);
        await lookupCnpj("  12.345.678/0001-90  ");
        expect(lastUrl()).toMatch(/\/cnpj\/12345678000190$/);
    });

    it("keeps nothing but digits even when the text carries something else", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(record));
        await lookupCnpj("12345678000190/../../admin?x=1");
        // Every character that is not a digit is dropped, so nothing can steer the route elsewhere.
        expect(lastUrl()).toMatch(/\/cnpj\/123456780001901$/);
        expect(lastUrl()).not.toMatch(/\.\.|\?|admin/);
    });

    it("surfaces the server's code when the lookup is off, so the form can say so", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ code: "cnpj_disabled", detail: "off" }, { status: 503 }));
        await expect(lookupCnpj("12.345.678/0001-90")).rejects.toMatchObject({ status: 503, code: "cnpj_disabled" });
    });
});
