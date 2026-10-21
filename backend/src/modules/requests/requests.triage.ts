// The triage agent: reads a new request, classifies it, extracts the
// counterparty, writes a two-line summary, lists what is missing, suggests a
// playbook and suggests who should take it. It never decides: the suggestion
// waits on the request as a card the Head accepts, edits or rejects — unless
// the team turned on automatic assignment, and even then only the assignee
// is applied and the decision is logged as the agent's.
//
// The assignee is suggested by a deterministic rule (open load, then who
// last handled the same kind), not by the model: it has to be explainable in
// one sentence and identical on every retry.

import type { Db } from "../../lib/supabase";
import { completeText } from "../../lib/llm";
import { safeError } from "../../lib/safeError";
import { getUserModelSettings } from "../user/user.service";
import {
    finishAgentRun,
    recordCardEvent,
    startAgentRun,
} from "../contracts/contracts.service";
import { REQUEST_COLUMNS, type RequestRow } from "./requests.access";
import {
    KIND_LABELS,
    normalizeArea,
    OPEN_STATUSES,
    REQUEST_KINDS,
    type RequestKind,
} from "./requests.shared";

export const TRIAGE_AGENT = "triagem";
export const TRIAGE_AGENT_VERSION = "1";
export const TRIAGE_AGENT_NAME = "Agente de triagem";
export const ASSIGNMENT_AGENT_NAME = "Agente de atribuição";

export type TeamMember = { user_id: string; email: string; name: string };

export type AssigneeSuggestion = {
    user_id: string;
    name: string;
    open: number;
    /** One sentence the Head reads on the card. */
    reason: string;
};

/**
 * Who should take a request: the member with the fewest open requests; on a
 * tie, whoever handled this kind most recently (they have the context);
 * then the name, so the answer is stable.
 */
export function suggestAssignee(
    members: TeamMember[],
    openByUser: Map<string, number>,
    lastKindHandler: string | null,
    kind: RequestKind,
): AssigneeSuggestion | null {
    if (members.length === 0) return null;
    const ranked = [...members].sort((a, b) => {
        const load = (openByUser.get(a.user_id) ?? 0) - (openByUser.get(b.user_id) ?? 0);
        if (load) return load;
        if (a.user_id === lastKindHandler) return -1;
        if (b.user_id === lastKindHandler) return 1;
        return a.name.localeCompare(b.name, "pt-BR");
    });
    const pick = ranked[0];
    const open = openByUser.get(pick.user_id) ?? 0;
    const others = ranked
        .slice(1, 3)
        .map((m) => `${m.name} tem ${openByUser.get(m.user_id) ?? 0}`);
    const load = `${open} ${open === 1 ? "pedido aberto" : "pedidos abertos"}`;
    const kindNote =
        pick.user_id === lastKindHandler ? `; foi quem cuidou do último ${KIND_LABELS[kind]}` : "";
    const reason = others.length
        ? `${pick.name}: ${load} (${others.join(", ")})${kindNote}.`
        : `${pick.name}: ${load}${kindNote}.`;
    return { user_id: pick.user_id, name: pick.name, open, reason };
}

export type TriageModelOutput = {
    kind: RequestKind | null;
    counterparty: string | null;
    area: string | null;
    summary: string | null;
    missing: string[];
};

const SYSTEM = `Você faz a triagem de pedidos que chegam ao time jurídico de uma empresa brasileira.

Regras:
- Use SOMENTE o que está no pedido. Não invente contraparte, valores nem prazos.
- "summary": 2 frases curtas em português, dizendo o que a pessoa precisa e por quê.
- "kind": um de ${REQUEST_KINDS.join(", ")} (contrato_novo = redigir/negociar contrato que ainda não existe; revisao = revisar contrato recebido; aditivo = aditivo, renovação ou rescisão; nda = acordo de confidencialidade; parecer = dúvida ou opinião jurídica).
- "counterparty": a outra parte (empresa ou pessoa), ou null.
- "area": a área da empresa que pede (ex.: Comercial, Compras, Produto, Financeiro, RH), ou null.
- "missing": até 3 informações que faltam para o Legal começar (ex.: "minuta da contraparte", "valor do contrato", "prazo de vigência"). Lista vazia se nada falta.
- Responda apenas com JSON válido, sem cercas de código: {"kind","counterparty","area","summary","missing"}.`;

export function parseTriage(raw: string): TriageModelOutput {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    const parsed = JSON.parse(start !== -1 && end > start ? cleaned.slice(start, end + 1) : cleaned) as Record<
        string,
        unknown
    >;
    const text = (v: unknown, max: number) =>
        typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim().slice(0, max) : null;
    const kind = REQUEST_KINDS.includes(parsed.kind as RequestKind) ? (parsed.kind as RequestKind) : null;
    const missing = Array.isArray(parsed.missing)
        ? parsed.missing.map((m) => text(m, 120)).filter((m): m is string => !!m).slice(0, 3)
        : [];
    return {
        kind,
        counterparty: text(parsed.counterparty, 200),
        area: text(parsed.area, 80),
        summary: text(parsed.summary, 600),
        missing,
    };
}

/**
 * The model triage runs on: LEGAL_TRIAGE_MODEL (an id from the provider
 * registry) when set, else the model the team's first owner uses for
 * tabular reviews or last chatted with. Null means "triage without AI".
 */
async function triageModel(
    db: Db,
    orgId: string,
): Promise<{ model: string; apiKeys: Awaited<ReturnType<typeof getUserModelSettings>>["api_keys"] } | null> {
    const { data: owners } = await db
        .from("org_members")
        .select("user_id")
        .eq("org_id", orgId)
        .in("role", ["owner", "admin"])
        .order("created_at", { ascending: true })
        .limit(1);
    const ownerId = ((owners ?? [])[0] as { user_id?: string } | undefined)?.user_id;
    if (!ownerId) return null;
    const settings = await getUserModelSettings(ownerId, db, { orgId });
    const model =
        process.env.LEGAL_TRIAGE_MODEL?.trim() ||
        settings.tabular_model ||
        settings.last_selected_chat_model;
    return model ? { model, apiKeys: settings.api_keys } : null;
}

/** The team's members, named for the card. */
export async function loadTeamMembers(db: Db, orgId: string): Promise<TeamMember[]> {
    const { data, error } = await db.from("org_members").select("user_id").eq("org_id", orgId);
    if (error) throw error;
    const ids = ((data ?? []) as { user_id: string }[]).map((r) => r.user_id);
    if (ids.length === 0) return [];
    const { data: profiles, error: profileError } = await db
        .from("user_profiles")
        .select("user_id, email, display_name")
        .in("user_id", ids);
    if (profileError) throw profileError;
    return ((profiles ?? []) as { user_id: string; email: string | null; display_name: string | null }[])
        .filter((p) => p.email)
        .map((p) => ({
            user_id: p.user_id,
            email: p.email!.toLowerCase(),
            name: p.display_name?.trim() || p.email!.split("@")[0],
        }));
}

async function loadWorkload(
    db: Db,
    orgId: string,
    kind: RequestKind,
    excludeId: string,
): Promise<{ openByUser: Map<string, number>; lastKindHandler: string | null }> {
    const { data, error } = await db
        .from("legal_requests")
        .select("id, assignee_id, kind, status, assigned_at")
        .eq("org_id", orgId)
        .not("assignee_id", "is", null)
        .order("assigned_at", { ascending: false })
        .limit(500);
    if (error) throw error;
    const openByUser = new Map<string, number>();
    let lastKindHandler: string | null = null;
    for (const r of (data ?? []) as {
        id: string;
        assignee_id: string;
        kind: string;
        status: string;
    }[]) {
        if (r.id === excludeId) continue;
        if (OPEN_STATUSES.includes(r.status as never)) {
            openByUser.set(r.assignee_id, (openByUser.get(r.assignee_id) ?? 0) + 1);
        }
        if (!lastKindHandler && r.kind === kind) lastKindHandler = r.assignee_id;
    }
    return { openByUser, lastKindHandler };
}

/** A playbook of the team whose name mentions the kind ("NDA", "Prestação de serviços"...). */
async function suggestPlaybook(
    db: Db,
    orgId: string,
    kind: RequestKind,
): Promise<{ id: string; name: string } | null> {
    const { data, error } = await db
        .from("playbooks")
        .select("id, name")
        .eq("org_id", orgId)
        .eq("visibility", "organization")
        .order("updated_at", { ascending: false })
        .limit(50);
    if (error || !data) return null;
    const words: Record<RequestKind, RegExp> = {
        nda: /\b(nda|confidencialidade)\b/i,
        contrato_novo: /(presta[cç][aã]o|servi[cç]o|fornecedor|msa|contrato padr[aã]o)/i,
        revisao: /(presta[cç][aã]o|servi[cç]o|fornecedor|msa|cliente)/i,
        aditivo: /(aditivo|renova[cç][aã]o)/i,
        parecer: /(parecer)/i,
        outro: /$^/,
    };
    const match = (data as { id: string; name: string }[]).find((p) => words[kind].test(p.name));
    return match ?? null;
}

/**
 * Job handler (kind "request.triage"). Idempotent: a triage already decided
 * by the Head is never overwritten, and re-running an undecided one replaces
 * the suggestion with an identical or fresher one.
 */
export async function handleRequestTriage(
    db: Db,
    job: { payload: Record<string, unknown>; id?: string },
): Promise<Record<string, unknown>> {
    const requestId = String(job.payload.request_id ?? "");
    const { data, error } = await db
        .from("legal_requests")
        .select(REQUEST_COLUMNS)
        .eq("id", requestId)
        .maybeSingle();
    if (error) throw error;
    const row = data as unknown as RequestRow | null;
    if (!row || !row.project_id) return { skipped: "missing" };
    if (row.triage && (row.triage as { decision?: unknown }).decision) return { skipped: "decided" };

    const runId = await startAgentRun(db, {
        projectId: row.project_id,
        orgId: row.org_id,
        agent: TRIAGE_AGENT,
        agentVersion: TRIAGE_AGENT_VERSION,
        jobId: job.id ?? null,
    });
    const started = Date.now();

    let output: TriageModelOutput = {
        kind: null,
        counterparty: null,
        area: null,
        summary: null,
        missing: [],
    };
    let usedModel: string | null = null;
    try {
        const selected = await triageModel(db, row.org_id);
        if (selected) {
            const raw = await completeText({
                model: selected.model,
                systemPrompt: SYSTEM,
                user: [
                    `Tipo escolhido por quem pediu: ${KIND_LABELS[row.kind as RequestKind] ?? row.kind}`,
                    `Título: ${row.title}`,
                    row.counterparty ? `Contraparte informada: ${row.counterparty}` : "",
                    `Urgência: ${row.urgency}${row.needed_by ? ` · precisa até ${row.needed_by}` : ""}`,
                    `Contexto:\n${row.context || "(vazio)"}`,
                ]
                    .filter(Boolean)
                    .join("\n"),
                maxTokens: 600,
                apiKeys: selected.apiKeys,
            });
            output = parseTriage(raw);
            usedModel = selected.model;
        }
    } catch (err) {
        // The model is a convenience, not a gate: the rule-based part of the
        // triage (assignee, playbook) still lands, and the card says so.
        console.error("[requests] triage model failed", { requestId, error: safeError(err) });
    }

    const kind = output.kind ?? (row.kind as RequestKind);
    const [members, workload, playbook] = await Promise.all([
        loadTeamMembers(db, row.org_id),
        loadWorkload(db, row.org_id, kind, row.id),
        suggestPlaybook(db, row.org_id, kind),
    ]);
    const assignee = suggestAssignee(members, workload.openByUser, workload.lastKindHandler, kind);

    const triage = {
        kind,
        kind_changed: kind !== row.kind,
        counterparty: output.counterparty ?? row.counterparty,
        area: output.area,
        missing: output.missing,
        assignee_id: assignee?.user_id ?? null,
        assignee_name: assignee?.name ?? null,
        assignee_reason: assignee?.reason ?? null,
        playbook_id: playbook?.id ?? null,
        playbook_name: playbook?.name ?? null,
        ai: usedModel !== null,
        run_id: runId,
        suggested_at: new Date().toISOString(),
        decision: null,
    };

    const { data: team } = await db
        .from("legal_teams")
        .select("auto_assign")
        .eq("org_id", row.org_id)
        .maybeSingle();
    const autoAssign = !!(team as { auto_assign?: boolean } | null)?.auto_assign && !!assignee && !row.assignee_id;

    const readArea = normalizeArea(output.area);
    const fillArea = !row.requester_area && readArea && readArea !== "Outra";
    const patch: Record<string, unknown> = {
        triage,
        summary: output.summary ?? row.summary,
        ...(fillArea ? { requester_area: readArea, requester_area_source: "triagem" } : {}),
        status: row.status === "novo" ? "em_triagem" : row.status,
        updated_at: new Date().toISOString(),
    };
    if (autoAssign) {
        patch.assignee_id = assignee!.user_id;
        patch.assigned_at = new Date().toISOString();
    }
    const { error: updateError } = await db.from("legal_requests").update(patch).eq("id", row.id);
    if (updateError) {
        await finishAgentRun(db, runId, { status: "failed", error: "update_failed" });
        throw updateError;
    }

    await recordCardEvent(db, {
        projectId: row.project_id,
        orgId: row.org_id,
        actorType: "agent",
        actorId: `agent:${TRIAGE_AGENT}@${TRIAGE_AGENT_VERSION}`,
        actorName: TRIAGE_AGENT_NAME,
        action: "request.triaged",
        after: {
            kind,
            counterparty: triage.counterparty,
            missing: triage.missing.length,
            playbook: triage.playbook_name,
            ai: triage.ai,
        },
        runId,
        source: "agent",
    });
    if (assignee) {
        await recordCardEvent(db, {
            projectId: row.project_id,
            orgId: row.org_id,
            actorType: "agent",
            actorId: "agent:atribuicao@1",
            actorName: ASSIGNMENT_AGENT_NAME,
            action: autoAssign ? "assignee.changed" : "assignee.suggested",
            field: "assignee",
            after: { name: assignee.name, reason: assignee.reason },
            runId,
            source: "agent",
        });
    }
    if (fillArea) await db.from("projects").update({ requester_area: readArea }).eq("id", row.project_id);
    if (autoAssign) {
        await db
            .from("projects")
            .update({ assignee_email: members.find((m) => m.user_id === assignee!.user_id)?.email ?? null })
            .eq("id", row.project_id);
    }

    await finishAgentRun(db, runId, {
        status: "succeeded",
        output: { kind, missing: triage.missing.length, assignee: !!assignee, playbook: !!playbook },
        modelResolved: usedModel,
        latencyMs: Date.now() - started,
    });
    return { triaged: true, auto_assigned: autoAssign };
}
