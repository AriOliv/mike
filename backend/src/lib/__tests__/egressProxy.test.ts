// The egress proxy path: the host allowlist is checked before anything
// leaves the process, and without a proxy variable nothing changes.

import { beforeEach, describe, expect, it, vi } from "vitest";

const undici = vi.hoisted(() => ({ fetch: vi.fn(async () => ({ status: 200 })) }));
vi.mock("undici", async (orig) => ({ ...(await orig<typeof import("undici")>()), fetch: undici.fetch }));
const guarded = vi.hoisted(() => ({ guardedFetch: vi.fn(async () => ({ status: 200 })) }));
vi.mock("../mcp/client", () => guarded);

import { defaultFetcher } from "../../modules/cnpj/cnpj.lookup";
import { egressProxyFor, EgressHostNotAllowedError, proxiedFetch } from "../egressProxy";

const PROXY = "http://egress-proxy.exemplo.test:3128";
const OPTS = { proxyUrl: PROXY, allowedHosts: ["brasilapi.com.br"] };

beforeEach(() => {
    undici.fetch.mockClear();
    guarded.guardedFetch.mockClear();
    delete process.env.CNPJ_EGRESS_PROXY_URL;
    delete process.env.EGRESS_PROXY_URL;
});

describe("egressProxyFor", () => {
    it("prefers the integration's variable, then the shared one, else goes direct", () => {
        expect(egressProxyFor("CNPJ_EGRESS_PROXY_URL", {})).toBeNull();
        expect(egressProxyFor("CNPJ_EGRESS_PROXY_URL", { EGRESS_PROXY_URL: PROXY })).toBe(PROXY);
        expect(egressProxyFor("CNPJ_EGRESS_PROXY_URL", { EGRESS_PROXY_URL: PROXY, CNPJ_EGRESS_PROXY_URL: "http://outro.test:1" })).toBe("http://outro.test:1");
        expect(() => egressProxyFor("X", { X: "ftp://proxy.test" })).toThrow();
    });
});

describe("proxiedFetch", () => {
    it("refuses a host outside the allowlist, http, credentials and lookalikes before sending", async () => {
        for (const url of [
            "https://example.com/x",
            "https://brasilapi.com.br.evil.test/x",
            "https://evil.test@brasilapi.com.br/x",
            "http://brasilapi.com.br/x",
            "https://169.254.169.254/latest",
            "https://localhost/x",
        ]) {
            await expect(proxiedFetch(url, {}, OPTS)).rejects.toBeInstanceOf(EgressHostNotAllowedError);
        }
        expect(undici.fetch).not.toHaveBeenCalled();
    });

    it("sends an allowed host through the proxy dispatcher, without following redirects", async () => {
        await proxiedFetch("https://BrasilAPI.com.br/api/cnpj/v1/1", {}, OPTS);
        expect(undici.fetch).toHaveBeenCalledOnce();
        const [target, init] = undici.fetch.mock.calls[0] as unknown as [URL, { redirect: string; dispatcher: unknown }];
        expect(target.hostname).toBe("brasilapi.com.br");
        expect(init.redirect).toBe("manual");
        expect(init.dispatcher).toBeDefined();
    });
});

describe("the CNPJ fetcher", () => {
    it("keeps the guarded direct path when no proxy is set", async () => {
        await defaultFetcher("https://brasilapi.com.br/api/cnpj/v1/1");
        expect(guarded.guardedFetch).toHaveBeenCalledOnce();
        expect(undici.fetch).not.toHaveBeenCalled();
    });

    it("goes through the proxy when set, and the guarded path is not used", async () => {
        process.env.CNPJ_EGRESS_PROXY_URL = PROXY;
        await defaultFetcher("https://receitaws.com.br/v1/cnpj/1");
        expect(undici.fetch).toHaveBeenCalledOnce();
        expect(guarded.guardedFetch).not.toHaveBeenCalled();
        await expect(defaultFetcher("https://example.com/")).rejects.toBeInstanceOf(EgressHostNotAllowedError);
        expect(undici.fetch).toHaveBeenCalledOnce();
    });
});
