// Tracked-change (assistant edit) operations: accepting / rejecting an
// individual edit in the active DOCX.

import { downloadFile } from "../../lib/storage";
import { resolveTrackedChange } from "../../lib/docxTrackedChanges";
import { buildDownloadUrl } from "../../lib/downloadTokens";
import { loadActiveVersion } from "../../lib/documentVersions";
import { ensureDocAccess } from "../../lib/access";
import { can, DOCUMENT_EDIT_FORBIDDEN } from "../../lib/permissions";
import { downloadFilenameForVersion, type Db } from "./documents.shared";
import { activateDocumentVersionIfCurrent, discardDocumentVersion } from "./documents.lifecycle";
import { createInactiveVersion } from "./documents.trackedEdits";
// devLog comes from lib/chat/types (a leaf file — importing the whole chat
// barrel here just for a logger would be a heavy dependency edge).
import { devLog } from "../../lib/log";

// ---------------------------------------------------------------------------
// Accept / reject a tracked-change edit
// ---------------------------------------------------------------------------

/** The edit was not resolved because another write to the document won every retry. Nothing was saved. */
export const DOCUMENT_BUSY = "document_busy";
export const DOCUMENT_BUSY_DETAIL = "O contrato foi alterado por outra pessoa ao mesmo tempo. Sua decisão não foi gravada; tente de novo.";

type ResolveResult =
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; detail: string; status?: number; error?: unknown; code?: typeof DOCUMENT_BUSY };

/** The first attempt plus this many more when another write to the document wins the race. */
const MAX_CONFLICT_RETRIES = 5;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Accepts or rejects one tracked change. The resolved bytes are saved as a NEW version of the document and
 * activated only if the version they were read from is still the active one (the same compare-and-swap an
 * accepted redline goes through, `applyTrackedEditsToDocument`). Resolving in place used to let a reject and
 * an accepted redline run at once without seeing each other: the one that activated last erased the other.
 * A write that loses discards what it saved and starts again from the winner's version, re-reading the edit
 * (so a second resolve of the same edit reports it as already resolved); it is never lost in silence.
 */
export async function resolveEdit(
    mode: "accept" | "reject",
    documentId: string,
    editId: string,
    userId: string,
    userEmail: string | undefined,
    db: Db,
): Promise<ResolveResult> {
    for (let attempt = 0; ; attempt++) {
        const result = await resolveOnce(mode, documentId, editId, userId, userEmail, db);
        if (result.ok || !("conflict" in result)) return result;
        if (attempt >= MAX_CONFLICT_RETRIES)
            return { ok: false, status: 409, code: DOCUMENT_BUSY, detail: DOCUMENT_BUSY_DETAIL };
        await sleep(20 * (attempt + 1) + Math.floor(Math.random() * 30));
    }
}

async function resolveOnce(
    mode: "accept" | "reject",
    documentId: string,
    editId: string,
    userId: string,
    userEmail: string | undefined,
    db: Db,
): Promise<ResolveResult | { ok: false; conflict: true }> {
    devLog(`[edit-resolution] incoming ${mode}`, {
        userId,
        documentId,
        editId,
    });

    const { data: edit, error: editErr } = await db
        .from("document_edits")
        .select("id, document_id, change_id, del_w_id, ins_w_id, status")
        .eq("id", editId)
        .eq("document_id", documentId)
        .single();
    devLog(`[edit-resolution] fetched edit row`, { edit, editErr });
    if (!edit) {
        devLog(`[edit-resolution] edit not found, returning 404`);
        return { ok: false, detail: "Edit not found" };
    }
    // Idempotent: if the edit is already resolved, return the current doc
    // state so stale UI (e.g. an old chat reloaded in a new session) can
    // reconcile without throwing.
    if (edit.status !== "pending") {
        devLog(`[edit-resolution] edit already resolved`, {
            editId,
            status: edit.status,
        });
        const { data: doc } = await db
            .from("documents")
            .select("current_version_id, user_id, project_id, org_id, workflow_id")
            .eq("id", documentId)
            .single();
        if (!doc) {
            devLog(`[edit-resolution] doc not found for resolved edit`);
            return { ok: false, detail: "Document not found" };
        }
        const accessResolved = await ensureDocAccess(doc, userId, userEmail, db);
        if (!accessResolved.ok) {
            devLog(`[edit-resolution] doc access denied for resolved edit`);
            return { ok: false, detail: "Document not found" };
        }
        const activeForResolved = await loadActiveVersion(documentId, db);
        const payload = {
            ok: true,
            already_resolved: true,
            status: edit.status,
            version_id: doc.current_version_id ?? null,
            download_url: activeForResolved
                ? buildDownloadUrl(
                      activeForResolved.storage_path,
                      downloadFilenameForVersion(
                          activeForResolved.filename,
                          activeForResolved.version_number,
                          activeForResolved.source === "assistant_edit",
                      ),
                  )
                : null,
            remaining_pending: 0,
        };
        devLog(`[edit-resolution] returning already-resolved payload`, payload);
        return { ok: true, body: payload };
    }

    const { data: doc, error: docErr } = await db
        .from("documents")
        .select("id, current_version_id, user_id, project_id, org_id, workflow_id")
        .eq("id", documentId)
        .single();
    devLog(`[edit-resolution] fetched doc`, { doc, docErr });
    if (!doc) return { ok: false, detail: "Document not found" };
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    // Resolving an edit rewrites the version's bytes, so read access is not
    // enough. A stranger still gets 404; a Viewer who can open the document
    // is told why instead of being told it is missing.
    if (!access.ok) return { ok: false, detail: "Document not found" };
    if (!can(access.projectRole, "content.edit"))
        return { ok: false, status: 403, detail: DOCUMENT_EDIT_FORBIDDEN };

    const active = await loadActiveVersion(documentId, db);
    const latestPath = active?.storage_path ?? null;
    devLog(`[edit-resolution] resolved latestPath`, {
        latestPath,
        current_version_id: doc.current_version_id,
    });
    if (!active || !latestPath) return { ok: false, detail: "No file to edit" };

    const raw = await downloadFile(latestPath);
    devLog(`[edit-resolution] downloaded bytes`, {
        byteLength: raw?.byteLength ?? 0,
    });
    if (!raw) return { ok: false, detail: "Document bytes not available" };

    const wIds = [edit.del_w_id, edit.ins_w_id].filter(
        (v): v is string => typeof v === "string" && v.length > 0,
    );
    const { bytes: resolvedBytes, found } = await resolveTrackedChange(
        Buffer.from(raw),
        wIds,
        mode,
    );
    devLog(`[edit-resolution] resolveTrackedChange result`, {
        mode,
        change_id: edit.change_id,
        wIds,
        found,
        resolvedByteLength: resolvedBytes?.byteLength ?? 0,
    });
    if (!found) {
        devLog(
            `[edit-resolution] change_id not found in docx — updating status only`,
        );
        // Still update DB status so the UI reflects the decision — the change
        // may have been auto-consumed by a previous accept/reject pass.
        const { error: updErr } = await db
            .from("document_edits")
            .update({ status: mode === "accept" ? "accepted" : "rejected", resolved_at: new Date().toISOString() })
            .eq("id", editId);
        devLog(`[edit-resolution] status-only update`, { updErr });
        const payload = {
            ok: true,
            version_id: doc.current_version_id,
            download_url: buildDownloadUrl(
                latestPath,
                downloadFilenameForVersion(
                    active?.filename,
                    active?.version_number ?? null,
                    active?.source === "assistant_edit",
                ),
            ),
            remaining_pending: 0,
        };
        devLog(`[edit-resolution] returning not-found payload`, payload);
        return { ok: true, body: payload };
    }

    // The resolved bytes become a new, inactive version; it turns active only if the version they came
    // from still is. Otherwise someone else wrote first: discard this one and let the caller start over.
    const created = await createInactiveVersion(db, documentId, userId, resolvedBytes);
    if (!created.ok) return { ok: false, detail: "Failed to resolve edit", error: new Error(created.error) };
    const activation = await activateDocumentVersionIfCurrent(db, documentId, created.versionRowId, active.id);
    if (activation.error) return { ok: false, detail: "Failed to resolve edit", error: activation.error };
    if (!activation.activated) {
        await discardDocumentVersion(db, documentId, created.versionRowId, userId);
        return { ok: false, conflict: true };
    }
    const nextPath = created.storagePath;

    const { error: statusErr } = await db
        .from("document_edits")
        .update({
            status: mode === "accept" ? "accepted" : "rejected",
            resolved_at: new Date().toISOString(),
        })
        .eq("id", editId);
    devLog(`[edit-resolution] updated document_edits status`, {
        editId,
        newStatus: mode === "accept" ? "accepted" : "rejected",
        statusErr,
    });
    const { count: remainingPending } = await db
        .from("document_edits")
        .select("id", { count: "exact", head: true })
        .eq("document_id", documentId)
        .eq("status", "pending");
    devLog(`[edit-resolution] remaining pending count`, { remainingPending });

    const payload = {
        ok: true,
        version_id: created.versionRowId,
        download_url: buildDownloadUrl(
            nextPath,
            downloadFilenameForVersion(
                active?.filename,
                active?.version_number ?? null,
                active?.source === "assistant_edit",
            ),
        ),
        remaining_pending: remainingPending ?? 0,
    };
    devLog(`[edit-resolution] returning success payload`, payload);
    return { ok: true, body: payload };
}
