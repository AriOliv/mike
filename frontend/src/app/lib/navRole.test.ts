import { afterEach, describe, expect, it, vi } from "vitest";
import { loadNavRole } from "./navRole";

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
