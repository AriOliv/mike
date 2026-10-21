// A tiny in-memory stand-in for the supabase-js query builder, enough for
// the requests module's queries: select/insert/update/upsert/delete with
// eq/in/is/not/or/order/limit, single/maybeSingle, and named rpc handlers.
// The requests service reads in parallel, so a strict call script would test
// the order of reads; this tests what ends up in the tables instead.

import type { Db } from "../../../lib/supabase";

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

let seq = 0;
export const uuid = () => {
    seq += 1;
    return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
};

function parseOr(expr: string): Filter {
    const parts = expr.split(",").map((p) => {
        const [col, op, ...rest] = p.split(".");
        const value = rest.join(".");
        if (op !== "eq") throw new Error(`or: unsupported ${op}`);
        return (row: Row) => String(row[col]) === value;
    });
    return (row) => parts.some((f) => f(row));
}

export function memoryDb(
    seed: Record<string, Row[]> = {},
    options: {
        rpc?: Record<string, (args: Record<string, unknown>, tables: Record<string, Row[]>) => unknown>;
        defaults?: Record<string, () => Row>;
        fail?: (table: string, op: string) => unknown;
    } = {},
) {
    const tables: Record<string, Row[]> = {};
    for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }));
    const table = (name: string) => (tables[name] ??= []);

    const from = (name: string) => {
        let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
        let payload: Row | Row[] | null = null;
        let upsertOn: string[] = [];
        let ignoreDuplicates = false;
        const filters: Filter[] = [];
        let order: { col: string; asc: boolean } | null = null;
        let limit: number | null = null;
        let returning = false;

        const run = (): { data: unknown; error: unknown } => {
            const failed = options.fail?.(name, op);
            if (failed) return { data: null, error: failed };
            const rows = table(name);
            const match = (r: Row) => filters.every((f) => f(r));
            if (op === "insert" || op === "upsert") {
                const items = (Array.isArray(payload) ? payload : [payload]) as Row[];
                const out: Row[] = [];
                for (const item of items) {
                    if (op === "upsert") {
                        const existing = rows.find((r) => upsertOn.every((k) => r[k] === item[k]));
                        if (existing) {
                            if (!ignoreDuplicates) Object.assign(existing, item);
                            out.push(existing);
                            continue;
                        }
                    }
                    const unique = name === "legal_requests" ? "idempotency_key" : null;
                    if (unique && item[unique] && rows.some((r) => r[unique] === item[unique])) {
                        return { data: null, error: { code: "23505", message: "duplicate" } };
                    }
                    const row: Row = { ...(options.defaults?.[name]?.() ?? {}), id: uuid(), ...item };
                    rows.push(row);
                    out.push(row);
                }
                return { data: Array.isArray(payload) ? out : out[0], error: null };
            }
            if (op === "update") {
                const hit = rows.filter(match);
                for (const r of hit) Object.assign(r, payload);
                return { data: hit, error: null };
            }
            if (op === "delete") {
                const keep = rows.filter((r) => !match(r));
                const gone = rows.filter(match);
                tables[name] = keep;
                return { data: gone, error: null };
            }
            let out = rows.filter(match);
            if (order) {
                const { col, asc } = order;
                out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
            }
            if (limit !== null) out = out.slice(0, limit);
            return { data: out, error: null };
        };

        const single = (allowEmpty: boolean) => {
            const { data, error } = run();
            if (error) return Promise.resolve({ data: null, error });
            const list = Array.isArray(data) ? data : [data];
            if (list.length === 0) {
                return Promise.resolve(
                    allowEmpty ? { data: null, error: null } : { data: null, error: { code: "PGRST116" } },
                );
            }
            return Promise.resolve({ data: { ...list[0] }, error: null });
        };

        const b: Record<string, unknown> = {
            select: () => {
                if (op !== "select") returning = true;
                return b;
            },
            insert: (p: Row | Row[]) => ((op = "insert"), (payload = p), b),
            update: (p: Row) => ((op = "update"), (payload = p), b),
            upsert: (p: Row | Row[], o?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
                op = "upsert";
                payload = p;
                upsertOn = (o?.onConflict ?? "id").split(",");
                ignoreDuplicates = !!o?.ignoreDuplicates;
                return b;
            },
            delete: () => ((op = "delete"), b),
            eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
            in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
            is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
            not: (c: string, _op: string, v: unknown) => (filters.push((r) => (r[c] ?? null) !== v), b),
            or: (expr: string) => (filters.push(parseOr(expr)), b),
            order: (c: string, o?: { ascending?: boolean }) => ((order = { col: c, asc: o?.ascending !== false }), b),
            limit: (n: number) => ((limit = n), b),
            single: () => single(false),
            maybeSingle: () => single(true),
            then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
                void returning;
                return Promise.resolve(run()).then(resolve, reject);
            },
        };
        return b;
    };

    const rpc = (name: string, args: Record<string, unknown>) => {
        const handler = options.rpc?.[name];
        if (!handler) return Promise.resolve({ data: null, error: { message: `no rpc ${name}` } });
        try {
            return Promise.resolve({ data: handler(args, tables), error: null });
        } catch (error) {
            return Promise.resolve({ data: null, error });
        }
    };

    return { db: { from, rpc } as unknown as Db, tables, table };
}
