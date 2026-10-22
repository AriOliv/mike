// The text of a contract's current document, for agents reading it over MCP
// (doc 09 §4.1): page by page, or the passages that match a phrase. Reads
// the indexed text (document_version_texts) through the documents facade,
// which rechecks access in the same query; never downloads or converts.

import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { findDocumentText, readStoredDocumentText } from "../documents/documents.service";
import { requireProjectView, type Caller } from "./contracts.shared";

/** Characters per page of text handed to an agent. */
export const TEXT_PAGE = 30_000;

export type ContractText = {
    document_id: string;
    filename: string;
    version_number: number | null;
    status: "ready" | "pending" | "processing" | "failed" | "missing";
    /** One page of the text, or null when it is not readable yet. */
    text: string | null;
    page: number;
    pages: number;
    /** Passages for a `find` query instead of a page. */
    matches?: { start: number; excerpt: string }[];
};

type DocRow = { id: string; project_id: string };
type VersionRow = { id: string; document_id: string; filename: string | null; version_number: number | null; deleted_at: string | null };

export async function getContractText(
    db: Db,
    caller: Caller,
    projectId: string,
    options: { page?: number; find?: string } = {},
): Promise<ServiceResult<ContractText | null>> {
    const page = options.page ?? 1;
    if (!Number.isInteger(page) || page < 1) return failure("validation", "A página começa em 1.");
    const access = await requireProjectView(db, caller, projectId);
    if (!access.ok) return access;
    try {
        const { data: docs, error: docsError } = await db
            .from("documents")
            .select("id, project_id")
            .eq("project_id", projectId)
            .is("archived_at", null);
        if (docsError) throw docsError;
        const docIds = ((docs ?? []) as DocRow[]).map((d) => d.id);
        if (docIds.length === 0) return ok(null);
        const { data: versions, error: versionsError } = await db
            .from("document_versions")
            .select("id, document_id, filename, version_number, deleted_at")
            .in("document_id", docIds);
        if (versionsError) throw versionsError;
        const current = ((versions ?? []) as VersionRow[])
            .filter((v) => !v.deleted_at)
            .sort((a, b) => (b.version_number ?? 0) - (a.version_number ?? 0))[0];
        if (!current) return ok(null);
        const base = {
            document_id: current.document_id,
            filename: current.filename ?? "documento",
            version_number: current.version_number,
        };

        if (options.find !== undefined) {
            const found = await findDocumentText(db, {
                userId: caller.userId,
                userEmail: caller.userEmail,
                scope: "document",
                query: options.find,
                documentId: current.document_id,
                versionId: current.id,
                limit: 10,
            });
            if (!found.ok) return found.kind === "validation" ? failure("validation", "Busque um trecho de 2 a 500 caracteres.") : found;
            return ok({
                ...base,
                status: "ready",
                text: null,
                page: 1,
                pages: 1,
                matches: found.data.matches.map((m) => ({ start: m.start_char, excerpt: m.excerpt })),
            });
        }

        const stored = await readStoredDocumentText(db, {
            userId: caller.userId,
            userEmail: caller.userEmail,
            documentId: current.document_id,
            versionId: current.id,
        });
        if (!stored) return failure("not_found", "Contrato não encontrado.");
        if (stored.status !== "ready" || !stored.text)
            return ok({ ...base, status: stored.status === "ready" ? "missing" : stored.status, text: null, page: 1, pages: 0 });
        const pages = Math.max(1, Math.ceil(stored.text.length / TEXT_PAGE));
        if (page > pages) return failure("validation", `O texto tem ${pages} página(s).`);
        return ok({
            ...base,
            status: "ready",
            text: stored.text.slice((page - 1) * TEXT_PAGE, page * TEXT_PAGE),
            page,
            pages,
        });
    } catch (error) {
        return internalFailure(error);
    }
}
