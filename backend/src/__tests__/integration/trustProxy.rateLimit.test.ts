import { describe, it, expect, vi } from "vitest";
import request from "supertest";

// The GKE deploys sit behind two proxies: the Google LB appends the client
// address to X-Forwarded-For, and the Next /api proxy forwards that header
// as-is from its own pod. TRUST_PROXY_HOPS=2 (deploy/gke/base/backend.yaml)
// makes req.ip the client instead of the LB, so the per-IP budget is per
// person, not one shared bucket for the whole team. Set before app.ts loads:
// it reads both values at import time.
vi.hoisted(() => {
    process.env.TRUST_PROXY_HOPS = "2";
    process.env.RATE_LIMIT_GENERAL_MAX = "2";
    process.env.SUPABASE_URL = "http://supabase.test.local";
    process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
    process.env.SUPABASE_SECRET_KEY = "test-service-key";
});

vi.mock("@supabase/supabase-js", () => ({
    createClient: vi.fn(() => ({
        auth: {
            getUser: () =>
                Promise.resolve({ data: { user: null }, error: null }),
        },
    })),
}));

import { app } from "../../app";

const LB = "35.191.10.20";

/** A request as the Next proxy sends it: the LB's "client, lb" header. */
function viaLb(xff: string) {
    return request(app).get("/health").set("X-Forwarded-For", xff);
}

describe("per-IP rate limit behind the LB and the Next proxy", () => {
    it("keys the limit on the client address, not the LB's", async () => {
        const a = `203.0.113.1, ${LB}`;
        expect((await viaLb(a)).status).toBe(200);
        expect((await viaLb(a)).status).toBe(200);
        expect((await viaLb(a)).status).toBe(429);

        // another person behind the same LB still has their own budget
        const b = await viaLb(`203.0.113.2, ${LB}`);
        expect(b.status).toBe(200);
        expect(b.headers["ratelimit-remaining"]).toBe("1");
    });

    it("ignores addresses the client itself put in X-Forwarded-For", async () => {
        // the LB appends; anything to the left of the client hop is forged
        const client = "203.0.113.3";
        expect((await viaLb(`198.51.100.1, ${client}, ${LB}`)).status).toBe(200);
        expect((await viaLb(`198.51.100.2, ${client}, ${LB}`)).status).toBe(200);
        expect((await viaLb(`198.51.100.3, ${client}, ${LB}`)).status).toBe(429);
    });
});
