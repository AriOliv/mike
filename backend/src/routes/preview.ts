// Viewable copy of a project's contract, for reading it beside the analysis.
//
// Prefers the converted PDF, which every browser renders inline; falls back to
// the original file when there is no conversion (already a PDF, or a format the
// converter skipped).
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { checkProjectAccess } from "../lib/access";
import { downloadFile } from "../lib/storage";

export const previewRouter = Router({ mergeParams: true });

type Version = {
    document_id: string;
    storage_path: string | null;
    pdf_storage_path: string | null;
    filename: string | null;
    version_number: number | null;
    deleted_at: string | null;
};

// GET /projects/:projectId/preview
previewRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const projectId = req.params.projectId;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

    const { data: docs, error: docsError } = await db
        .from("documents")
        .select("id")
        .eq("project_id", projectId);
    if (docsError) return void res.status(500).json({ detail: docsError.message });

    const ids = ((docs ?? []) as { id: string }[]).map((d) => d.id);
    if (ids.length === 0) return void res.json(null);

    // Fetched separately: document_versions has more than one foreign key back
    // to documents, so an embed would be ambiguous.
    const { data: versions, error: versionsError } = await db
        .from("document_versions")
        .select("document_id, storage_path, pdf_storage_path, filename, version_number, deleted_at")
        .in("document_id", ids);
    if (versionsError) return void res.status(500).json({ detail: versionsError.message });

    const live = ((versions ?? []) as unknown as Version[])
        .filter((v) => !v.deleted_at && (v.pdf_storage_path || v.storage_path))
        .sort((a, b) => (b.version_number ?? 0) - (a.version_number ?? 0));

    const version = live[0];
    if (!version) return void res.json(null);

    const filename = version.filename ?? "document";
    const isPdf = !!version.pdf_storage_path || /\.pdf$/i.test(filename);
    const path = version.pdf_storage_path ?? version.storage_path!;

    res.json({
        document_id: version.document_id,
        filename,
        // Only a PDF can be shown inline; anything else the UI offers to download.
        inline: isPdf,
        url: `/projects/${projectId}/preview/file`,
    });
});

// GET /projects/:projectId/preview/file — the bytes themselves.
//
// Served here rather than through the signed download route, which resolves a
// token against `storage_path` only and so cannot hand back the converted PDF.
previewRouter.get("/file", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const projectId = req.params.projectId;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

    const { data: docs } = await db.from("documents").select("id").eq("project_id", projectId);
    const ids = ((docs ?? []) as { id: string }[]).map((d) => d.id);
    if (ids.length === 0) return void res.status(404).json({ detail: "No document" });

    const { data: versions } = await db
        .from("document_versions")
        .select("document_id, storage_path, pdf_storage_path, filename, version_number, deleted_at")
        .in("document_id", ids);

    const version = ((versions ?? []) as unknown as Version[])
        .filter((v) => !v.deleted_at && (v.pdf_storage_path || v.storage_path))
        .sort((a, b) => (b.version_number ?? 0) - (a.version_number ?? 0))[0];
    if (!version) return void res.status(404).json({ detail: "No document" });

    const filename = version.filename ?? "document";
    const isPdf = !!version.pdf_storage_path || /\.pdf$/i.test(filename);
    const bytes = await downloadFile(version.pdf_storage_path ?? version.storage_path!);
    if (!bytes) return void res.status(404).json({ detail: "File not found" });

    res.setHeader("Content-Type", isPdf ? "application/pdf" : "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${filename.replace(/"/g, "")}"`);
    res.send(Buffer.from(bytes));
});
