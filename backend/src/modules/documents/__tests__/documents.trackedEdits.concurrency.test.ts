import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";

// Several people (or the app and an agent) writing the SAME document at once: accepting redlines, and
// rejecting one while another is accepted. Each write reads the active version, changes it and saves a new
// one. Without a guard, every writer reads the same base and the last to activate erases the others'.
// This models the document table with the one property that matters (a conditional UPDATE is atomic) and
// lets the writers interleave at every await.

type EditRow = {
    id: string;
    document_id: string;
    version_id: string;
    change_id: string;
    del_w_id: string | null;
    ins_w_id: string | null;
    find: string;
    status: string;
};
const world = vi.hoisted(() => ({
    current: "v0",
    versions: new Map<string, { id: string; storage_path: string; filename: string; version_number: number; deleted: boolean }>(),
    files: new Map<string, string>(),
    editRows: [] as unknown[],
    deletedVersions: [] as string[],
    deletedEditsFor: [] as string[],
    casAlwaysLoses: false,
    seq: 0,
}));
const rows = () => world.editRows as EditRow[];
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, Math.floor(Math.random() * 6)));

vi.mock("../../../lib/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/access")>()),
    ensureDocAccess: vi.fn(async () => ({ ok: true, isCreator: true, orgRole: null, projectRole: "editor" })),
}));
vi.mock("../../../lib/documentVersions", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/documentVersions")>()),
    contentSha256: () => "hash",
    loadActiveVersion: vi.fn(async () => {
        await tick();
        const v = world.versions.get(world.current)!;
        return { id: v.id, storage_path: v.storage_path, filename: v.filename, version_number: v.version_number, source: "assistant_edit" };
    }),
}));
vi.mock("../../../lib/storage", () => ({
    downloadFile: vi.fn(async (path: string) => {
        await tick();
        const buf = Buffer.from(world.files.get(path)!);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }),
    uploadFile: vi.fn(async (path: string, ab: ArrayBuffer) => {
        await tick();
        world.files.set(path, Buffer.from(ab).toString());
    }),
    deleteFileBestEffort: vi.fn(async () => undefined),
}));
// The document is the list of tracked changes so far, each written "|<find>". Applying one appends it;
// rejecting one removes ITS marker and leaves every other change alone; accepting keeps the text as it is.
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
    resolveTrackedChange: vi.fn(async (bytes: Buffer, ids: string[], mode: "accept" | "reject") => {
        await tick();
        const row = rows().find((r) => ids.includes(String(r.del_w_id)) || ids.includes(String(r.ins_w_id)));
        const text = bytes.toString();
        const marker = row ? `|${row.find}` : "";
        const out = mode === "reject" && marker && text.includes(marker) ? text.replace(marker, "") : text;
        return { bytes: Buffer.from(out), found: !!row };
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
import { resolveEdit } from "../documents.edits";

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
        const q: { op: string; payload?: any; filters: Record<string, unknown>; head?: boolean } = { op: "select", filters: {} };
        const run = async (): Promise<{ data: any; error: any; count?: number }> => {
            await tick();
            if (table === "documents" && q.op === "select")
                return { data: { id: "doc", current_version_id: world.current, user_id: "u", project_id: "p", org_id: null, workflow_id: null }, error: null };
            if (table === "user_profiles") return { data: { display_name: "Pessoa", email: "p@example.com" }, error: null };
            if (table === "document_versions" && q.op === "select") {
                const latest = [...world.versions.values()].sort((a, b) => b.version_number - a.version_number)[0];
                return { data: { filename: latest.filename, created_at: "now" }, error: null };
            }
            if (table === "document_edits" && q.op === "insert") {
                const inserted = (q.payload as any[]).map((r) => ({ ...r, id: `e${++world.seq}`, find: r.deleted_text, status: "pending" }));
                world.editRows.push(...inserted);
                return { data: inserted, error: null };
            }
            if (table === "document_edits" && q.op === "delete") {
                world.deletedEditsFor.push(String(q.filters.version_id));
                return { data: null, error: null };
            }
            if (table === "document_edits" && q.op === "select") {
                if (q.head) return { data: null, error: null, count: rows().filter((r) => r.status === "pending").length };
                const row = rows().find((r) => r.id === q.filters.id);
                return { data: row ? { ...row } : null, error: null };
            }
            if (table === "document_edits" && q.op === "update") {
                const row = rows().find((r) => r.id === q.filters.id);
                if (row) row.status = q.payload.status;
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
            select: (_cols?: string, opts?: { head?: boolean }) => ((q.head = !!opts?.head), b),
            order: () => b,
            limit: () => b,
            is: () => b,
            in: () => b,
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
const resolve = (db: Db, mode: "accept" | "reject", editId: string) => resolveEdit(mode, "doc", editId, "u", "p@example.com", db);
const activeText = () => world.files.get(world.versions.get(world.current)!.storage_path)!;
const markers = (text: string) => text.split("|").slice(1);
const editFor = (find: string) => rows().find((r) => r.find === find)!;

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
        const text = activeText();
        expect(text.startsWith("base")).toBe(true);
        for (const f of finds) expect(text).toContain(`|${f}`);
        expect(markers(text)).toHaveLength(count);
        const kept = new Set([...world.versions.values()].filter((v) => !v.deleted).map((v) => v.id));
        for (const r of results) if (r.ok) expect(kept.has(r.version_id)).toBe(true);
    });

    it("a writer that lost starts over from the winner's version, and discards what it had written", async () => {
        const db = fakeDb();
        await Promise.all([apply(db, "a"), apply(db, "b"), apply(db, "c")]);
        expect(world.deletedVersions.length).toBeGreaterThan(0);
        for (const id of world.deletedVersions) expect(world.deletedEditsFor).toContain(id);
        expect(world.deletedVersions).not.toContain(world.current);
    });

    it("never loses a decision in silence: after the retries it says so, and leaves nothing behind", async () => {
        world.casAlwaysLoses = true;
        const db = fakeDb();
        const result = await apply(db, "a");
        expect(result).toMatchObject({ ok: false, conflict: true });
        if (!result.ok) expect(result.error).toMatch(/Nothing was saved/);
        expect(world.deletedVersions).toHaveLength(6);
        expect(world.current).toBe("v0");
        expect(activeText()).toBe("base");
    });
});

describe("rejecting one tracked change while another is accepted", () => {
    // Two pending changes already in the document; the decisions arrive together.
    const seedTwo = async (db: Db) => {
        expect((await apply(db, "alfa")).ok).toBe(true);
        expect((await apply(db, "beta")).ok).toBe(true);
        expect(markers(activeText()).sort()).toEqual(["alfa", "beta"]);
    };

    it("a reject and an accepted redline at once: the reject removes ITS change and the new redline is still there", async () => {
        const db = fakeDb();
        await seedTwo(db);
        const [rejected, applied] = await Promise.all([resolve(db, "reject", editFor("alfa").id), apply(db, "gama")]);
        expect(rejected.ok).toBe(true);
        expect(applied.ok).toBe(true);
        // alfa was rejected (gone), beta untouched, gama (the redline accepted at the same time) kept.
        expect(markers(activeText()).sort()).toEqual(["beta", "gama"]);
        expect(editFor("alfa").status).toBe("rejected");
    });

    it.each([2, 3])("%i rejects and an accepted redline all at once: every reject lands and the redline survives", async (rejects) => {
        const db = fakeDb();
        await seedTwo(db);
        expect((await apply(db, "delta")).ok).toBe(true);
        const targets = ["alfa", "beta", "delta"].slice(0, rejects);
        const results = await Promise.all([...targets.map((f) => resolve(db, "reject", editFor(f).id)), apply(db, "gama")]);
        expect(results.every((r) => r.ok)).toBe(true);
        const left = markers(activeText());
        for (const f of targets) {
            expect(left).not.toContain(f);
            expect(editFor(f).status).toBe("rejected");
        }
        expect(left).toContain("gama");
        expect(left).toHaveLength(3 - rejects + 1);
    });

    it("an accept and a reject of different changes at once: the accept keeps its text and the reject removes only its own", async () => {
        const db = fakeDb();
        await seedTwo(db);
        const [accepted, rejected] = await Promise.all([resolve(db, "accept", editFor("alfa").id), resolve(db, "reject", editFor("beta").id)]);
        expect(accepted.ok && rejected.ok).toBe(true);
        expect(markers(activeText())).toEqual(["alfa"]);
        expect(editFor("alfa").status).toBe("accepted");
        expect(editFor("beta").status).toBe("rejected");
    });

    it("the same change resolved twice at once is applied once; the other call reports it already resolved", async () => {
        const db = fakeDb();
        await seedTwo(db);
        const id = editFor("alfa").id;
        const results = await Promise.all([resolve(db, "reject", id), resolve(db, "reject", id)]);
        expect(results.every((r) => r.ok)).toBe(true);
        expect(markers(activeText())).toEqual(["beta"]);
        expect(editFor("alfa").status).toBe("rejected");
    });

    it("says so when the reject loses every retry: 409, the change stays pending, nothing is activated", async () => {
        const db = fakeDb();
        await seedTwo(db);
        const before = world.current;
        world.casAlwaysLoses = true;
        const result = await resolve(db, "reject", editFor("alfa").id);
        expect(result).toMatchObject({ ok: false, status: 409 });
        expect(world.current).toBe(before);
        expect(editFor("alfa").status).toBe("pending");
        expect(markers(activeText()).sort()).toEqual(["alfa", "beta"]);
    });
});
