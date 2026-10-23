import { processDocumentTextInline } from "./documents.indexing";
import { safeError } from "../../lib/safeError";
import { logError } from "../../lib/log";
import {
  captureInlineDocumentCleanup,
  captureInlineVersionUpdateCleanup,
  completeInlineDocumentCleanup,
} from "./documents.cleanupJobs";
import { type Db } from "../../lib/supabase";

export type NewDocumentVersion = {
  id?: string;
  document_id: string;
  storage_path: string;
  pdf_storage_path?: string | null;
  source: string;
  version_number?: number | null;
  filename: string;
  file_type?: string | null;
  size_bytes?: number | null;
  page_count?: number | null;
  textless_page_count?: number | null;
  content_sha256?: string | null;
};

export type DocumentVersionRecord = NewDocumentVersion & {
  id: string;
  version_number: number;
  created_at: string;
  deleted_at: string | null;
};

/**
 * Trusted persistence operation. The caller must authorize the destination
 * (and independently authorize any copy source). Upload workers use their
 * validated session destination; chat tools use their authorized document
 * store. Number allocation, insertion and activation share one transaction.
 * A stable id makes retries idempotent without overwriting newer work.
 */
export async function createDocumentVersion(
  db: Db,
  version: NewDocumentVersion,
  options: { activate?: boolean } = {},
) {
  const { document_id, ...metadata } = version;
  const { data, error } = await db.rpc("create_document_version", {
    p_document_id: document_id,
    p_version: metadata,
    p_activate: options.activate !== false,
  });
  if (!error && data?.id) await processDocumentTextInline(db, [data.id]).catch((err) => logError("document-text", safeError(err)));
  return { data: data as DocumentVersionRecord | null, error };
}

/** All versions and active pointers commit together, or none do. */
export async function createDocumentVersions(
  db: Db,
  versions: NewDocumentVersion[],
) {
  const { data, error } = await db.rpc("create_document_versions", {
    p_versions: versions,
  });
  if (!error && data?.length) await processDocumentTextInline(db, data.map((row: DocumentVersionRecord) => row.id)).catch((err) => logError("document-text", safeError(err)));
  return { data: data as DocumentVersionRecord[] | null, error };
}

/** Call after dependent edit rows are persisted. Reject stale/deleted targets. */
export async function activateDocumentVersion(
  db: Db,
  documentId: string,
  versionId: string,
) {
  const { data, error } = await db.rpc("activate_document_version", {
    p_document_id: documentId,
    p_version_id: versionId,
  });
  return { activated: data === true, error };
}

/**
 * Compare-and-swap activation: `versionId` becomes the active version only if
 * `expectedCurrentId` still is. One conditional UPDATE, so two writers that
 * read the same active version cannot both win: Postgres makes the second
 * wait for the row and re-checks the condition against the committed value.
 * `activated: false` with no error means somebody else activated first.
 */
export async function activateDocumentVersionIfCurrent(
  db: Db,
  documentId: string,
  versionId: string,
  expectedCurrentId: string,
) {
  const { data, error } = await db
    .from("documents")
    .update({ current_version_id: versionId, updated_at: new Date().toISOString() })
    .eq("id", documentId)
    .eq("current_version_id", expectedCurrentId)
    .select("id")
    .maybeSingle();
  return { activated: !error && !!data, error };
}

/**
 * Throws away a version that was written but lost its race: the row is
 * retired through the lifecycle RPC (which queues its file for cleanup) and
 * never becomes active. Best effort: a failure here leaves an inactive
 * version behind, which is untidy but loses nothing.
 */
export async function discardDocumentVersion(
  db: Db,
  documentId: string,
  versionId: string,
  actorId: string,
): Promise<void> {
  try {
    const keys = await captureInlineDocumentCleanup(db, { versionIds: [versionId] });
    const { error } = await db.rpc("delete_document_version", {
      p_document_id: documentId,
      p_version_id: versionId,
      p_actor_id: actorId,
    });
    if (error) throw error;
    await completeInlineDocumentCleanup(db, keys);
  } catch (err) {
    logError("document-version-discard", safeError(err));
  }
}

export type DocumentVersionPatch = Partial<
  Omit<NewDocumentVersion, "id" | "document_id" | "source" | "version_number">
> & {
  content_sha256?: string | null;
  created_at?: string;
};

/** Only live versions within the authorized document can be replaced. */
export async function updateDocumentVersion(
  db: Db,
  documentId: string,
  versionId: string,
  patch: DocumentVersionPatch,
  options: { expectedStoragePath?: string; expectedContentSha256?: string | null } = {},
) {
  const keys = await captureInlineVersionUpdateCleanup(
    db,
    documentId,
    versionId,
    patch,
  );
  let query = db
    .from("document_versions")
    .update(patch)
    .eq("id", versionId)
    .eq("document_id", documentId)
    .is("deleted_at", null);
  if (options.expectedStoragePath !== undefined)
    query = query.eq("storage_path", options.expectedStoragePath);
  if (options.expectedContentSha256 !== undefined)
    query = options.expectedContentSha256 === null
      ? query.is("content_sha256", null)
      : query.eq("content_sha256", options.expectedContentSha256);
  const result = await query
    .select(
      "id, version_number, source, created_at, filename, file_type, size_bytes, page_count, textless_page_count",
    )
    .maybeSingle();
  if (!result.error && result.data)
    await completeInlineDocumentCleanup(db, keys);
  if (!result.error && result.data && ("storage_path" in patch || "content_sha256" in patch || "file_type" in patch)) await processDocumentTextInline(db, [versionId]).catch((err) => logError("document-text", safeError(err)));
  return result;
}
