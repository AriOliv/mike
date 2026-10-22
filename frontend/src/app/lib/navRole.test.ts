import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAlertCount, loadNavRole } from "./navRole";

function answer(status: number, body: unknown) {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );
}

describe("loadNavRole", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("reads the caller's role from /requests/me", async () => {
        answer(200, { configured: true, role: "requester", area: null, areas: [] });
        await expect(loadNavRole()).resolves.toBe("requester");
        expect(fetch).toHaveBeenCalledWith(
            "/api/requests/me",
            expect.objectContaining({ credentials: "include" }),
        );
    });

    it("answers null when no Legal team is configured, so the menu stays whole", async () => {
        answer(200, { configured: false, role: "requester", area: null, areas: [] });
        await expect(loadNavRole()).resolves.toBeNull();
    });

    it("answers null when the server has no such route", async () => {
        answer(404, { detail: "Not found" });
        await expect(loadNavRole()).resolves.toBeNull();
    });

    it("answers null for a role it does not know", async () => {
        answer(200, { role: "dono" });
        await expect(loadNavRole()).resolves.toBeNull();
    });

    it("answers null when the request fails", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
        await expect(loadNavRole()).resolves.toBeNull();
    });
});

describe("loadAlertCount", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("counts the Head's open critical alerts", async () => {
        answer(200, { alerts: [{ request_id: "a" }, { request_id: "b" }] });
        await expect(loadAlertCount()).resolves.toBe(2);
        expect(fetch).toHaveBeenCalledWith("/api/requests/alerts", expect.objectContaining({ credentials: "include" }));
    });

    it("answers zero on an error, a missing route, a bad body or a network failure", async () => {
        answer(404, {});
        await expect(loadAlertCount()).resolves.toBe(0);
        answer(200, { alerts: "x" });
        await expect(loadAlertCount()).resolves.toBe(0);
        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
        await expect(loadAlertCount()).resolves.toBe(0);
    });
});
