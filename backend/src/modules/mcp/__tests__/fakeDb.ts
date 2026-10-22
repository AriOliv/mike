// A small table-backed stand-in for supabase-js, enough for the MCP module:
// select/insert/update with eq/is/gt, single/maybeSingle, head counts, and
// auth.admin.getUserById. Fictional data only.

import type { Db } from "../../../lib/supabase";

type Row = Record<string, unknown>;

export function fakeDb(
    seed: Record<string, Row[]> = {},
    users: Record<string, { email: string | null; email_confirmed_at: string | null; factors?: { factor_type: string; status: string }[] }> = {},
) {
    const tables: Record<string, Row[]> = {};
    for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }));
    let seq = 0;

    const from = (name: string) => {
        let op: "select" | "insert" | "update" = "select";
        let payload: Row | null = null;
        let head = false;
        const filters: Array<(r: Row) => boolean> = [];
        const rows = () => (tables[name] ??= []);
        const run = () => {
            const match = (r: Row) => filters.every((f) => f(r));
            if (op === "insert") {
                const row = { id: `00000000-0000-4000-9000-${String(++seq).padStart(12, "0")}`, created_at: "2026-10-21T12:00:00.000Z", revoked_at: null, last_used_at: null, last_client: null, ...payload };
                rows().push(row);
                return [row];
            }
            const hit = rows().filter(match);
            if (op === "update") for (const r of hit) Object.assign(r, payload);
            return hit;
        };
        const b: Record<string, unknown> = {
            select: (_cols?: string, opts?: { head?: boolean }) => {
                head = !!opts?.head;
                return b;
            },
            insert: (p: Row) => ((op = "insert"), (payload = p), b),
            update: (p: Row) => ((op = "update"), (payload = p), b),
            eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
            is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
            gt: (c: string, v: string) => (filters.push((r) => String(r[c]) > v), b),
            order: () => b,
            limit: () => b,
            single: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
            maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
            then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
                const out = run();
                return Promise.resolve(head ? { count: out.length, data: null, error: null } : { data: out, error: null }).then(res, rej);
            },
        };
        return b;
    };

    const db = {
        from,
        auth: {
            admin: {
                getUserById: (id: string) =>
                    Promise.resolve({ data: { user: users[id] ? { id, ...users[id] } : null }, error: null }),
            },
        },
    } as unknown as Db;
    return { db, tables };
}
