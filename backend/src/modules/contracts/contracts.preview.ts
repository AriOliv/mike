// Viewable copy of a project's contract, for reading it beside the analysis.
//
// Prefers the converted PDF, which every browser renders inline; falls back to
// the original file when there is no conversion (already a PDF, or a format the
// converter skipped).

import type { Db } from "../../lib/supabase";
import { downloadFile } from "../../lib/storage";
import {
    failure,
    internalFailure,
    ok,
    type ServiceResult,
} from "../../lib/serviceResult";
import {
    latestContractFiles,
    requireProjectView,
    type Caller,
} from "./contracts.shared";

export type ContractPreview = {
    document_id: string;
    filename: string;
    /** Only a PDF can be shown inline; anything else the UI offers to download. */
    inline: boolean;
    url: string;
};

export async function getContractPreview(
    db: Db,
    caller: Caller,
    projectId: string,
): Promise<ServiceResult<ContractPreview | null>> {
    const access = await requireProjectView(db, caller, projectId);
    if (!access.ok) return access;
    try {
        const file = (await latestContractFiles(db, [projectId])).get(projectId);
        if (!file) return ok(null);
        return ok({
            document_id: file.document_id,
            filename: file.filename,
            inline: file.isPdf,
            url: `/projects/${projectId}/preview/file`,
        });
    } catch (error) {
        return internalFailure(error);
    }
}

export type ContractPreviewFile = {
    filename: string;
    contentType: string;
    bytes: Buffer;
};

/**
 * The bytes themselves. Served here rather than through the signed download
 * route, which resolves a token against `storage_path` only and so cannot hand
 * back the converted PDF.
 */
export async function getContractPreviewFile(
    db: Db,
    caller: Caller,
    projectId: string,
): Promise<ServiceResult<ContractPreviewFile>> {
    const access = await requireProjectView(db, caller, projectId);
    if (!access.ok) return access;
    try {
        const file = (await latestContractFiles(db, [projectId])).get(projectId);
        if (!file) return failure("not_found", "No document");
        const bytes = await downloadFile(file.path);
        if (!bytes) return failure("not_found", "File not found");
        return ok({
            filename: file.filename.replace(/"/g, ""),
            contentType: file.isPdf ? "application/pdf" : "application/octet-stream",
            bytes: Buffer.from(bytes),
        });
    } catch (error) {
        return internalFailure(error);
    }
}
