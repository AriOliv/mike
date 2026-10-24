// Tracked-change edits to a stored .docx: the edits become a new, active
// document version with one document_edits row per change, which the user
// later accepts or rejects. The assistant's edit_document tool and playbook
// reviews both write through here, so version creation stays in this module.

import crypto from "node:crypto";
import type { EditAnnotation } from "@mike/contracts";
import { can, ensureDocAccess } from "../../lib/access";
import { applyTrackedEdits, type EditInput } from "../../lib/docxTrackedChanges";
import { contentSha256, loadActiveVersion } from "../../lib/documentVersions";
import { buildDownloadUrl } from "../../lib/downloadTokens";
import { deleteFileBestEffort, downloadFile, uploadFile } from "../../lib/storage";
import type { Db } from "../../lib/supabase";
import { profileAttributionName } from "../../lib/userLookup";
import {
  activateDocumentVersion,
  activateDocumentVersionIfCurrent,
  createDocumentVersion,
  discardDocumentVersion,
  updateDocumentVersion,
} from "./documents.lifecycle";

/**
 * Resolve the current .docx bytes for a document, preferring the active
 * tracked-changes version if one exists, else the original upload.
 */
export async function loadCurrentVersionBytes(
  documentId: string,
  db: Db,
  versionId?: string | null,
): Promise<{ bytes: Buffer; storage_path: string } | null> {
  const active = await loadActiveVersion(documentId, db, versionId);
  if (!active) return null;
  const raw = await downloadFile(active.storage_path);
  if (!raw) return null;
  return { bytes: Buffer.from(raw), storage_path: active.storage_path };
}

type ApplyParams = {
  documentId: string;
  userId: string;
  /**
   * The caller's authenticated email, needed to resolve direct (email-keyed)
   * grants in the write check below. Without it only creator and
   * organization access count, which fails closed.
   */
  userEmail?: string | null;
  edits: EditInput[];
  db: Db;
  /** A long-running review must not apply suggestions to a newer document. */
  expectedVersion?: { id: string; storagePath: string };
  /**
   * If provided, append these edits to the existing turn-scoped version
   * (overwrites the file at storagePath and reuses the document_versions
   * row) instead of creating a new version. Used to collapse multiple
   * edit_document tool calls within a single assistant turn into one
   * version.
   */
  reuseVersion?: {
    versionId: string;
    versionNumber: number;
    storagePath: string;
  };
};

export type ApplyTrackedEditsResult =
  | {
      ok: true;
      version_id: string;
      version_number: number;
      storage_path: string;
      download_url: string;
      annotations: EditAnnotation[];
      errors: { index: number; reason: string }[];
    }
  | {
      ok: false;
      error: string;
      /**
       * Another write to the same document won the race and every retry lost
       * too. Nothing was saved: the caller must say so, never swallow it.
       */
      conflict?: true;
      /** The edit's `find` is not in the document (`not_found`) or is in it more than once (`ambiguous`). */
      reason?: "not_found" | "ambiguous";
    };

/** Tries, then retries on a lost race: the first attempt plus this many more. */
const MAX_CONFLICT_RETRIES = 5;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Applies tracked edits as a new active version of the document.
 *
 * Two writers on one document used to read the same active version and the
 * last to activate erased the other's edit. The write now activates only if
 * the version it started from is still the active one (see
 * `activateDocumentVersionIfCurrent`); the loser discards what it wrote and
 * starts over from the winner's version, so every edit lands on top of the
 * previous one. After MAX_CONFLICT_RETRIES lost races it returns `conflict`,
 * which is an error the person sees, not a silent loss.
 */
export async function applyTrackedEditsToDocument(params: ApplyParams): Promise<ApplyTrackedEditsResult> {
  for (let attempt = 0; ; attempt++) {
    const result = await applyOnce(params);
    if (result.ok || !result.conflict) return result;
    if (attempt >= MAX_CONFLICT_RETRIES)
      return {
        ok: false,
        conflict: true,
        error: "The document was changed by someone else at the same time. Nothing was saved; try again.",
      };
    // A little jitter so writers that collided do not collide again in step.
    await sleep(20 * (attempt + 1) + Math.floor(Math.random() * 30));
  }
}

/**
 * Writes `bytes` as a new, still INACTIVE version of the document (file + row), inheriting the filename of
 * the most recent version so renames carry forward. Activation is the caller's job: it must go through
 * `activateDocumentVersionIfCurrent`, so a write that lost a race can be discarded.
 */
export async function createInactiveVersion(
  db: Db,
  documentId: string,
  userId: string,
  bytes: Buffer,
): Promise<
  | { ok: true; versionRowId: string; versionNumber: number; storagePath: string; filename: string }
  | { ok: false; error: string }
> {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const versionId = crypto.randomUUID().replace(/-/g, "");
  const newPath = `documents/${userId}/${documentId}/edits/${versionId}.docx`;
  await uploadFile(newPath, ab, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const { data: prevRow } = await db
    .from("document_versions")
    .select("filename, created_at")
    .eq("document_id", documentId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const filename = (prevRow?.filename as string | null)?.trim() || "Untitled document";
  const { data: versionRow, error: verErr } = await createDocumentVersion(
    db,
    {
      document_id: documentId,
      storage_path: newPath,
      source: "assistant_edit",
      filename,
      file_type: "docx",
      size_bytes: bytes.byteLength,
      page_count: null,
      content_sha256: contentSha256(bytes),
    },
    { activate: false },
  );
  if (verErr || !versionRow) return { ok: false, error: "Failed to record document version." };
  return { ok: true, versionRowId: versionRow.id as string, versionNumber: versionRow.version_number, storagePath: newPath, filename };
}

async function applyOnce(params: ApplyParams): Promise<ApplyTrackedEditsResult> {
  const { documentId, userId, userEmail, edits, db, reuseVersion } = params;

  const { data: doc } = await db
    .from("documents")
    .select("id, user_id, project_id, org_id, workflow_id")
    .eq("id", documentId)
    .single();
  if (!doc) return { ok: false, error: "Document not found." };

  // The write is authorized against THIS document, not the turn. Whether a
  // turn may write at all (`allowDocumentMutation`) is decided from the
  // chat's container, but the chat's attachments can come from anywhere the
  // caller can read — a standalone chat, or a project chat that attached a
  // document from another project. Reading is not editing: a Viewer on the
  // document's project must not get a new active version through the
  // assistant when the version routes would refuse them.
  const access = await ensureDocAccess(
    doc as {
      user_id: string | null;
      project_id: string | null;
      org_id?: string | null;
      workflow_id?: string | null;
    },
    userId,
    userEmail,
    db,
  );
  if (!access.ok) return { ok: false, error: "Document not found." };
  if (!can(access.projectRole, "content.edit"))
    return {
      ok: false,
      error:
        "You do not have permission to edit this document. Use replicate_document to make an editable copy instead.",
    };

  const activeVersion = await loadActiveVersion(documentId, db);
  if (params.expectedVersion && (
    activeVersion?.id !== params.expectedVersion.id ||
    activeVersion.storage_path !== params.expectedVersion.storagePath
  )) {
    return { ok: false, error: "This document changed. Run the review again before applying its suggestions." };
  }
  let versionFilename =
    activeVersion?.filename?.trim() || "Untitled document";

  const raw = activeVersion ? await downloadFile(activeVersion.storage_path) : null;
  if (!raw || !activeVersion) return { ok: false, error: "Could not load document bytes." };
  const current = { bytes: Buffer.from(raw), storage_path: activeVersion.storage_path };

  const { data: authorProfile } = await db
    .from("user_profiles")
    .select("display_name, email")
    .eq("user_id", userId)
    .maybeSingle();
  const author = profileAttributionName(authorProfile, "Mike");

  const {
    bytes: editedBytes,
    changes,
    errors,
  } = await applyTrackedEdits(current.bytes, edits, { author });

  if (changes.length === 0) {
    return {
      ok: false,
      error:
        errors[0]?.reason ??
        "No edits could be applied. Refine context_before/context_after and retry.",
      ...(errors[0]?.code && { reason: errors[0].code }),
    };
  }

  const ab = editedBytes.buffer.slice(
    editedBytes.byteOffset,
    editedBytes.byteOffset + editedBytes.byteLength,
  ) as ArrayBuffer;

  let versionRowId: string;
  let newPath: string;
  let nextVersionNumber: number;

  if (reuseVersion) {
    // Reuse the version number, but never overwrite bytes an extraction job
    // may be reading. Publish the new path/hash together after storage succeeds.
    if (activeVersion?.id !== reuseVersion.versionId || current.storage_path !== reuseVersion.storagePath) {
      return { ok: false, error: "This document changed. Read the latest version and try again." };
    }
    newPath = `documents/${userId}/${documentId}/edits/${crypto.randomUUID().replace(/-/g, "")}.docx`;
    versionRowId = reuseVersion.versionId;
    nextVersionNumber = reuseVersion.versionNumber;

    await uploadFile(newPath, ab, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const updated = await updateDocumentVersion(db, documentId, versionRowId, {
      storage_path: newPath,
      file_type: "docx", size_bytes: editedBytes.byteLength, page_count: null,
      content_sha256: contentSha256(editedBytes), pdf_storage_path: null,
    }, { expectedStoragePath: reuseVersion.storagePath });
    if (updated.error || !updated.data) {
      // A transport/database error may arrive after the update committed. Only
      // an acknowledged no-row result proves this new object is unreferenced;
      // deleting it on an ambiguous failure could destroy the saved document.
      if (!updated.error) await deleteFileBestEffort(newPath, "assistant-edit-conflict");
      return { ok: false, error: "Failed to update document version. Read the latest version and try again." };
    }
  } else {
    const created = await createInactiveVersion(db, documentId, userId, editedBytes);
    if (!created.ok) return { ok: false, error: created.error };
    versionRowId = created.versionRowId;
    nextVersionNumber = created.versionNumber;
    newPath = created.storagePath;
    versionFilename = created.filename;
  }

  // Insert one row per change
  const editRows = changes.map((c) => ({
    document_id: documentId,
    version_id: versionRowId,
    change_id: c.id,
    del_w_id: c.delId ?? null,
    ins_w_id: c.insId ?? null,
    deleted_text: c.deletedText,
    inserted_text: c.insertedText,
    context_before: c.contextBefore ?? "",
    context_after: c.contextAfter ?? "",
    status: "pending" as const,
  }));
  const { data: insertedEdits, error: editsErr } = await db
    .from("document_edits")
    .insert(editRows)
    .select(
      "id, change_id, del_w_id, ins_w_id, deleted_text, inserted_text, context_before, context_after",
    );

  if (editsErr || !insertedEdits) {
    return { ok: false, error: "Failed to record edits." };
  }

  // A turn-scoped reuse rewrote the active version in place, and that write is already
  // serialized by its own expectedStoragePath check. A NEW version must become active only
  // if nobody activated another one since we read this document.
  if (reuseVersion) {
    const activation = await activateDocumentVersion(db, documentId, versionRowId);
    if (activation.error || !activation.activated) {
      return { ok: false, error: "Failed to activate document version." };
    }
  } else {
    const activation = await activateDocumentVersionIfCurrent(db, documentId, versionRowId, activeVersion.id);
    if (activation.error) return { ok: false, error: "Failed to activate document version." };
    if (!activation.activated) {
      // Lost the race: another write activated a version after we read ours.
      // Discard this one (its edit rows, its row, its file) and let the caller start over.
      await db.from("document_edits").delete().eq("version_id", versionRowId);
      await discardDocumentVersion(db, documentId, versionRowId, userId);
      return { ok: false, error: "Document changed during the edit.", conflict: true };
    }
  }

  const annotations: EditAnnotation[] = insertedEdits.map(
    (r: {
      id: string;
      change_id: string;
      deleted_text: string;
      inserted_text: string;
      context_before: string | null;
      context_after: string | null;
    }) => {
      const src = changes.find((c) => c.id === r.change_id);
      return {
        kind: "edit",
        edit_id: r.id,
        document_id: documentId,
        version_id: versionRowId,
        version_number: nextVersionNumber,
        change_id: r.change_id,
        del_w_id: src?.delId,
        ins_w_id: src?.insId,
        deleted_text: r.deleted_text ?? "",
        inserted_text: r.inserted_text ?? "",
        context_before: r.context_before ?? "",
        context_after: r.context_after ?? "",
        reason: src?.reason,
        status: "pending",
      };
    },
  );

  // Persistent, non-expiring permalink. The backend streams fresh bytes
  // on each request, so this URL stays valid as long as the file exists.
  const resolvedFilename = versionFilename.trim() || "Untitled document.docx";
  const permalink = buildDownloadUrl(newPath, resolvedFilename);

  return {
    ok: true,
    version_id: versionRowId,
    version_number: nextVersionNumber,
    storage_path: newPath,
    download_url: permalink,
    annotations,
    errors,
  };
}
