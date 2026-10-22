import { describe, it, expect, vi } from "vitest";
import request from "supertest";

// Hoisted: the app reads the limiter budget when it is imported.
vi.hoisted(() => {
    process.env.SUPABASE_URL = "http://supabase.test.local";
    process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
    process.env.SUPABASE_SECRET_KEY = "test-service-key";
    // A tiny shared budget: if /mcp spent it, the third call would be a 429.
    process.env.RATE_LIMIT_GENERAL_MAX = "2";
});

// No token row matches: every /mcp call is an unknown token.
vi.mock("@supabase/supabase-js", () => {
    const query: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "gt", "order", "limit"]) query[m] = () => query;
    query.maybeSingle = () => Promise.resolve({ data: null, error: null });
    return {
        createClient: vi.fn(() => ({
            from: () => query,
            auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
        })),
    };
});

import { app } from "../../app";

describe("/mcp in the app", () => {
    it("is mounted at the root and kept out of the shared per-IP budget", async () => {
        for (let i = 0; i < 4; i++) {
            const r = await request(app).post("/mcp").set("Authorization", "Bearer mike_pat_desconhecido").send({});
            expect(r.status).toBe(401);
        }
        // Control: any other path does spend the shared budget.
        const statuses = [];
        for (let i = 0; i < 3; i++) statuses.push((await request(app).get("/mcp-tokens")).status);
        expect(statuses).toContain(429);
    });

    it("refuses bodies over 1 MB", async () => {
        const r = await request(app)
            .post("/mcp")
            .set("Content-Type", "application/json")
            .send(JSON.stringify({ x: "a".repeat(1_100_000) }));
        expect(r.status).toBe(413);
    });
});
