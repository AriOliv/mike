// Assignment rules of the legal team (L-33): fixed and predictable, no model.
// The Head lists rules in order; the first one that matches a request names
// who takes it. A rule only distributes the work: it never decides anything
// about the contract. The triage agent keeps suggesting (open load, playbook,
// what is missing) and only fills the owner when no rule did.
//
// A person's choice is never undone: a rule may set the owner of a request
// that has none, or replace the owner an earlier rule set (the checklist,
// closed later, may bring the value that now matches a different rule).

import type { Db } from "../../lib/supabase";
import { getOrgRole } from "../../lib/access";
import { safeError } from "../../lib/safeError";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { recordCardEvent } from "../contracts/contracts.service";
import { loadLegalTeam, NO_LEGAL_TEAM, type Caller, type RequestRow } from "./requests.access";
import { parseMoney } from "./requests.money";
import { queueNotifications } from "./requests.notifications";
import { loadTeamMembers } from "./requests.triage";
import { normalizeArea, REQUEST_KINDS, type RequestKind } from "./requests.shared";

export type AssignmentCondition = {
    area?: string;
    kind?: RequestKind;
    /** Contract value in reais, inclusive. Needs the value to be known to match. */
    value_min?: number;
    value_max?: number;
};

export type AssignmentRule = { when: AssignmentCondition; assign_to: string; note?: string };

export const MAX_RULES = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ruleMessage = (index: number, what: string) => `Regra ${index + 1}: ${what}`;
const bad = (index: number, what: string) => ({ ok: false as const, detail: ruleMessage(index, what) });

function money(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    return value;
}

/** Validate the rules the Head sent. Messages are for the Head, in Portuguese. */
export function parseAssignmentRules(
    raw: unknown,
    memberIds: ReadonlySet<string>,
): { ok: true; rules: AssignmentRule[] } | { ok: false; detail: string } {
    if (raw === null || raw === undefined) return { ok: true, rules: [] };
    if (!Array.isArray(raw)) return { ok: false, detail: "As regras de atribuição precisam ser uma lista." };
    if (raw.length > MAX_RULES) return { ok: false, detail: `Use no máximo ${MAX_RULES} regras.` };
    const rules: AssignmentRule[] = [];
    for (const [index, item] of raw.entries()) {
        if (!item || typeof item !== "object" || Array.isArray(item)) return bad(index, "formato inválido.");
        const { when, assign_to: assignTo, note } = item as Record<string, unknown>;
        if (!when || typeof when !== "object" || Array.isArray(when)) return bad(index, "diga quando ela vale.");
        const cond = when as Record<string, unknown>;
        const out: AssignmentCondition = {};
        if (cond.area !== undefined) {
            const area = typeof cond.area === "string" ? normalizeArea(cond.area) : null;
            if (!area) return bad(index, "a área está vazia.");
            out.area = area;
        }
        if (cond.kind !== undefined) {
            if (typeof cond.kind !== "string" || !(REQUEST_KINDS as readonly string[]).includes(cond.kind)) {
                return bad(index, "o tipo de pedido não existe.");
            }
            out.kind = cond.kind as RequestKind;
        }
        for (const key of ["value_min", "value_max"] as const) {
            if (cond[key] === undefined) continue;
            const v = money(cond[key]);
            if (v === null) return bad(index, "o valor precisa ser um número em reais, sem negativo.");
            out[key] = v;
        }
        if (out.value_min !== undefined && out.value_max !== undefined && out.value_min > out.value_max) {
            return bad(index, "o valor mínimo é maior que o máximo.");
        }
        if (Object.keys(out).length === 0) return bad(index, "defina ao menos uma condição (área, tipo ou valor).");
        if (typeof assignTo !== "string" || !UUID.test(assignTo)) return bad(index, "escolha quem assume.");
        if (!memberIds.has(assignTo)) return bad(index, "essa pessoa não é do time do Legal.");
        const rule: AssignmentRule = { when: out, assign_to: assignTo };
        if (note !== undefined && note !== null) {
            if (typeof note !== "string") return bad(index, "a observação precisa ser texto.");
            const trimmed = note.trim().slice(0, 140);
            if (trimmed) rule.note = trimmed;
        }
        rules.push(rule);
    }
    return { ok: true, rules };
}

/** What a rule matches against: the request, and the value once the checklist has it. */
export type RuleSubject = { area: string | null; kind: string; value: number | null };

/** The first rule that matches, or null. A condition on value never matches an unknown value. */
export function matchRule(rules: readonly AssignmentRule[], subject: RuleSubject): { rule: AssignmentRule; index: number } | null {
    const area = subject.area ? normalizeArea(subject.area) : null;
    for (const [index, rule] of rules.entries()) {
        const w = rule.when;
        if (w.area !== undefined && w.area !== area) continue;
        if (w.kind !== undefined && w.kind !== subject.kind) continue;
        if (w.value_min !== undefined || w.value_max !== undefined) {
            if (subject.value === null) continue;
            if (w.value_min !== undefined && subject.value < w.value_min) continue;
            if (w.value_max !== undefined && subject.value > w.value_max) continue;
        }
        return { rule, index };
    }
    return null;
}

/** The contract value the requester wrote in the checklist, in reais, or null when absent or unreadable. */
export function valueFromIntake(intake: Record<string, unknown> | null | undefined): number | null {
    const answer = intake?.valor_recorrencia as { value?: unknown } | undefined;
    return typeof answer?.value === "string" ? parseMoney(answer.value) : null;
}

function readRules(stored: unknown): AssignmentRule[] {
    // What is stored passed parseAssignmentRules on the way in; read it defensively anyway.
    if (!Array.isArray(stored)) return [];
    return stored.filter(
        (r): r is AssignmentRule =>
            !!r && typeof r === "object" && typeof (r as AssignmentRule).assign_to === "string" && !!(r as AssignmentRule).when,
    );
}

/** The team's rules, as the Head sees them. */
export async function getAssignmentRules(db: Db, caller: Caller): Promise<ServiceResult<{ rules: AssignmentRule[] }>> {
    let team;
    try {
        team = await loadLegalTeam(db);
    } catch (error) {
        return internalFailure(error);
    }
    if (!team) return NO_LEGAL_TEAM;
    const role = await getOrgRole(caller.userId, team.org_id, db);
    if (!role) return failure("forbidden", "Só o time do Legal pode fazer isso.");
    const { data, error } = await db.from("legal_teams").select("assignment_rules").eq("org_id", team.org_id).maybeSingle();
    if (error) return internalFailure(error);
    return ok({ rules: readRules((data as { assignment_rules?: unknown } | null)?.assignment_rules) });
}

/** Replace the team's rules (the Head only). An empty list turns them off. */
export async function setAssignmentRules(
    db: Db,
    caller: Caller,
    body: { rules?: unknown },
): Promise<ServiceResult<{ rules: AssignmentRule[] }>> {
    let team;
    try {
        team = await loadLegalTeam(db);
    } catch (error) {
        return internalFailure(error);
    }
    if (!team) return NO_LEGAL_TEAM;
    const role = await getOrgRole(caller.userId, team.org_id, db);
    if (role !== "owner" && role !== "admin") return failure("forbidden", "Só a liderança do Legal pode fazer isso.");
    let members;
    try {
        members = await loadTeamMembers(db, team.org_id);
    } catch (error) {
        return internalFailure(error);
    }
    const parsed = parseAssignmentRules(body.rules, new Set(members.map((m) => m.user_id)));
    if (!parsed.ok) return failure("validation", parsed.detail);
    const { error } = await db
        .from("legal_teams")
        .update({ assignment_rules: parsed.rules, updated_at: new Date().toISOString() })
        .eq("org_id", team.org_id);
    if (error) return internalFailure(error);
    return ok({ rules: parsed.rules });
}

/**
 * Apply the rules to a request: the first match names the owner. Never undoes
 * a person's choice (or the triage's accepted suggestion): only an unowned
 * request, or one a rule owned, changes. Never fails the caller.
 */
export async function applyAssignmentRules(db: Db, row: RequestRow): Promise<{ assigned: boolean }> {
    try {
        if (row.assignee_id && row.assigned_by !== "rule") return { assigned: false };
        if (row.status === "entregue" || row.status === "cancelado") return { assigned: false };

        const { data: team, error } = await db.from("legal_teams").select("assignment_rules").eq("org_id", row.org_id).maybeSingle();
        if (error) throw error;
        const rules = readRules((team as { assignment_rules?: unknown } | null)?.assignment_rules);
        if (rules.length === 0) return { assigned: false };

        const hit = matchRule(rules, { area: row.requester_area, kind: row.kind, value: valueFromIntake(row.intake) });
        if (!hit || hit.rule.assign_to === row.assignee_id) return { assigned: false };

        const members = await loadTeamMembers(db, row.org_id);
        const member = members.find((m) => m.user_id === hit.rule.assign_to);
        // The person left the team since the rule was written: leave the request for the triage.
        if (!member) return { assigned: false };

        const now = new Date().toISOString();
        const { error: updateError } = await db
            .from("legal_requests")
            .update({
                assignee_id: member.user_id,
                assigned_at: now,
                assigned_by: "rule",
                status: row.status === "novo" || row.status === "em_triagem" ? "em_andamento" : row.status,
                updated_at: now,
            })
            .eq("id", row.id);
        if (updateError) throw updateError;

        if (row.project_id) {
            const { data: card } = await db.from("projects").select("lane").eq("id", row.project_id).maybeSingle();
            const cardPatch: Record<string, unknown> = { assignee_email: member.email, status: "em_andamento", updated_at: now };
            if ((card as { lane?: string } | null)?.lane === "entrada") {
                cardPatch.lane = "triagem";
                cardPatch.lane_updated_at = now;
            }
            await db.from("projects").update(cardPatch).eq("id", row.project_id);
            await recordCardEvent(db, {
                projectId: row.project_id,
                orgId: row.org_id,
                actorType: "agent",
                actorId: "agent:regras@1",
                actorName: "Regra de atribuição",
                action: "assignee.changed",
                field: "assignee",
                before: row.assignee_id ? { id: row.assignee_id } : null,
                after: { id: member.user_id, name: member.name, reason: `regra ${hit.index + 1}${hit.rule.note ? `: ${hit.rule.note}` : ""}` },
                source: "agent",
            });
        }
        await queueNotifications(db, [
            {
                requestId: row.id,
                number: row.number,
                title: row.title,
                template: "request.assigned",
                recipient: row.requester_email,
                dedupeKey: `assigned:${row.id}:${member.user_id}`,
                payload: { assignee: member.name },
            },
        ]);
        return { assigned: true };
    } catch (error) {
        console.error("[requests] assignment rules failed", { requestId: row.id, error: safeError(error) });
        return { assigned: false };
    }
}
