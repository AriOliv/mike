import { afterEach, describe, expect, it } from "vitest";
import { notionClient, notionErrorMessage, NotionError } from "../notion.client";
import { fakeNotion } from "./notionFake";

afterEach(() => {
    delete process.env.NOTION_API_BASE;
});

describe("notionClient", () => {
    it("sends the version and token, honours one Retry-After and gives up after it", async () => {
        const waits: number[] = [];
        const notion = fakeNotion({
            "GET /users/me": [{ status: 429, headers: { "Retry-After": "2" } }, { body: { ok: 1 } }],
        });
        const client = notionClient("ntn_x", notion.fetch, { wait: async (ms) => void waits.push(ms) });
        expect(await client.request("GET", "/users/me")).toEqual({ ok: 1 });
        expect(waits).toEqual([2000]);
        expect(notion.calls[0].headers).toMatchObject({ "Notion-Version": "2022-06-28", Authorization: "Bearer ntn_x" });

        const busy = fakeNotion({ "POST /search": [{ status: 429, headers: { "Retry-After": "999" } }, { status: 429 }] });
        const capped: number[] = [];
        await expect(notionClient("t", busy.fetch, { wait: async (ms) => void capped.push(ms) }).request("POST", "/search", {})).rejects.toMatchObject({
            status: 429,
        });
        expect(capped).toEqual([30_000]);
        expect(busy.calls[0].body).toEqual({});
    });

    it("uses a mock base for the preview and turns errors into codes, never text", async () => {
        process.env.NOTION_API_BASE = "http://notion-mock:8080/v1/";
        const notion = fakeNotion({ "GET /pages/x": { status: 404, body: { code: "object_not_found", message: "secret stuff" } } });
        const error = await notionClient("t", notion.fetch).request("GET", "/pages/x").catch((e) => e);
        expect(notion.calls[0].url).toBe("http://notion-mock:8080/v1/pages/x");
        expect(error).toBeInstanceOf(NotionError);
        expect(error.message).toBe("notion 404 object_not_found");
        const noCode = fakeNotion({ "GET /x": { status: 500, body: "nope" } });
        expect((await notionClient("t", noCode.fetch, { base: "https://n/v1" }).request("GET", "/x").catch((e) => e)).code).toBe("unknown");
        const badJson = {
            fetch: async () => ({ ok: false, status: 502, headers: { get: () => null }, json: async () => Promise.reject(new Error("x")) }),
        };
        expect((await notionClient("t", badJson.fetch).request("GET", "/x").catch((e) => e)).code).toBe("unknown");
        const noRetryAfter: number[] = [];
        const once = fakeNotion({ "GET /y": [{ status: 429 }, { body: {} }] });
        await notionClient("t", once.fetch, { wait: async (ms) => void noRetryAfter.push(ms) }).request("GET", "/y");
        expect(noRetryAfter).toEqual([1000]);
    });

    it("waits for real when no wait is injected", async () => {
        const notion = fakeNotion({ "GET /z": [{ status: 429, headers: { "Retry-After": "0.001" } }, { body: { ok: 1 } }] });
        expect(await notionClient("t", notion.fetch).request("GET", "/z")).toEqual({ ok: 1 });
    });

    it("words every failure for a person", () => {
        expect(notionErrorMessage(new NotionError(429, "rate_limited"))).toMatch(/pausa/);
        expect(notionErrorMessage(new NotionError(404, "object_not_found"))).toMatch(/Conexões/);
    });
});
