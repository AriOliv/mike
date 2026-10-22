// Helpers shared by the contracts module's topic files. Not exported through
// the facade.

import type { Db } from "../../lib/supabase";
import { checkProjectAccess, type ProjectAccess } from "../../lib/access";
import { can } from "../../lib/permissions";
import { downloadFile } from "../../lib/storage";
import { extractPdfText } from "../../lib/pdfText";
import { failure, type ServiceFailure } from "../../lib/serviceResult";
import { getUserModelSettings, type UserModelSettings } from "../user/user.service";

export type Caller = { userId: string; userEmail?: string | null };

export function normalizeString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

export function isIsoDate(value: unknown): value is string {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

const PROJECT_NOT_FOUND = failure("not_found", "Não encontrei este contrato.");

/** The caller may see the project. */
export async function requireProjectView(
    db: Db,
    caller: Caller,
    projectId: string,
): Promise<{ ok: true; access: Extract<ProjectAccess, { ok: true }> } | ServiceFailure> {
    const access = await checkProjectAccess(projectId, caller.userId, caller.userEmail, db);
    if (!access.ok) return PROJECT_NOT_FOUND;
    return { ok: true, access };
}

/** The caller may change the project's content (editor or owner). */
export async function requireProjectEdit(
    db: Db,
    caller: Caller,
    projectId: string,
): Promise<{ ok: true; access: Extract<ProjectAccess, { ok: true }> } | ServiceFailure> {
    const view = await requireProjectView(db, caller, projectId);
    if (!view.ok) return view;
    if (!can(view.access.projectRole, "content.edit")) {
        return failure("forbidden", "Você pode ver este contrato, mas não alterá-lo.");
    }
    return view;
}

export type ContractFile = {
    document_id: string;
    filename: string;
    /** The converted PDF when there is one, else the original. */
    path: string;
    isPdf: boolean;
};

type Version = {
    document_id: string;
    storage_path: string | null;
    pdf_storage_path: string | null;
    filename: string | null;
    version_number: number | null;
    deleted_at: string | null;
};

/**
 * The newest live file of each project's documents, keyed by project. A
 * contract project normally holds one document; when it holds several, the
 * highest version number wins.
 */
export async function latestContractFiles(
    db: Db,
    projectIds: string[],
): Promise<Map<string, ContractFile>> {
    const out = new Map<string, ContractFile>();
    if (projectIds.length === 0) return out;

    const { data: docs, error: docsError } = await db
        .from("documents")
        .select("id, project_id")
        .in("project_id", projectIds)
        .is("archived_at", null);
    if (docsError) throw docsError;
    const docRows = (docs ?? []) as { id: string; project_id: string }[];
    if (docRows.length === 0) return out;

    // Fetched separately: document_versions has more than one foreign key back
    // to documents, so an embed would be ambiguous.
    const { data: versions, error: versionsError } = await db
        .from("document_versions")
        .select("document_id, storage_path, pdf_storage_path, filename, version_number, deleted_at")
        .in("document_id", docRows.map((d) => d.id));
    if (versionsError) throw versionsError;

    const projectOf = new Map(docRows.map((d) => [d.id, d.project_id]));
    const best = new Map<string, Version>();
    for (const v of (versions ?? []) as unknown as Version[]) {
        if (v.deleted_at || !(v.pdf_storage_path || v.storage_path)) continue;
        const projectId = projectOf.get(v.document_id);
        if (!projectId) continue;
        const current = best.get(projectId);
        if (!current || (v.version_number ?? 0) > (current.version_number ?? 0)) {
            best.set(projectId, v);
        }
    }
    for (const [projectId, v] of best) {
        const filename = v.filename ?? "document";
        out.set(projectId, {
            document_id: v.document_id,
            filename,
            path: v.pdf_storage_path ?? v.storage_path!,
            isPdf: !!v.pdf_storage_path || /\.pdf$/i.test(filename),
        });
    }
    return out;
}

/** Plain text of a contract file, or "" when it has none. */
export async function contractFileText(file: ContractFile): Promise<string> {
    const bytes = await downloadFile(file.path);
    if (!bytes) return "";
    return (await extractPdfText(bytes)).trim();
}

/**
 * Head plus tail rather than a prefix: renewal, term, penalties, governing law
 * and venue sit at the END of a contract, so truncating from the start drops
 * exactly what most questions ask about.
 */
export function excerpt(text: string, head: number, tail: number): string {
    if (text.length <= head + tail) return text;
    return (
        text.slice(0, head) +
        "\n\n[...trecho intermediário omitido...]\n\n" +
        text.slice(-tail)
    );
}

export function parseModelJson(raw: string): Record<string, unknown> {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    try {
        return JSON.parse(cleaned) as Record<string, unknown>;
    } catch {
        const start = cleaned.indexOf("{");
        const end = cleaned.lastIndexOf("}");
        if (start !== -1 && end > start) {
            return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
        }
        throw new Error("model did not return JSON");
    }
}

export const MODEL_REQUIRED =
    "Escolha um modelo de revisão em Configurações para eu poder ler contratos.";

/**
 * The model contract analysis runs on: the caller's tabular-review model,
 * else the model they last chatted with. There is no product default any
 * more — upstream removed it — so a caller with neither gets a clear 400.
 */
export async function analysisModel(
    db: Db,
    userId: string,
): Promise<{ ok: true; model: string; settings: UserModelSettings } | ServiceFailure> {
    const settings = await getUserModelSettings(userId, db);
    const model = settings.tabular_model ?? settings.last_selected_chat_model;
    if (!model) return failure("validation", MODEL_REQUIRED, "model_required");
    return { ok: true, model, settings };
}
