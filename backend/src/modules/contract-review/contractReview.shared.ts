// Helpers shared by the contract-review topic files. Not exported through the
// facade.

import type { Db } from "../../lib/supabase";
import { checkProjectAccess, type ProjectAccess } from "../../lib/access";
import { can, DOCUMENT_EDIT_FORBIDDEN } from "../../lib/permissions";
import { failure, type ServiceFailure } from "../../lib/serviceResult";
import { loadActiveVersion } from "../../lib/documentVersions";

export type Caller = { userId: string; userEmail?: string | null };

type Access = Extract<ProjectAccess, { ok: true }>;

const NOT_FOUND = failure("not_found", "Contrato não encontrado.");

/** The caller may open the contract. A project they cannot see reads as missing. */
export async function requireContractView(
    db: Db,
    caller: Caller,
    projectId: string,
): Promise<{ ok: true; access: Access } | ServiceFailure> {
    const access = await checkProjectAccess(projectId, caller.userId, caller.userEmail, db);
    if (!access.ok) return NOT_FOUND;
    return { ok: true, access };
}

/** The caller may change the contract's content (editor or owner). */
export async function requireContractEdit(
    db: Db,
    caller: Caller,
    projectId: string,
): Promise<{ ok: true; access: Access } | ServiceFailure> {
    const view = await requireContractView(db, caller, projectId);
    if (!view.ok) return view;
    if (!can(view.access.projectRole, "content.edit")) return failure("forbidden", DOCUMENT_EDIT_FORBIDDEN);
    return view;
}

export type ContractDocument = {
    documentId: string;
    versionId: string;
    versionNumber: number | null;
    filename: string;
    fileType: string;
    storagePath: string;
    isDocx: boolean;
};

/**
 * The contract under review: the project's Word document when it has one (a
 * redline needs Word), else its newest document. The reviewed document is
 * chosen, not guessed per run, so the Ficha and the review read the same file.
 */
export async function contractDocument(db: Db, projectId: string): Promise<ContractDocument | null> {
    const { data, error } = await db
        .from("documents")
        .select("id, updated_at")
        .eq("project_id", projectId)
        .is("archived_at", null)
        .order("updated_at", { ascending: false });
    if (error) throw error;
    const candidates: ContractDocument[] = [];
    for (const row of (data ?? []) as { id: string }[]) {
        const version = await loadActiveVersion(row.id, db);
        if (!version) continue;
        const filename = version.filename?.trim() || "documento";
        const fileType = (version.file_type ?? filename.split(".").pop() ?? "").toLowerCase();
        candidates.push({
            documentId: row.id,
            versionId: version.id,
            versionNumber: version.version_number,
            filename,
            fileType,
            storagePath: version.storage_path,
            isDocx: fileType === "docx" || /\.docx$/i.test(filename),
        });
    }
    return candidates.find((doc) => doc.isDocx) ?? candidates[0] ?? null;
}

export function parseModelJson(raw: string): unknown {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    try {
        return JSON.parse(cleaned);
    } catch {
        const start = cleaned.indexOf("{");
        const end = cleaned.lastIndexOf("}");
        if (start !== -1 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
        throw new Error("model did not return JSON");
    }
}
