import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// card_events is append-only, but deleting a card cascades to its events
// (20261022_97). Only real Postgres runs the FK cascade through the trigger,
// so a mock proves nothing. Run with backend/scripts/test-stack.sh.
const url = process.env.SUPABASE_TEST_URL;
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const maybeDescribe = url && serviceKey ? describe : describe.skip;

maybeDescribe("card_events and card deletion", () => {
    let db: SupabaseClient;
    let owner = "";
    const projects: string[] = [];

    const card = async () => {
        const id = randomUUID();
        expect((await db.from("projects").insert({
            id, user_id: owner, name: "Synthetic card",
        })).error).toBeNull();
        projects.push(id);
        expect((await db.from("card_events").insert([
            { project_id: id, actor_type: "user", actor_id: owner, action: "request.created" },
            { project_id: id, actor_type: "system", actor_id: "cron:vigia", action: "lane.changed" },
        ])).error).toBeNull();
        return id;
    };
    const events = async (projectId: string) => {
        const { data, error } = await db.from("card_events").select("id").eq("project_id", projectId);
        expect(error).toBeNull();
        return data!.length;
    };

    beforeAll(async () => {
        db = createClient(url!, serviceKey!, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
        const u = await db.auth.admin.createUser({
            email: `card-events-${randomUUID()}@test.local`, email_confirm: true,
        });
        if (u.error || !u.data.user) throw u.error ?? new Error("No owner");
        owner = u.data.user.id;
    }, 30_000);

    afterAll(async () => {
        if (!db) return;
        if (projects.length) expect((await db.from("projects").delete().in("id", projects)).error).toBeNull();
        if (owner) expect((await db.auth.admin.deleteUser(owner)).error).toBeNull();
    });

    it("deletes a card that has events, and its events with it", async () => {
        const id = await card();
        expect(await events(id)).toBe(2);
        expect((await db.from("projects").delete().eq("id", id)).error).toBeNull();
        expect(await events(id)).toBe(0);
    });

    it("still refuses to change or delete the events of a live card", async () => {
        const id = await card();
        expect((await db.from("card_events").update({ action: "x" }).eq("project_id", id)).error).not.toBeNull();
        expect((await db.from("card_events").delete().eq("project_id", id)).error).not.toBeNull();
        expect(await events(id)).toBe(2);
    });
});
