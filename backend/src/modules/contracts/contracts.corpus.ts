// The contract base as plain text, for features that cross something with
// every contract at once (the regulatory radar asks "which contracts mention
// ativos virtuais?").
//
// Reads only text the upstream indexer already published
// (document_version_texts, status 'ready'): a run over the whole base must not
// download and parse every PDF again. A contract whose text is not indexed yet
// is simply not searched, and the caller reports how many were.

import type { Db } from "../../lib/supabase";

// PostgREST caps an `in` list by URL length; the base is read in slices.
const ID_CHUNK = 200;

export type ContractCorpusEntry = {
    project_id: string;
    name: string;
    counterparty: string | null;
    org_id: string | null;
    text: string;
};

/**
 * Every pipeline contract (a project with a lane, not archived) of the given
 * organization, or of the given owner when orgId is null, with the indexed
 * text of its documents' live versions concatenated.
 */
export async function contractCorpus(
    db: Db,
    scope: { orgId: string | null; userId: string | null },
): Promise<ContractCorpusEntry[]> {
    let q = db
        .from("projects")
        .select("id, name, counterparty, org_id")
        .not("lane", "is", null)
        .is("archived_at", null);
    if (scope.orgId) q = q.eq("org_id", scope.orgId);
    else if (scope.userId) q = q.eq("user_id", scope.userId).is("org_id", null);
    else return [];
    const { data: projects, error } = await q;
    if (error) throw error;
    const rows = (projects ?? []) as { id: string; name: string; counterparty: string | null; org_id: string | null }[];
    if (rows.length === 0) return [];

    const textByProject = new Map<string, string[]>();
    for (let i = 0; i < rows.length; i += ID_CHUNK) {
        const ids = rows.slice(i, i + ID_CHUNK).map((r) => r.id);
        const { data: docs, error: docsError } = await db
            .from("documents")
            .select("id, project_id")
            .in("project_id", ids)
            .is("archived_at", null);
        if (docsError) throw docsError;
        const projectOf = new Map(((docs ?? []) as { id: string; project_id: string }[]).map((d) => [d.id, d.project_id]));
        if (projectOf.size === 0) continue;

        const { data: versions, error: versionsError } = await db
            .from("document_versions")
            .select("id, document_id")
            .in("document_id", [...projectOf.keys()])
            .is("deleted_at", null);
        if (versionsError) throw versionsError;
        const docOf = new Map(((versions ?? []) as { id: string; document_id: string }[]).map((v) => [v.id, v.document_id]));
        if (docOf.size === 0) continue;

        const { data: texts, error: textsError } = await db
            .from("document_version_texts")
            .select("version_id, text_content")
            .in("version_id", [...docOf.keys()])
            .eq("status", "ready");
        if (textsError) throw textsError;
        for (const t of (texts ?? []) as { version_id: string; text_content: string | null }[]) {
            const projectId = projectOf.get(docOf.get(t.version_id) ?? "");
            if (!projectId || !t.text_content) continue;
            const list = textByProject.get(projectId) ?? [];
            list.push(t.text_content);
            textByProject.set(projectId, list);
        }
    }

    return rows
        .filter((r) => textByProject.has(r.id))
        .map((r) => ({
            project_id: r.id,
            name: r.name,
            counterparty: r.counterparty,
            org_id: r.org_id,
            text: textByProject.get(r.id)!.join("\n\n"),
        }));
}
