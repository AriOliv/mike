// Google Drive mirror for project documents.
//
// Contracts stay in object storage (that is what the app serves), and are also
// pushed to a shared Drive folder so the legal team can open them where they
// already work. One service account, no per-user OAuth.
//
// Auth is a signed JWT exchanged for an access token — done with node's crypto
// rather than pulling in the Google SDK, which would be a large dependency for
// three REST calls.
import { createServerSupabase } from "./supabase";
import { downloadFile } from "./storage";
import { SCOPES, googleAccessToken, serviceAccountConfigured } from "./google";

const FILES = "https://www.googleapis.com/drive/v3/files";

export function driveEnabled(): boolean {
    return !!(serviceAccountConfigured() && process.env.DRIVE_FOLDER_ID?.trim());
}

// project id -> Drive folder id, so a busy project does not re-query every upload
const folderCache = new Map<string, string>();

async function api(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const token = await googleAccessToken(SCOPES.drive);
    const headers = { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` };
    const response = await fetch(url, { ...init, headers });
    if (!response.ok) {
        throw new Error(`drive ${init.method ?? "GET"}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    }
    return (await response.json()) as Record<string, unknown>;
}

/** One Drive subfolder per project, created on first use. */
async function folderForProject(projectId: string, projectName: string): Promise<string> {
    const cached = folderCache.get(projectId);
    if (cached) return cached;

    const root = process.env.DRIVE_FOLDER_ID!.trim();
    // Name collisions are fine to reuse — this is a mirror, not a namespace.
    const safeName = projectName.replace(/['\\]/g, " ").slice(0, 120);
    const query = encodeURIComponent(
        `'${root}' in parents and name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    );
    const found = await api(
        `${FILES}?q=${query}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
        { method: "GET" },
    );
    const files = (found.files ?? []) as { id: string }[];
    let id = files[0]?.id;
    if (!id) {
        const created = await api(`${FILES}?fields=id&supportsAllDrives=true`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: safeName,
                mimeType: "application/vnd.google-apps.folder",
                parents: [root],
            }),
        });
        id = created.id as string;
    }
    folderCache.set(projectId, id);
    return id;
}

export type DriveUpload = { id: string; link: string | null };

/** Push one file into the project's Drive folder. */
export async function uploadToDrive(params: {
    projectId: string;
    projectName: string;
    filename: string;
    mimeType: string;
    body: Buffer;
}): Promise<DriveUpload> {
    const parent = await folderForProject(params.projectId, params.projectName);
    const boundary = `mike${Date.now().toString(36)}`;
    const metadata = JSON.stringify({ name: params.filename, parents: [parent] });
    const payload = Buffer.concat([
        Buffer.from(
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${params.mimeType}\r\n\r\n`,
        ),
        params.body,
        Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploaded = await api(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true",
        {
            method: "POST",
            headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
            body: new Uint8Array(payload),
        },
    );
    return { id: uploaded.id as string, link: (uploaded.webViewLink as string) ?? null };
}

/**
 * Mirror a document, never throwing: a Drive outage must not fail an upload the
 * app has already stored successfully.
 */
export async function mirrorToDrive(params: {
    projectId: string;
    projectName: string;
    filename: string;
    mimeType: string;
    body: Buffer;
}): Promise<DriveUpload | null> {
    if (!driveEnabled()) return null;
    try {
        return await uploadToDrive(params);
    } catch (e) {
        console.warn(`[drive] mirror failed for ${params.filename}: ${(e as Error).message}`);
        return null;
    }
}

const MIME_BY_EXT: Record<string, string> = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export type DriveSyncSummary = {
    enabled: boolean;
    mirrored?: number;
    skipped?: number;
    errors?: number;
    detail?: string;
};

/**
 * Mirror every document that has no Drive copy yet. Runs over documents rather
 * than hooking the upload path, so new uploads and the existing backlog are
 * handled by the same code — and a Drive outage only delays the mirror.
 */
export async function syncDocumentsToDrive(limit = 100): Promise<DriveSyncSummary> {
    if (!driveEnabled()) return { enabled: false };
    const db = createServerSupabase();
    const summary: DriveSyncSummary = { enabled: true, mirrored: 0, skipped: 0, errors: 0 };
    try {
        const { data, error } = await db
            .from("documents")
            .select("id, user_id, project_id, projects(name)")
            .is("drive_file_id", null)
            .not("project_id", "is", null)
            .limit(limit);
        if (error) throw new Error(error.message);

        type Row = { id: string; project_id: string; projects: { name: string } | null };
        const rows = (data ?? []) as unknown as Row[];

        type Version = {
            document_id: string;
            storage_path: string | null;
            filename: string | null;
            file_type: string | null;
            version_number: number | null;
            deleted_at: string | null;
        };
        // Fetched separately: document_versions has more than one foreign key
        // back to documents, so an embed here is ambiguous.
        const versionsByDoc = new Map<string, Version[]>();
        if (rows.length > 0) {
            const { data: vers, error: versError } = await db
                .from("document_versions")
                .select("document_id, storage_path, filename, file_type, version_number, deleted_at")
                .in("document_id", rows.map((r) => r.id));
            if (versError) throw new Error(versError.message);
            for (const v of (vers ?? []) as unknown as Version[]) {
                const list = versionsByDoc.get(v.document_id) ?? [];
                list.push(v);
                versionsByDoc.set(v.document_id, list);
            }
        }

        for (const row of rows) {
            // newest live version wins
            const version = (versionsByDoc.get(row.id) ?? [])
                .filter((v) => !v.deleted_at && v.storage_path)
                .sort((a, b) => (b.version_number ?? 0) - (a.version_number ?? 0))[0];
            if (!version?.storage_path || !row.projects?.name) {
                summary.skipped = (summary.skipped ?? 0) + 1;
                continue;
            }
            try {
                const bytes = await downloadFile(version.storage_path);
                if (!bytes) {
                    summary.skipped = (summary.skipped ?? 0) + 1;
                    continue;
                }
                const filename = version.filename ?? `${row.id}.${version.file_type ?? "bin"}`;
                const ext = (version.file_type ?? filename.split(".").pop() ?? "").toLowerCase();
                const uploaded = await uploadToDrive({
                    projectId: row.project_id,
                    projectName: row.projects.name,
                    filename,
                    mimeType: MIME_BY_EXT[ext] ?? "application/octet-stream",
                    body: Buffer.from(bytes),
                });
                await db
                    .from("documents")
                    .update({ drive_file_id: uploaded.id, drive_link: uploaded.link })
                    .eq("id", row.id);
                summary.mirrored = (summary.mirrored ?? 0) + 1;
            } catch (e) {
                summary.errors = (summary.errors ?? 0) + 1;
                console.warn(`[drive] document ${row.id} failed: ${(e as Error).message}`);
            }
        }
        console.log(`[drive] sync: ${JSON.stringify(summary)}`);
        return summary;
    } catch (e) {
        console.warn(`[drive] sync aborted: ${(e as Error).message}`);
        return { ...summary, errors: (summary.errors ?? 0) + 1, detail: (e as Error).message };
    }
}

/** Periodic mirror. Started at boot only when the integration is configured. */
export function startDriveSyncer(): void {
    const seconds = Math.max(60, Number(process.env.DRIVE_SYNC_SECONDS ?? 300));
    const tick = async () => {
        try {
            await syncDocumentsToDrive();
        } catch (e) {
            console.warn(`[drive] syncer: ${(e as Error).message}`);
        }
    };
    void tick();
    setInterval(tick, seconds * 1000).unref();
}
