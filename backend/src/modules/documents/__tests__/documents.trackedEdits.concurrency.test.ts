import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";

// Several people (or the app and an agent) accepting redlines on the SAME
// document at once. Each write reads the active version, edits it and saves a
// new one. Without a guard, every writer reads the same base and the last to
// activate erases the others' edits. This models the document table with the
// one property that matters (a conditional UPDATE is atomic) and lets the
// writers interleave at every await.

const world = vi.hoisted(() => ({
    current: "v0",
    versions: new Map<string, { id: string; storage_path: string; filename: string; version_number: number; deleted: boolean }>(),
    files: new Map<string, string>(),
    editRows: [] as { id: string; version_id: string; change_id: string }[],
    deletedVersions: [] as string[],
    deletedEditsFor: [] as string[],
    casAlwaysLoses: false,
    seq: 0,
}));
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, Math.floor(Math.random() * 6)));

vi.mock("../../../lib/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/access")>()),
    ensureDocAccess: vi.fn(async () => ({ ok: true, isCreator: true, orgRole: null, projectRole: "editor" })),
}));
vi.mock("../../../lib/documentVersions", () => ({
    contentSha256: () => "hash",
    loadActiveVersion: vi.fn(async () => {
        await tick();
        const v = world.versions.get(world.current)!;
        return { id: v.id, storage_path: v.storage_path, filename: v.filename, version_number: v.version_number };
    }),
}));
vi.mock("../../../lib/storage", () => ({
    downloadFile: vi.fn(async (path: string) => {
        await tick();
        const text = world.files.get(path)!;
        const buf = Buffer.from(text);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }),
    uploadFile: vi.fn(async (path: string, ab: ArrayBuffer) => {
        await tick();
        world.files.set(path, Buffer.from(ab).toString());
    }),
    deleteFileBestEffort: vi.fn(async () => undefined),
}));
// The "document" is the list of edits applied so far; applying one appends it.
vi.mock("../../../lib/docxTrackedChanges", () => ({
    applyTrackedEdits: vi.fn(async (bytes: Buffer, edits: { find: string }[]) => {
        await tick();
        const n = ++world.seq;
        return {
            bytes: Buffer.from(`${bytes.toString()}|${edits[0].find}`),
            changes: [{ id: `c${n}`, delId: `d${n}`, insId: `i${n}`, deletedText: edits[0].find, insertedText: "x", reason: "r" }],
            errors: [],
        };
    }),
}));
vi.mock("../../../lib/downloadTokens", () => ({ buildDownloadUrl: (p: string) => `download:${p}` }));
vi.mock("../documents.indexing", () => ({ processDocumentTextInline: vi.fn(async () => undefined) }));
vi.mock("../documents.cleanupJobs", () => ({
    captureInlineVersionUpdateCleanup: vi.fn(async () => []),
    captureInlineDocumentCleanup: vi.fn(async () => []),
    completeInlineDocumentCleanup: vi.fn(async () => undefined),
}));

import { applyTrackedEditsToDocument } from "../documents.trackedEdits";

function fakeDb(): Db {
    const rpc = async (name: string, args: Record<string, any>) => {
        await tick();
        if (name === "create_document_version") {
            const id = `v${++world.seq}x`;
            const number = Math.max(...[...world.versions.values()].map((v) => v.version_number)) + 1;
            world.versions.set(id, { id, storage_path: args.p_version.storage_path, filename: args.p_version.filename, version_number: number, deleted: false });
            return { data: { id, version_number: number }, error: null };
        }
        if (name === "delete_document_version") {
            world.deletedVersions.push(args.p_version_id);
            world.versions.get(args.p_version_id)!.deleted = true;
            return { data: { deleted_version_id: args.p_version_id }, error: null };
        }
        throw new Error(`unexpected rpc ${name}`);
    };
    const from = (table: string) => {
        const q: { op: string; payload?: any; filters: Record<string, unknown> } = { op: "select", filters: {} };
        const run = async (): Promise<{ data: any; error: any }> => {
            await tick();
            if (table === "documents" && q.op === "select") return { data: { id: "doc", user_id: "u", project_id: "p", org_id: null, workflow_id: null }, error: null };
            if (table === "user_profiles") return { data: { display_name: "Pessoa", email: "p@example.com" }, error: null };
            if (table === "document_versions" && q.op === "select") {
                const latest = [...world.versions.values()].sort((a, b) => b.version_number - a.version_number)[0];
                return { data: { filename: latest.filename, created_at: "now" }, error: null };
            }
            if (table === "document_edits" && q.op === "insert") {
                const rows = (q.payload as any[]).map((r) => ({ ...r, id: `e${++world.seq}` }));
                world.editRows.push(...rows);
                return { data: rows, error: null };
            }
            if (table === "document_edits" && q.op === "delete") {
                world.deletedEditsFor.push(String(q.filters.version_id));
                return { data: null, error: null };
            }
            if (table === "documents" && q.op === "update") {
                // The conditional UPDATE: one atomic step, so exactly one writer per base can win.
                if (world.casAlwaysLoses || world.current !== q.filters.current_version_id) return { data: null, error: null };
                world.current = q.payload.current_version_id;
                return { data: { id: "doc" }, error: null };
            }
            throw new Error(`unexpected ${q.op} on ${table}`);
        };
        const b: any = {
            select: () => b,
            order: () => b,
            limit: () => b,
            is: () => b,
            eq: (k: string, v: unknown) => ((q.filters[k] = v), b),
            insert: (p: unknown) => ((q.op = "insert"), (q.payload = p), b),
            update: (p: unknown) => ((q.op = "update"), (q.payload = p), b),
            delete: () => ((q.op = "delete"), b),
            single: run,
            maybeSingle: run,
            then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => run().then(res, rej),
        };
        return b;
    };
    return { from, rpc } as unknown as Db;
}

const apply = (db: Db, find: string) =>
    applyTrackedEditsToDocument({ documentId: "doc", userId: "u", userEmail: "p@example.com", db, edits: [{ find, replace: "novo", context_before: "", context_after: "", reason: "r" }] });
const activeText = () => world.files.get(world.versions.get(world.current)!.storage_path)!;

beforeEach(() => {
    world.current = "v0";
    world.versions = new Map([["v0", { id: "v0", storage_path: "docs/v0.docx", filename: "Contrato.docx", version_number: 1, deleted: false }]]);
    world.files = new Map([["docs/v0.docx", "base"]]);
    world.editRows = [];
    world.deletedVersions = [];
    world.deletedEditsFor = [];
    world.casAlwaysLoses = false;
    world.seq = 0;
});

describe("tracked edits written at the same time to one document", () => {
    it.each([2, 3, 5])("keeps all %i concurrent decisions: none erases another", async (count) => {
        const db = fakeDb();
        const finds = Array.from({ length: count }, (_, i) => `clausula-${i + 1}`);
        const results = await Promise.all(finds.map((f) => apply(db, f)));
        expect(results.every((r) => r.ok)).toBe(true);
        // The active document carries every edit, in some order, on top of the base.
        const text = activeText();
        expect(text.startsWith("base")).toBe(true);
        for (const f of finds) expect(text).toContain(`|${f}`);
        expect(text.split("|").length - 1).toBe(count);
        // Each decision's edit rows belong to a version that was kept, not discarded.
        const kept = new Set([...world.versions.values()].filter((v) => !v.deleted).map((v) => v.id));
        for (const r of results) if (r.ok) expect(kept.has(r.version_id)).toBe(true);
    });

    it("a writer that lost starts over from the winner's version, and discards what it had written", async () => {
        const db = fakeDb();
        await Promise.all([apply(db, "a"), apply(db, "b"), apply(db, "c")]);
        // Losers wrote a version and edit rows first, then threw them away.
        expect(world.deletedVersions.length).toBeGreaterThan(0);
        for (const id of world.deletedVersions) expect(world.deletedEditsFor).toContain(id);
        // The discarded versions are never the active one.
        expect(world.deletedVersions).not.toContain(world.current);
    });

    it("never loses a decision in silence: after the retries it says so, and leaves nothing behind", async () => {
        world.casAlwaysLoses = true;
        const db = fakeDb();
        const result = await apply(db, "a");
        expect(result).toMatchObject({ ok: false, conflict: true });
        if (!result.ok) expect(result.error).toMatch(/Nothing was saved/);
        // 1 try + 5 retries, each one discarded.
        expect(world.deletedVersions).toHaveLength(6);
        expect(world.current).toBe("v0");
        expect(activeText()).toBe("base");
    });
});
