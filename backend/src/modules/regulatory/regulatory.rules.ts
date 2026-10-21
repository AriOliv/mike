// "Adicionar ao playbook": a regulatory change becomes a SUGGESTED rule that
// the Head approves before it counts. Nothing here writes to a playbook —
// an approved suggestion is what the playbook's owner applies — so an agent
// (or a hurried click) can never change the team's standard on its own.

import type { Db } from "../../lib/supabase";
import { getOrgRole, isOrgAdmin } from "../../lib/access";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { loadVisibleChange, recordChangeDecision, visibleScanIds, type Caller } from "./regulatory.changes";

const COLUMNS =
    "id, change_id, org_id, playbook_id, title, guidance, source_quote, source_url, status, " +
    "suggested_by, decided_by, decided_at, decision_note, created_at, updated_at";

export type RuleSuggestion = Record<string, unknown> & { id: string; change_id: string; status: string };

/** The rule's first wording, from the change itself; the person can rewrite it. */
export function draftGuidance(change: { title: string; summary: string | null; excerpt: string | null; effective_date: string | null }): string {
    const what = change.summary ?? change.excerpt ?? change.title;
    const when = change.effective_date ? ` A partir de ${change.effective_date.split("-").reverse().join("/")}.` : "";
    return `Conferir a adequação ao ${change.title}: ${what}${when}`.slice(0, 4000);
}

/** Who approves: an organization's owners and admins; the owner of a personal scan. */
async function canApprove(db: Db, caller: Caller, scan: { org_id: string | null; user_id: string | null }): Promise<boolean> {
    if (scan.org_id) {
        const role = await getOrgRole(caller.userId, scan.org_id, db);
        return role !== null && isOrgAdmin(role);
    }
    return scan.user_id === caller.userId;
}

export async function suggestPlaybookRule(
    db: Db,
    caller: Caller,
    changeId: string,
    body: Record<string, unknown>,
): Promise<ServiceResult<RuleSuggestion>> {
    let found: Awaited<ReturnType<typeof loadVisibleChange>>;
    try {
        found = await loadVisibleChange(db, caller, changeId);
    } catch (error) {
        return internalFailure(error);
    }
    if (!found) return failure("not_found", "Não encontrei esta mudança. Ela pode ter saído da varredura.");
    const { change, scan } = found;

    const guidance =
        typeof body.guidance === "string" && body.guidance.trim()
            ? body.guidance.trim()
            : draftGuidance(change as never);
    if (guidance.length > 4000) return failure("validation", "A regra está longa demais. Use até 4.000 caracteres.");
    const playbookId = typeof body.playbook_id === "string" && body.playbook_id ? body.playbook_id : null;

    const row = {
        change_id: changeId,
        org_id: scan.org_id,
        playbook_id: playbookId,
        title: String(change.title).slice(0, 300),
        guidance,
        source_quote: (change.summary_quote as string | null) ?? (change.excerpt as string | null),
        source_url: (change.url as string | null) ?? null,
        suggested_by: caller.userEmail ?? caller.userId,
        updated_at: new Date().toISOString(),
    };

    // Suggesting again edits the open suggestion instead of piling up a second one.
    const { data: open, error: openError } = await db
        .from("regulatory_rule_suggestions")
        .select("id")
        .eq("change_id", changeId)
        .eq("status", "pendente")
        .maybeSingle();
    if (openError) return internalFailure(openError);
    const write = open
        ? db.from("regulatory_rule_suggestions").update(row).eq("id", (open as { id: string }).id)
        : db.from("regulatory_rule_suggestions").insert(row);
    const { data, error } = await write.select(COLUMNS).single();
    if (error) return internalFailure(error);
    await recordChangeDecision(db, changeId, change, caller);
    return ok(data as unknown as RuleSuggestion);
}

/** The suggestions of the caller's scans, open first. */
export async function listRuleSuggestions(
    db: Db,
    caller: Caller,
    status?: unknown,
): Promise<ServiceResult<RuleSuggestion[]>> {
    let scanIds: string[];
    try {
        scanIds = await visibleScanIds(db, caller);
    } catch (error) {
        return internalFailure(error);
    }
    if (scanIds.length === 0) return ok([]);
    const { data: changes, error: changesError } = await db
        .from("regulatory_changes")
        .select("id")
        .in("scan_id", scanIds);
    if (changesError) return internalFailure(changesError);
    const ids = ((changes ?? []) as { id: string }[]).map((c) => c.id);
    if (ids.length === 0) return ok([]);
    let q = db.from("regulatory_rule_suggestions").select(COLUMNS).in("change_id", ids);
    if (status === "pendente" || status === "aprovada" || status === "rejeitada") q = q.eq("status", status);
    const { data, error } = await q.order("created_at", { ascending: false });
    if (error) return internalFailure(error);
    return ok((data ?? []) as unknown as RuleSuggestion[]);
}

/** The Head approves or rejects; only an open suggestion can be decided. */
export async function decideRuleSuggestion(
    db: Db,
    caller: Caller,
    suggestionId: string,
    body: Record<string, unknown>,
): Promise<ServiceResult<RuleSuggestion>> {
    const decision = body.status;
    if (decision !== "aprovada" && decision !== "rejeitada") {
        return failure("validation", "Escolha aprovar ou rejeitar a regra.");
    }
    const { data: current, error: readError } = await db
        .from("regulatory_rule_suggestions")
        .select(COLUMNS)
        .eq("id", suggestionId)
        .maybeSingle();
    if (readError) return internalFailure(readError);
    const suggestion = current as RuleSuggestion | null;
    if (!suggestion) return failure("not_found", "Não encontrei esta regra sugerida.");

    let found: Awaited<ReturnType<typeof loadVisibleChange>>;
    try {
        found = await loadVisibleChange(db, caller, suggestion.change_id);
    } catch (error) {
        return internalFailure(error);
    }
    if (!found) return failure("not_found", "Não encontrei esta regra sugerida.");
    if (!(await canApprove(db, caller, found.scan))) {
        return failure("forbidden", "Só a Head (dona ou administradora da organização) aprova regras do playbook.");
    }
    if (suggestion.status !== "pendente") return failure("conflict", "Esta regra sugerida já foi decidida.");

    const { data, error } = await db
        .from("regulatory_rule_suggestions")
        .update({
            status: decision,
            decided_by: caller.userEmail ?? caller.userId,
            decided_at: new Date().toISOString(),
            decision_note: typeof body.note === "string" ? body.note.trim().slice(0, 500) || null : null,
            updated_at: new Date().toISOString(),
        })
        .eq("id", suggestionId)
        .eq("status", "pendente")
        .select(COLUMNS)
        .single();
    if (error) return internalFailure(error);
    return ok(data as unknown as RuleSuggestion);
}
