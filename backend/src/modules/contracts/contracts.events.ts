// The contract pipeline's activity log (card_events) and agent runs.
//
// Every change to a card — by a person, an agent, the system or the Hermes
// bot — is one append-only event, so people and agents share one timeline.
// Writing an event never fails the change it describes: the log is a record
// of the work, not a precondition for it.

import type { Db } from "../../lib/supabase";
import { safeError } from "../../lib/safeError";
import { internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { requireProjectView, type Caller } from "./contracts.shared";

export const ACTOR_TYPES = ["user", "agent", "system", "hermes"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const EVENT_SOURCES = ["ui", "mcp", "notion", "cron", "agent", "api"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export type CardEventInput = {
    projectId: string;
    actorType: ActorType;
    /** user id | 'agent:revisor@1' | 'hermes:docbot' | 'cron:vigia' */
    actorId: string;
    /** Display name for the feed ("Agente de revisão", a requester's name). */
    actorName?: string | null;
    action: string;
    field?: string | null;
    before?: unknown;
    after?: unknown;
    runId?: string | null;
    source?: EventSource;
    onBehalfOf?: string | null;
    orgId?: string | null;
};

export type CardEvent = {
    id: number;
    project_id: string;
    at: string;
    actor_type: ActorType;
    actor_id: string;
    actor_name: string | null;
    on_behalf_of: string | null;
    action: string;
    field: string | null;
    before: unknown;
    after: unknown;
    run_id: string | null;
    source: EventSource;
};

const EVENT_COLUMNS =
    "id, project_id, at, actor_type, actor_id, actor_name, on_behalf_of, action, field, before, after, run_id, source";

/** Append one event. Returns its id, or null when it could not be written. */
export async function recordCardEvent(db: Db, input: CardEventInput): Promise<number | null> {
    const { data, error } = await db
        .from("card_events")
        .insert({
            project_id: input.projectId,
            org_id: input.orgId ?? null,
            actor_type: input.actorType,
            actor_id: input.actorId,
            actor_name: input.actorName ?? null,
            on_behalf_of: input.onBehalfOf ?? null,
            action: input.action,
            field: input.field ?? null,
            before: input.before ?? null,
            after: input.after ?? null,
            run_id: input.runId ?? null,
            source: input.source ?? (input.actorType === "agent" ? "agent" : "ui"),
        })
        .select("id")
        .single();
    if (error) {
        console.error("[card_events] insert failed", {
            action: input.action,
            error: safeError(error),
        });
        return null;
    }
    return (data as { id: number }).id;
}

/** A card's events, newest first. */
export async function listCardEvents(
    db: Db,
    caller: Caller,
    projectId: string,
    limit = 50,
): Promise<ServiceResult<CardEvent[]>> {
    const access = await requireProjectView(db, caller, projectId);
    if (!access.ok) return access;
    const { data, error } = await db
        .from("card_events")
        .select(EVENT_COLUMNS)
        .eq("project_id", projectId)
        .order("at", { ascending: false })
        .limit(Math.min(Math.max(1, Math.trunc(limit) || 50), 200));
    if (error) return internalFailure(error);
    return ok((data ?? []) as unknown as CardEvent[]);
}

export type AgentRunInput = {
    projectId: string;
    agent: string;
    agentVersion: string;
    jobId?: string | null;
    dedupeKey?: string | null;
    modelAlias?: string | null;
    inputDocSha?: string | null;
    orgId?: string | null;
};

/** Open a run; throws, because an agent must not work without its record. */
export async function startAgentRun(db: Db, input: AgentRunInput): Promise<string> {
    const { data, error } = await db
        .from("agent_runs")
        .insert({
            project_id: input.projectId,
            org_id: input.orgId ?? null,
            agent: input.agent,
            agent_version: input.agentVersion,
            job_id: input.jobId ?? null,
            dedupe_key: input.dedupeKey ?? null,
            model_alias: input.modelAlias ?? null,
            input_doc_sha: input.inputDocSha ?? null,
            status: "running",
        })
        .select("id")
        .single();
    if (error) throw error;
    return (data as { id: string }).id;
}

export type AgentRunOutcome = {
    status: "succeeded" | "failed" | "skipped" | "needs_human";
    output?: Record<string, unknown> | null;
    error?: string | null;
    modelResolved?: string | null;
    latencyMs?: number | null;
};

/** Close a run. Best-effort: a failed close must not fail the agent's work. */
export async function finishAgentRun(
    db: Db,
    runId: string,
    outcome: AgentRunOutcome,
): Promise<void> {
    const { error } = await db
        .from("agent_runs")
        .update({
            status: outcome.status,
            output: outcome.output ?? null,
            error: outcome.error ?? null,
            model_resolved: outcome.modelResolved ?? null,
            latency_ms: outcome.latencyMs ?? null,
            finished_at: new Date().toISOString(),
        })
        .eq("id", runId);
    if (error) {
        console.error("[agent_runs] close failed", { runId, error: safeError(error) });
    }
}
