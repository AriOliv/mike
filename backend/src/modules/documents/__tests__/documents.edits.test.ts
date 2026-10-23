import { afterEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const storage = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
  deleteFileBestEffort: vi.fn(),
  versionStorageKey: (_user: string, _doc: string, slug: string) => `new/${slug}.docx`,
  assertStorageConfigured: vi.fn(),
}));
const dbq = vi.hoisted(() => ({
  enqueueStorageCleanup: vi.fn(),
  requestDocumentCleanupDelivery: vi.fn(),
}));
const docx = vi.hoisted(() => ({ resolveTrackedChange: vi.fn() }));
const access = vi.hoisted(() => ({ ensureDocAccess: vi.fn() }));

vi.mock("../../../lib/storage", () => ({
  ...storage,
  extractedTextKey: (id: string) => `extracted-text/${id}.txt`,
}));
vi.mock("../../../lib/dbq/enqueue", () => dbq);
vi.mock("../../../lib/docxTrackedChanges", () => docx);
vi.mock("../../../lib/access", () => access);
vi.mock("../../../lib/permissions", () => ({ can: () => true }));
vi.mock("../../../lib/downloadTokens", () => ({
  buildDownloadUrl: () => "https://example.test/download",
}));
vi.mock("../../../lib/documentVersions", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadActiveVersion: vi.fn(async () => ({
    id: "v1",
    storage_path: "docs/v1.docx",
    filename: "Clause.docx",
    version_number: 2,
    source: "assistant_edit",
  })),
}));

import { resolveEdit } from "../documents.edits";

const PENDING_EDIT = {
  id: "edit-1",
  document_id: "doc-1",
  change_id: "c1",
  del_w_id: "w-del",
  ins_w_id: "w-ins",
  status: "pending",
};
const DOC = {
  id: "doc-1",
  current_version_id: "v1",
  user_id: "user-1",
  project_id: null,
  org_id: null,
  workflow_id: null,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function arrange() {
  storage.downloadFile.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
  storage.uploadFile.mockResolvedValue(undefined);
  storage.deleteFile.mockResolvedValue(undefined);
  dbq.requestDocumentCleanupDelivery.mockResolvedValue(0);
  docx.resolveTrackedChange.mockResolvedValue({
    bytes: new Uint8Array([9, 9, 9]),
    found: true,
  });
  access.ensureDocAccess.mockResolvedValue({ ok: true, projectRole: "owner" });
}

const run = (db: Parameters<typeof resolveEdit>[5]) =>
  resolveEdit("accept", "doc-1", "edit-1", "user-1", "u@example.test", db);

// resolveEdit saves the resolved bytes as a NEW version and activates it only if the version it read is still
// the active one. Each case scripts that sequence: read edit, read document, (inline text/cleanup reads),
// the new version's lookup of the previous filename, the activation, then the edit's status.
const versionRpc = (over: Partial<Record<string, unknown>> = {}) =>
  vi.fn(async (name: string, _args?: Record<string, unknown>) => {
    if (name in over) return over[name];
    if (name === "create_document_version") return { data: { id: "v2", version_number: 3 }, error: null };
    if (name === "delete_document_version") return { data: { deleted_version_id: "v2" }, error: null };
    return { data: null, error: null };
  });

describe("resolving a tracked edit", () => {
  it("saves the resolved bytes as a new version and activates it only if the one it read is still active", async () => {
    arrange();
    const fake = scriptedDb([
      { table: "document_edits", data: PENDING_EDIT },
      { table: "documents", data: DOC },
      { table: "document_versions", data: { filename: "Clause.docx" } },
      { table: "documents", op: "update", data: { id: "doc-1" } },
      { table: "document_edits", op: "update" },
      { table: "document_edits", data: [] },
    ]);
    const rpc = versionRpc();
    const result = await run({ ...fake.db, rpc } as never);
    expect(result).toMatchObject({ ok: true, body: { version_id: "v2" } });
    // The old version is NOT rewritten in place any more.
    expect(fake.calls.some((call) => call.table === "document_versions" && call.op === "update")).toBe(false);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_activate: false });
    const swap = fake.calls.find((call) => call.table === "documents" && call.op === "update")!;
    expect(swap.payload).toMatchObject({ current_version_id: "v2" });
    expect(swap.filters).toContainEqual(["eq", "current_version_id", "v1"]);
    fake.done();
  });

  it("loses the race to another write: discards its version and starts over, then succeeds on the winner's version", async () => {
    arrange();
    const fake = scriptedDb([
      // attempt 1: someone activated another version first, so the swap matches nothing
      { table: "document_edits", data: PENDING_EDIT },
      { table: "documents", data: DOC },
      { table: "document_versions", data: { filename: "Clause.docx" } },
      { table: "documents", op: "update", data: null },
      // attempt 2: re-reads everything and wins
      { table: "document_edits", data: PENDING_EDIT },
      { table: "documents", data: DOC },
      { table: "document_versions", data: { filename: "Clause.docx" } },
      { table: "documents", op: "update", data: { id: "doc-1" } },
      { table: "document_edits", op: "update" },
      { table: "document_edits", data: [] },
    ]);
    const rpc = versionRpc();
    expect((await run({ ...fake.db, rpc } as never)).ok).toBe(true);
    expect(rpc.mock.calls.map((call) => call[0])).toEqual(["create_document_version", "delete_document_version", "create_document_version"]);
    fake.done();
  });

  it("says so when every retry loses: a 409, nothing activated, and each discarded version is retired", async () => {
    arrange();
    const lost = [
      { table: "document_edits", data: PENDING_EDIT },
      { table: "documents", data: DOC },
      { table: "document_versions", data: { filename: "Clause.docx" } },
      { table: "documents", op: "update", data: null },
    ];
    const fake = scriptedDb(Array.from({ length: 6 }, () => lost).flat());
    const rpc = versionRpc();
    expect(await run({ ...fake.db, rpc } as never)).toMatchObject({ ok: false, status: 409 });
    expect(rpc.mock.calls.filter((call) => call[0] === "delete_document_version")).toHaveLength(6);
    expect(fake.calls.some((call) => call.table === "document_edits" && call.op === "update")).toBe(false);
    fake.done();
  });

  it("keeps the active version intact on a database failure while saving the new one", async () => {
    arrange();
    const fake = scriptedDb([
      { table: "document_edits", data: PENDING_EDIT },
      { table: "documents", data: DOC },
      { table: "document_versions", data: { filename: "Clause.docx" } },
    ]);
    const rpc = versionRpc({ create_document_version: { data: null, error: { message: "write failed" } } });
    expect(await run({ ...fake.db, rpc } as never)).toMatchObject({ ok: false, detail: "Failed to resolve edit" });
    expect(fake.calls.some((call) => call.table === "documents" && call.op === "update")).toBe(false);
    fake.done();
  });
});
