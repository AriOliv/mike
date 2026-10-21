// AI contract analysis ("dossier") attached to a project: critical risks,
// points of attention, suggested redlines and compliance notes, each quoting
// the clause it came from.

import type { Db } from "../../lib/supabase";
import {
    failure,
    internalFailure,
    ok,
    type ServiceResult,
} from "../../lib/serviceResult";
import {
    requireProjectEdit,
    requireProjectView,
    type Caller,
} from "./contracts.shared";

const COLUMNS = "id, project_id, payload, risk_level, source, created_at, updated_at";

export type Dossier = Record<string, unknown> & { project_id: string };

/** No analysis yet is a normal state, not an error — the UI shows an empty state. */
export async function getDossier(
    db: Db,
    caller: Caller,
    projectId: string,
): Promise<ServiceResult<Dossier | null>> {
    const access = await requireProjectView(db, caller, projectId);
    if (!access.ok) return access;

    const { data, error } = await db
        .from("dossiers")
        .select(COLUMNS)
        .eq("project_id", projectId)
        .maybeSingle();
    if (error) return internalFailure(error);
    return ok((data as Dossier | null) ?? null);
}

/** Store or replace the analysis. */
export async function putDossier(
    db: Db,
    caller: Caller,
    projectId: string,
    body: Record<string, unknown>,
): Promise<ServiceResult<Dossier>> {
    const access = await requireProjectEdit(db, caller, projectId);
    if (!access.ok) return access;

    const payload = body.payload;
    if (!payload || typeof payload !== "object") {
        return failure("validation", "payload object is required");
    }
    const riskLevel = typeof body.risk_level === "string" ? body.risk_level : null;
    const source = body.source === "generated" ? "generated" : "import";

    const { data, error } = await db
        .from("dossiers")
        .upsert(
            {
                project_id: projectId,
                user_id: caller.userId,
                payload,
                risk_level: riskLevel,
                source,
                updated_at: new Date().toISOString(),
            },
            { onConflict: "project_id" },
        )
        .select(COLUMNS)
        .single();
    if (error) return internalFailure(error);
    return ok(data as unknown as Dossier);
}
