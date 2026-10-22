// Requests to the legal team: create, read, list, and the team's moves on
// them (assign, decide the triage, ask, deliver, invite).
//
// The functions take the caller's identity and return plain data, so the
// HTTP routes and — later — the MCP tools a chat bot calls share them
// (createRequest, getRequestStatus, listMyRequests are the MCP surface).

import type { Db } from "../../lib/supabase";
import { enqueueDbJob } from "../../lib/dbq/enqueue";
import { normalizeEmail } from "../../lib/access";
import { safeError } from "../../lib/safeError";
import {
    failure,
    internalFailure,
    ok,
    type ServiceResult,
} from "../../lib/serviceResult";
import { recordCardEvent } from "../contracts/contracts.service";
import {
    HEAD_ONLY,
    isHead,
    isTeam,
    loadLegalTeam,
    loadRequestFor,
    NO_LEGAL_TEAM,
    REQUEST_COLUMNS,
    teamRole,
    TEAM_ONLY,
    type Audience,
    type Caller,
    type RequestRow,
} from "./requests.access";
import { queueNotifications } from "./requests.notifications";
import {
    cleanText,
    computeDueAt,
    normalizeArea,
    type RequesterArea,
    effectiveDueAt,
    isEmail,
    KIND_LABELS,
    OPEN_STATUSES,
    REQUEST_KINDS,
    REQUESTER_AREAS,
    requestCode,
    requesterStep,
    slaState,
    URGENCIES,
    type RequestKind,
    type RequestStatus,
    type Urgency,
} from "./requests.shared";
import { loadTeamMembers, TRIAGE_AGENT_NAME } from "./requests.triage";
import { loadTemplate, queueIntakePrefill } from "./requests.checklist";
import { applyAnswers, intakeStatus } from "./requests.intake";

export const TRIAGE_JOB_KIND = "request.triage";

const MAX_ATTACHMENTS = 5;

export type CreateRequestInput = {
    kind?: unknown;
    title?: unknown;
    counterparty?: unknown;
    context?: unknown;
    urgency?: unknown;
    needed_by?: unknown;
    /** Standalone documents the requester uploaded first. */
    document_ids?: unknown;
    requester_name?: unknown;
    /** The requesting area; remembered for next time. The chat bot sends it from the person's profile. */
    requester_area?: unknown;
    /** {channel: "form" | "slack" | "whatsapp" | "email" | "mcp" | "sistema", ...}; "sistema" is the platform itself (a renewal opened by a contract's end). */
    source?: unknown;
    /** Checklist answers given with the request: {key: value | {value, detail}}. */
    intake?: unknown;
    idempotency_key?: unknown;
};

/** What a requester and an invited participant may see. */
export type RequestPublicView = {
    id: string;
    code: string;
    title: string;
    kind: string;
    kind_label: string;
    counterparty: string | null;
    context: string;
    urgency: string;
    needed_by: string | null;
    status: string;
    step: ReturnType<typeof requesterStep>;
    due_at: string;
    sla: ReturnType<typeof slaState>;
    summary: string | null;
    assignee_name: string | null;
    requester_name: string | null;
    requester_email: string;
    requester_area: string | null;
    delivery: { message: string | null; delivered_at: string | null; documents: { id: string; filename: string }[] } | null;
    messages: RequestMessage[];
    created_at: string;
    updated_at: string;
    audience: Audience["kind"];
};

/** What the team sees on top of it. */
export type RequestTeamView = RequestPublicView & {
    number: number;
    project_id: string | null;
    lane: string | null;
    assignee_id: string | null;
    triage: Record<string, unknown> | null;
    participants: Participant[];
    source: Record<string, unknown>;
    can_decide: boolean;
    /** The intake checklist closed (the contract analysis may run). */
    intake_completed_at: string | null;
    /** The analysis found a critical risk and the Head was alerted. */
    critical_alert_at: string | null;
};

export type RequestMessage = {
    id: string;
    kind: "question" | "answer" | "note";
    body: string;
    author_name: string | null;
    author_email: string;
    created_at: string;
};

export type Participant = {
    id: string;
    email: string;
    role: "external" | "viewer";
    label: string | null;
    expires_at: string;
    revoked_at: string | null;
};

function sourceOf(value: unknown): Record<string, unknown> {
    const allowed = ["form", "slack", "whatsapp", "email", "mcp", "sistema"];
    if (!value || typeof value !== "object") return { channel: "form" };
    const src = value as Record<string, unknown>;
    const channel = allowed.includes(String(src.channel)) ? String(src.channel) : "form";
    const out: Record<string, unknown> = { channel };
    for (const key of ["channel_id", "thread_ts", "permalink", "bot"]) {
        const v = cleanText(src[key], 500);
        if (v) out[key] = v;
    }
    return out;
}

function validateCreate(input: CreateRequestInput):
    | {
          ok: true;
          kind: RequestKind;
          title: string;
          counterparty: string | null;
          context: string;
          urgency: Urgency;
          neededBy: string | null;
          documentIds: string[];
      }
    | { ok: false; detail: string } {
    const kind = REQUEST_KINDS.includes(input.kind as RequestKind) ? (input.kind as RequestKind) : null;
    if (!kind) return { ok: false, detail: "Escolha o tipo de pedido." };
    const context = cleanText(input.context, 8000) ?? "";
    const counterparty = cleanText(input.counterparty, 200);
    // A title is optional on the form: the kind and the counterparty make one.
    const title =
        cleanText(input.title, 200) ??
        (counterparty ? `${KIND_LABELS[kind]} · ${counterparty}` : KIND_LABELS[kind]);
    if (!context && !counterparty && !cleanText(input.title, 200)) {
        return { ok: false, detail: "Conte em uma frase o que você precisa." };
    }
    const urgency = URGENCIES.includes(input.urgency as Urgency) ? (input.urgency as Urgency) : "normal";
    let neededBy: string | null = null;
    if (input.needed_by !== undefined && input.needed_by !== null && input.needed_by !== "") {
        if (typeof input.needed_by !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.needed_by)) {
            return { ok: false, detail: "Escolha uma data válida em “Precisa até”." };
        }
        neededBy = input.needed_by;
    }
    const documentIds = Array.isArray(input.document_ids)
        ? [...new Set(input.document_ids.filter((d): d is string => typeof d === "string" && /^[0-9a-f-]{36}$/i.test(d)))]
        : [];
    if (documentIds.length > MAX_ATTACHMENTS) {
        return { ok: false, detail: `Anexe no máximo ${MAX_ATTACHMENTS} arquivos.` };
    }
    return { ok: true, kind, title, counterparty, context, urgency, neededBy, documentIds };
}

/**
 * Move the requester's freshly uploaded standalone files onto the card. Only
 * files they uploaded, still standalone, and either personal or already in
 * the legal team's workspace — never another organization's content.
 */
async function attachRequesterDocuments(
    db: Db,
    caller: Caller,
    projectId: string,
    teamOrgId: string,
    documentIds: string[],
): Promise<number> {
    if (documentIds.length === 0) return 0;
    const { data, error } = await db
        .from("documents")
        .select("id, user_id, project_id, workflow_id, org_id, organizations(kind, personal_user_id)")
        .in("id", documentIds);
    if (error) throw error;
    const movable = ((data ?? []) as unknown as {
        id: string;
        user_id: string | null;
        project_id: string | null;
        workflow_id: string | null;
        org_id: string | null;
        organizations: { kind: string; personal_user_id: string | null } | null;
    }[])
        .filter(
            (d) =>
                d.user_id === caller.userId &&
                !d.project_id &&
                !d.workflow_id &&
                (!d.org_id ||
                    d.org_id === teamOrgId ||
                    (d.organizations?.kind === "personal" && d.organizations.personal_user_id === caller.userId)),
        )
        .map((d) => d.id);
    if (movable.length === 0) return 0;
    const { error: moveError } = await db
        .from("documents")
        .update({ project_id: projectId, library_folder_id: null, updated_at: new Date().toISOString() })
        .in("id", movable);
    if (moveError) throw moveError;
    return movable.length;
}

/**
 * The requesting area of a new request: what the person chose (or the chat
 * bot sent) wins and is remembered; without it, the area remembered from
 * their last request; without that, nothing (the triage agent may read one
 * from the text later, as the weakest source).
 */
async function resolveArea(
    db: Db,
    caller: Caller,
    given: unknown,
    channel: string,
): Promise<{ area: RequesterArea | null; source: "form" | "slack" | "perfil" | null }> {
    // The platform has no requesting area, and must not borrow the one
    // remembered for the person it acts through.
    if (channel === "sistema") return { area: null, source: null };
    const area = normalizeArea(given);
    if (area) {
        const { error } = await db
            .from("legal_requester_areas")
            .upsert({ user_id: caller.userId, area, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
        if (error) console.error("[requests] remember area failed", { error: safeError(error) });
        return { area, source: channel === "form" ? "form" : "slack" };
    }
    const { data } = await db
        .from("legal_requester_areas")
        .select("area")
        .eq("user_id", caller.userId)
        .maybeSingle();
    const remembered = normalizeArea((data as { area?: string } | null)?.area);
    return remembered ? { area: remembered, source: "perfil" } : { area: null, source: null };
}

/**
 * Anyone signed in asks the legal team. Creates the request, its card on the
 * pipeline's first lane (in the team's organization, visible to the team),
 * logs it, mails the requester and queues the triage agent.
 *
 * MCP: `mike_request_analysis` calls this with `source` and an
 * `idempotency_key`; a repeated key returns the request already created.
 */
export async function createRequest(
    db: Db,
    caller: Caller,
    input: CreateRequestInput,
): Promise<ServiceResult<{ request: RequestPublicView; deduplicated: boolean }>> {
    const requesterEmail = normalizeEmail(caller.userEmail);
    if (!requesterEmail) return failure("validation", "Sua conta não tem e-mail.");
    const valid = validateCreate(input);
    if (!valid.ok) return failure("validation", valid.detail);

    let team;
    try {
        team = await loadLegalTeam(db);
    } catch (error) {
        return internalFailure(error);
    }
    if (!team) return NO_LEGAL_TEAM;

    const idempotencyKey = cleanText(input.idempotency_key, 200);
    if (idempotencyKey) {
        const { data: existing, error } = await db
            .from("legal_requests")
            .select("id")
            .eq("idempotency_key", idempotencyKey)
            .maybeSingle();
        if (error) return internalFailure(error);
        if (existing) {
            const view = await getRequest(db, caller, (existing as { id: string }).id);
            if (!view.ok) return view;
            return ok({ request: view.data, deduplicated: true });
        }
    }

    const now = new Date();
    const dueAt = computeDueAt(now, valid.kind, valid.urgency, valid.neededBy, team.sla_days);
    const requesterName = cleanText(input.requester_name, 120);
    const channelOf = String(sourceOf(input.source).channel);
    const area = await resolveArea(db, caller, input.requester_area, channelOf);

    // The card: a project in the team's organization, open to the whole team,
    // on the first lane. Created through the same RPC as any project (it
    // writes the project's memory setting in the same transaction; memory is
    // off: a request is not a matter to learn from). The requester is its
    // creator only as provenance — organization scope admits members alone
    // (lib/access.ts), and they are not one.
    const { data: createdProject, error: projectError } = await db.rpc("create_project_with_memory", {
        p_user_id: caller.userId,
        p_name: valid.title,
        p_cm_number: null,
        p_practice: null,
        p_org_id: team.org_id,
        p_memory_enabled: false,
    });
    const project = Array.isArray(createdProject) ? createdProject[0] : createdProject;
    if (projectError || !project) return internalFailure(projectError);
    const projectId = (project as { id: string }).id;
    const { error: cardError } = await db
        .from("projects")
        .update({
            visibility: "organization",
            counterparty: valid.counterparty,
            contract_type: KIND_LABELS[valid.kind],
            lane: "entrada",
            lane_updated_at: now.toISOString(),
            status: "a_fazer",
            priority: valid.urgency === "normal" ? "media" : "alta",
            deadline: dueAt.toISOString().slice(0, 10),
            requester_name: requesterName ?? requesterEmail,
            requester_area: area.area,
        })
        .eq("id", projectId);
    if (cardError) {
        await db.from("projects").delete().eq("id", projectId);
        return internalFailure(cardError);
    }

    const { data: created, error: insertError } = await db
        .from("legal_requests")
        .insert({
            org_id: team.org_id,
            project_id: projectId,
            requester_id: caller.userId,
            requester_email: requesterEmail,
            requester_name: requesterName,
            requester_area: area.area,
            requester_area_source: area.source,
            kind: valid.kind,
            title: valid.title,
            counterparty: valid.counterparty,
            context: valid.context,
            urgency: valid.urgency,
            needed_by: valid.neededBy,
            due_at: dueAt.toISOString(),
            source: sourceOf(input.source),
            idempotency_key: idempotencyKey,
        })
        .select(REQUEST_COLUMNS)
        .single();
    if (insertError || !created) {
        // Do not leave an orphan card behind a failed request.
        await db.from("projects").delete().eq("id", projectId);
        return internalFailure(insertError);
    }
    const row = created as unknown as RequestRow;

    let attached = 0;
    try {
        attached = await attachRequesterDocuments(db, caller, projectId, team.org_id, valid.documentIds);
    } catch (error) {
        console.error("[requests] attach failed", { requestId: row.id, error: safeError(error) });
    }

    const channel = String(row.source.channel ?? "form");
    await recordCardEvent(db, {
        projectId,
        orgId: team.org_id,
        // The platform opening a renewal is the system, not a chat bot acting for someone.
        actorType: channel === "sistema" ? "system" : channel === "slack" || channel === "whatsapp" || channel === "mcp" ? "hermes" : "user",
        actorId: channel === "sistema" ? `system:${String(row.source.bot ?? "sistema")}` : channel === "form" ? caller.userId : `hermes:${String(row.source.bot ?? channel)}`,
        actorName: requesterName ?? requesterEmail,
        onBehalfOf: channel === "form" || channel === "sistema" ? null : requesterEmail,
        action: "request.created",
        after: { code: requestCode(row.number), kind: valid.kind, channel, attachments: attached },
        source: channel === "sistema" ? "cron" : channel === "form" ? "ui" : "mcp",
    });
    await queueNotifications(db, [
        {
            requestId: row.id,
            number: row.number,
            title: row.title,
            template: "request.created",
            recipient: requesterEmail,
            dedupeKey: `created:${row.id}`,
            payload: { due: dueAt.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) },
        },
    ]);
    try {
        await enqueueDbJob(db, {
            kind: TRIAGE_JOB_KIND,
            payload: { request_id: row.id },
            dedupeKey: `triage:${row.id}`,
        });
    } catch (error) {
        console.error("[requests] triage enqueue failed", { requestId: row.id, error: safeError(error) });
    }

    // Checklist answers given on the form count as the requester's; the
    // intake agent then reads the attached contract for what is still open.
    if (input.intake && typeof input.intake === "object") {
        try {
            const template = await loadTemplate(db, team.org_id);
            const applied = applyAnswers(template.items, {}, { answers: input.intake }, new Date().toISOString());
            if (applied.ok && applied.changed.length) {
                const complete = intakeStatus(template.items, applied.answers).complete;
                await db
                    .from("legal_requests")
                    .update({ intake: applied.answers, ...(complete ? { intake_completed_at: new Date().toISOString() } : {}) })
                    .eq("id", row.id);
            }
        } catch (error) {
            console.error("[requests] intake on create failed", { requestId: row.id, error: safeError(error) });
        }
    }
    if (attached > 0) await queueIntakePrefill(db, row.id);

    const view = await getRequest(db, caller, row.id);
    if (!view.ok) return view;
    return ok({ request: view.data, deduplicated: false });
}

async function loadMessages(db: Db, requestId: string): Promise<RequestMessage[]> {
    const { data, error } = await db
        .from("legal_request_messages")
        .select("id, kind, body, author_name, author_email, created_at")
        .eq("request_id", requestId)
        .order("created_at", { ascending: true })
        .limit(200);
    if (error) throw error;
    return (data ?? []) as RequestMessage[];
}

async function loadDeliveryDocs(
    db: Db,
    ids: string[],
): Promise<{ id: string; filename: string }[]> {
    if (ids.length === 0) return [];
    const { data, error } = await db
        .from("documents")
        .select("id, current_version_id")
        .in("id", ids);
    if (error) throw error;
    const versionIds = ((data ?? []) as { id: string; current_version_id: string | null }[])
        .map((d) => d.current_version_id)
        .filter((v): v is string => !!v);
    if (versionIds.length === 0) return [];
    const { data: versions, error: vError } = await db
        .from("document_versions")
        .select("document_id, filename")
        .in("id", versionIds);
    if (vError) throw vError;
    return ((versions ?? []) as { document_id: string; filename: string | null }[]).map((v) => ({
        id: v.document_id,
        filename: v.filename ?? "documento",
    }));
}

async function displayName(db: Db, userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const { data } = await db
        .from("user_profiles")
        .select("display_name, email")
        .eq("user_id", userId)
        .maybeSingle();
    const p = data as { display_name: string | null; email: string | null } | null;
    return p?.display_name?.trim() || p?.email?.split("@")[0] || null;
}

async function buildView(
    db: Db,
    row: RequestRow,
    audience: Audience,
    now = new Date(),
): Promise<RequestPublicView | RequestTeamView> {
    const [messages, assigneeName, lane, deliveryDocs] = await Promise.all([
        loadMessages(db, row.id),
        displayName(db, row.assignee_id),
        row.project_id
            ? db
                  .from("projects")
                  .select("lane")
                  .eq("id", row.project_id)
                  .maybeSingle()
                  .then(({ data }) => ((data as { lane?: string | null } | null)?.lane ?? null))
            : Promise.resolve(null),
        loadDeliveryDocs(db, ((row.delivery?.document_ids as string[] | undefined) ?? []).slice(0, 10)),
    ]);
    const clock = {
        due_at: row.due_at,
        status: row.status as RequestStatus,
        paused_at: row.paused_at,
        paused_seconds: row.paused_seconds,
    };
    const base: RequestPublicView = {
        id: row.id,
        code: requestCode(row.number),
        title: row.title,
        kind: row.kind,
        kind_label: KIND_LABELS[row.kind as RequestKind] ?? row.kind,
        counterparty: row.counterparty,
        context: row.context,
        urgency: row.urgency,
        needed_by: row.needed_by,
        status: row.status,
        step: requesterStep(row.status as RequestStatus, lane),
        due_at: effectiveDueAt(clock, now).toISOString(),
        sla: slaState(clock, now),
        summary: row.summary,
        assignee_name: assigneeName,
        requester_name: row.requester_name,
        requester_email: row.requester_email,
        requester_area: row.requester_area,
        delivery: row.delivered_at
            ? {
                  message: (row.delivery?.message as string | null | undefined) ?? null,
                  delivered_at: row.delivered_at,
                  documents: deliveryDocs,
              }
            : null,
        messages,
        created_at: row.created_at,
        updated_at: row.updated_at,
        audience: audience.kind,
    };
    if (!isTeam(audience)) return base;

    const { data: participants, error } = await db
        .from("legal_request_participants")
        .select("id, email, role, label, expires_at, revoked_at")
        .eq("request_id", row.id)
        .order("created_at", { ascending: true });
    if (error) throw error;
    return {
        ...base,
        number: row.number,
        project_id: row.project_id,
        lane,
        assignee_id: row.assignee_id,
        triage: row.triage,
        participants: (participants ?? []) as Participant[],
        source: row.source,
        can_decide: isHead(audience),
        intake_completed_at: row.intake_completed_at,
        critical_alert_at: row.critical_alert_at,
    };
}

/** One request, in the shape the caller's audience may see. MCP: `mike_get_request_status`. */
export async function getRequest(
    db: Db,
    caller: Caller,
    requestId: string,
): Promise<ServiceResult<RequestPublicView | RequestTeamView>> {
    const loaded = await loadRequestFor(db, caller, requestId);
    if (!loaded.ok) return loaded;
    try {
        return ok(await buildView(db, loaded.row, loaded.audience));
    } catch (error) {
        return internalFailure(error);
    }
}

export type RequestListItem = {
    id: string;
    code: string;
    title: string;
    kind: string;
    kind_label: string;
    counterparty: string | null;
    status: string;
    sla: ReturnType<typeof slaState>;
    due_at: string;
    requester_name: string | null;
    requester_email: string;
    requester_area: string | null;
    assignee_id: string | null;
    assignee_name: string | null;
    suggested_assignee_name: string | null;
    /** The triage agent has finished (a suggestion exists, decided or not). */
    triaged: boolean;
    triage_pending: boolean;
    channel: string;
    project_id: string | null;
    external: boolean;
    created_at: string;
    updated_at: string;
};

export type RequestList = {
    /** "team" lists the queue; "requester" lists only the caller's own. */
    scope: "team" | "requester";
    is_head: boolean;
    items: RequestListItem[];
    counts: {
        sem_dono: number;
        sla_estourando: number;
        aguardando_solicitante: number;
        concluidos_semana: number;
        meus: number;
    };
    team: { id: string; name: string; email: string }[];
};

/**
 * The list behind /pedidos. A team member gets the whole queue (filters run
 * in the client: it is tens of rows, not thousands); anyone else gets the
 * requests they asked for or were invited to.
 * MCP: `mike_list_my_requests` is the requester branch.
 */
export async function listRequests(
    db: Db,
    caller: Caller,
    options: { mine?: boolean } = {},
): Promise<ServiceResult<RequestList>> {
    let team;
    try {
        team = await loadLegalTeam(db);
    } catch (error) {
        return internalFailure(error);
    }
    if (!team) return NO_LEGAL_TEAM;
    const role = await teamRole(db, caller, team.org_id);
    const email = normalizeEmail(caller.userEmail);
    const now = new Date();

    let rows: RequestRow[] = [];
    const externalIds = new Set<string>();
    if (role && !options.mine) {
        const { data, error } = await db
            .from("legal_requests")
            .select(REQUEST_COLUMNS)
            .eq("org_id", team.org_id)
            .order("created_at", { ascending: false })
            .limit(500);
        if (error) return internalFailure(error);
        rows = (data ?? []) as unknown as RequestRow[];
        const ids = rows.map((r) => r.id);
        if (ids.length) {
            const { data: ext } = await db
                .from("legal_request_participants")
                .select("request_id")
                .in("request_id", ids)
                .is("revoked_at", null);
            for (const r of (ext ?? []) as { request_id: string }[]) externalIds.add(r.request_id);
        }
    } else {
        const { data: own, error } = await db
            .from("legal_requests")
            .select(REQUEST_COLUMNS)
            .or(`requester_id.eq.${caller.userId}${email ? `,requester_email.eq.${email}` : ""}`)
            .order("created_at", { ascending: false })
            .limit(200);
        if (error) return internalFailure(error);
        rows = (own ?? []) as unknown as RequestRow[];
        if (email) {
            const { data: invited } = await db
                .from("legal_request_participants")
                .select("request_id, expires_at")
                .eq("email", email)
                .is("revoked_at", null);
            const liveIds = ((invited ?? []) as { request_id: string; expires_at: string }[])
                .filter((i) => new Date(i.expires_at) > now)
                .map((i) => i.request_id)
                .filter((id) => !rows.some((r) => r.id === id));
            if (liveIds.length) {
                const { data: guestRows, error: guestError } = await db
                    .from("legal_requests")
                    .select(REQUEST_COLUMNS)
                    .in("id", liveIds);
                if (guestError) return internalFailure(guestError);
                rows.push(...((guestRows ?? []) as unknown as RequestRow[]));
            }
        }
    }

    let members: { user_id: string; email: string; name: string }[] = [];
    try {
        members = role ? await loadTeamMembers(db, team.org_id) : [];
    } catch (error) {
        return internalFailure(error);
    }
    const nameOf = new Map(members.map((m) => [m.user_id, m.name]));
    if (!role) {
        // A requester sees the name of whoever took their request, nothing else of the team.
        const assigneeIds = [...new Set(rows.map((r) => r.assignee_id).filter((v): v is string => !!v))];
        if (assigneeIds.length) {
            const { data: profiles } = await db
                .from("user_profiles")
                .select("user_id, display_name, email")
                .in("user_id", assigneeIds);
            for (const p of (profiles ?? []) as { user_id: string; display_name: string | null; email: string | null }[]) {
                nameOf.set(p.user_id, p.display_name?.trim() || p.email?.split("@")[0] || "Legal");
            }
        }
    }

    const weekAgo = now.getTime() - 7 * 24 * 3600 * 1000;
    const items: RequestListItem[] = rows.map((r) => {
        const clock = {
            due_at: r.due_at,
            status: r.status as RequestStatus,
            paused_at: r.paused_at,
            paused_seconds: r.paused_seconds,
        };
        const triage = r.triage as { assignee_name?: string | null; decision?: string | null } | null;
        return {
            id: r.id,
            code: requestCode(r.number),
            title: r.title,
            kind: r.kind,
            kind_label: KIND_LABELS[r.kind as RequestKind] ?? r.kind,
            counterparty: r.counterparty,
            status: r.status,
            sla: slaState(clock, now),
            due_at: effectiveDueAt(clock, now).toISOString(),
            requester_name: r.requester_name,
            requester_email: r.requester_email,
            requester_area: r.requester_area,
            assignee_id: role ? r.assignee_id : null,
            assignee_name: r.assignee_id ? (nameOf.get(r.assignee_id) ?? null) : null,
            suggested_assignee_name: role && triage && !triage.decision ? (triage.assignee_name ?? null) : null,
            triaged: !!triage,
            triage_pending: !!role && !!triage && !triage.decision,
            channel: String(r.source?.channel ?? "form"),
            project_id: role ? r.project_id : null,
            external: externalIds.has(r.id),
            created_at: r.created_at,
            updated_at: r.updated_at,
        };
    });
    const open = items.filter((i) => OPEN_STATUSES.includes(i.status as RequestStatus));
    return ok({
        scope: role && !options.mine ? "team" : "requester",
        is_head: role === "owner" || role === "admin",
        items,
        counts: {
            sem_dono: open.filter((i) => !i.assignee_id).length,
            sla_estourando: open.filter((i) => i.sla === "estourando" || i.sla === "estourado").length,
            aguardando_solicitante: open.filter((i) => i.status === "aguardando_solicitante").length,
            concluidos_semana: items.filter(
                (i) => i.status === "entregue" && new Date(i.updated_at).getTime() >= weekAgo,
            ).length,
            meus: open.filter((i) => i.assignee_id === caller.userId).length,
        },
        team: members.map((m) => ({ id: m.user_id, name: m.name, email: m.email })),
    });
}

async function teamCallerName(db: Db, caller: Caller): Promise<string> {
    return (await displayName(db, caller.userId)) ?? normalizeEmail(caller.userEmail) ?? "Legal";
}

async function updateRow(
    db: Db,
    id: string,
    patch: Record<string, unknown>,
): Promise<ServiceResult<RequestRow>> {
    const { data, error } = await db
        .from("legal_requests")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select(REQUEST_COLUMNS)
        .single();
    if (error || !data) return internalFailure(error);
    return ok(data as unknown as RequestRow);
}

/**
 * Give the request to a team member (or take it back to nobody). Any team
 * member can take or hand over: a small team does not wait on a manager.
 * The card follows: its assignee becomes the person, and a card still on
 * Entrada moves to Triagem as "em andamento".
 */
export async function assignRequest(
    db: Db,
    caller: Caller,
    requestId: string,
    body: { assignee_id?: unknown },
): Promise<ServiceResult<RequestTeamView>> {
    const loaded = await loadRequestFor(db, caller, requestId);
    if (!loaded.ok) return loaded;
    if (!isTeam(loaded.audience)) return TEAM_ONLY;
    const row = loaded.row;
    const assigneeId = body.assignee_id === null ? null : typeof body.assignee_id === "string" ? body.assignee_id : undefined;
    if (assigneeId === undefined) return failure("validation", "Escolha quem vai cuidar do pedido.");

    let members;
    try {
        members = await loadTeamMembers(db, row.org_id);
    } catch (error) {
        return internalFailure(error);
    }
    const member = assigneeId ? members.find((m) => m.user_id === assigneeId) : null;
    if (assigneeId && !member) return failure("validation", "Essa pessoa não é do time do Legal.");
    if (row.assignee_id === assigneeId) return getTeamView(db, caller, requestId);

    const status: RequestStatus =
        assigneeId && (row.status === "novo" || row.status === "em_triagem") ? "em_andamento" : (row.status as RequestStatus);
    const updated = await updateRow(db, row.id, {
        assignee_id: assigneeId,
        assigned_at: assigneeId ? new Date().toISOString() : null,
        status,
    });
    if (!updated.ok) return updated;

    if (row.project_id) {
        const cardPatch: Record<string, unknown> = {
            assignee_email: member?.email ?? null,
            updated_at: new Date().toISOString(),
        };
        if (assigneeId) cardPatch.status = "em_andamento";
        const { data: card } = await db.from("projects").select("lane").eq("id", row.project_id).maybeSingle();
        if (assigneeId && (card as { lane?: string } | null)?.lane === "entrada") {
            cardPatch.lane = "triagem";
            cardPatch.lane_updated_at = new Date().toISOString();
        }
        await db.from("projects").update(cardPatch).eq("id", row.project_id);
        await recordCardEvent(db, {
            projectId: row.project_id,
            orgId: row.org_id,
            actorType: "user",
            actorId: caller.userId,
            actorName: await teamCallerName(db, caller),
            action: "assignee.changed",
            field: "assignee",
            before: row.assignee_id ? { id: row.assignee_id } : null,
            after: member ? { id: member.user_id, name: member.name } : null,
        });
    }
    if (member) {
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
    }
    return getTeamView(db, caller, requestId);
}

async function getTeamView(db: Db, caller: Caller, requestId: string): Promise<ServiceResult<RequestTeamView>> {
    const view = await getRequest(db, caller, requestId);
    if (!view.ok) return view;
    return ok(view.data as RequestTeamView);
}

/**
 * The Head's verdict on the triage agent's suggestion: accept it as is, edit
 * it (any of kind, counterparty, assignee, playbook) or reject it. Accepting
 * or editing applies the values; rejecting only records the "no".
 */
export async function decideTriage(
    db: Db,
    caller: Caller,
    requestId: string,
    body: {
        decision?: unknown;
        kind?: unknown;
        counterparty?: unknown;
        assignee_id?: unknown;
        playbook_id?: unknown;
        reason?: unknown;
    },
): Promise<ServiceResult<RequestTeamView>> {
    const loaded = await loadRequestFor(db, caller, requestId);
    if (!loaded.ok) return loaded;
    if (!isTeam(loaded.audience)) return TEAM_ONLY;
    if (!isHead(loaded.audience)) return HEAD_ONLY;
    const row = loaded.row;
    const triage = row.triage as Record<string, unknown> | null;
    if (!triage) return failure("conflict", "A triagem ainda não terminou.");
    const decision = body.decision;
    if (decision === "reopened") {
        // Desfazer: the suggestion goes back to undecided. Values already
        // applied stay (the assignee has its own undo); the log keeps both.
        if (!triage.decision) return getTeamView(db, caller, requestId);
        const { decision: _d, decided_by: _b, decided_at: _a, edited: _e, reject_reason: _r, ...rest } = triage;
        const reopened = await updateRow(db, row.id, { triage: { ...rest, decision: null } });
        if (!reopened.ok) return reopened;
        if (row.project_id) {
            await recordCardEvent(db, {
                projectId: row.project_id,
                orgId: row.org_id,
                actorType: "user",
                actorId: caller.userId,
                actorName: await teamCallerName(db, caller),
                action: "triage.reopened",
                before: { decision: triage.decision },
            });
        }
        return getTeamView(db, caller, requestId);
    }
    if (decision !== "accepted" && decision !== "edited" && decision !== "rejected") {
        return failure("validation", "Escolha aceitar, ajustar ou recusar a triagem.");
    }

    const applied: Record<string, unknown> = {};
    if (decision !== "rejected") {
        const kind =
            decision === "edited" && body.kind !== undefined ? body.kind : (triage.kind as unknown);
        if (kind !== undefined && kind !== null) {
            if (!REQUEST_KINDS.includes(kind as RequestKind)) return failure("validation", "Tipo de pedido inválido.");
            applied.kind = kind;
        }
        const counterparty =
            decision === "edited" && body.counterparty !== undefined
                ? cleanText(body.counterparty, 200)
                : (triage.counterparty as string | null | undefined);
        if (counterparty !== undefined) applied.counterparty = counterparty;
    }

    const patch: Record<string, unknown> = {
        ...applied,
        triage: {
            ...triage,
            decision,
            decided_by: caller.userId,
            decided_at: new Date().toISOString(),
            ...(decision === "edited"
                ? {
                      edited: {
                          kind: applied.kind ?? null,
                          counterparty: applied.counterparty ?? null,
                          assignee_id: body.assignee_id ?? null,
                          playbook_id: body.playbook_id ?? null,
                      },
                  }
                : {}),
            ...(decision === "rejected" ? { reject_reason: cleanText(body.reason, 300) } : {}),
        },
    };
    const updated = await updateRow(db, row.id, patch);
    if (!updated.ok) return updated;

    if (row.project_id) {
        const cardPatch: Record<string, unknown> = {};
        if (applied.kind) cardPatch.contract_type = KIND_LABELS[applied.kind as RequestKind];
        if ("counterparty" in applied) cardPatch.counterparty = applied.counterparty;
        if (Object.keys(cardPatch).length) {
            await db.from("projects").update(cardPatch).eq("id", row.project_id);
        }
        await recordCardEvent(db, {
            projectId: row.project_id,
            orgId: row.org_id,
            actorType: "user",
            actorId: caller.userId,
            actorName: await teamCallerName(db, caller),
            action: `triage.${decision}`,
            after: { agent: TRIAGE_AGENT_NAME, ...applied, reason: cleanText(body.reason, 300) },
        });
    }

    // The assignee travels with the decision: the suggested one when
    // accepting, the chosen one when editing, nobody new when rejecting.
    if (decision !== "rejected") {
        const assigneeId =
            decision === "edited" && body.assignee_id !== undefined ? body.assignee_id : triage.assignee_id;
        if (typeof assigneeId === "string" && assigneeId !== row.assignee_id) {
            return assignRequest(db, caller, requestId, { assignee_id: assigneeId });
        }
    }
    return getTeamView(db, caller, requestId);
}

/**
 * A message on the request. From the team, `question` pauses the SLA and
 * mails the requester; from the requester (or an outside participant who
 * may answer), any message is an answer and resumes the clock.
 */
export async function postMessage(
    db: Db,
    caller: Caller,
    requestId: string,
    body: { body?: unknown; kind?: unknown },
): Promise<ServiceResult<RequestPublicView | RequestTeamView>> {
    const loaded = await loadRequestFor(db, caller, requestId);
    if (!loaded.ok) return loaded;
    const { row, audience } = loaded;
    if (audience.kind === "guest" && audience.role === "viewer") {
        return failure("forbidden", "Seu convite é só para acompanhar.");
    }
    const text = cleanText(body.body, 4000);
    if (!text) return failure("validation", "Escreva a mensagem.");
    if (row.status === "entregue" || row.status === "cancelado") {
        return failure("conflict", "Este pedido já foi encerrado.");
    }

    const fromTeam = isTeam(audience);
    const kind: RequestMessage["kind"] = fromTeam ? (body.kind === "question" ? "question" : "note") : "answer";
    const authorEmail = normalizeEmail(caller.userEmail) ?? "";
    const authorName = (await displayName(db, caller.userId)) ?? authorEmail;
    const { error } = await db.from("legal_request_messages").insert({
        request_id: row.id,
        author_id: caller.userId,
        author_email: authorEmail,
        author_name: authorName,
        kind,
        body: text,
    });
    if (error) return internalFailure(error);

    const now = new Date();
    if (kind === "question" && row.status !== "aguardando_solicitante") {
        const updated = await updateRow(db, row.id, { status: "aguardando_solicitante", paused_at: now.toISOString() });
        if (!updated.ok) return updated;
        if (row.project_id) await db.from("projects").update({ status: "bloqueado" }).eq("id", row.project_id);
    } else if (kind === "answer" && row.status === "aguardando_solicitante") {
        const pausedFor = row.paused_at
            ? Math.max(0, Math.round((now.getTime() - new Date(row.paused_at).getTime()) / 1000))
            : 0;
        const updated = await updateRow(db, row.id, {
            status: "em_andamento",
            paused_at: null,
            paused_seconds: (row.paused_seconds || 0) + pausedFor,
        });
        if (!updated.ok) return updated;
        if (row.project_id) await db.from("projects").update({ status: "em_andamento" }).eq("id", row.project_id);
    }

    if (row.project_id) {
        await recordCardEvent(db, {
            projectId: row.project_id,
            orgId: row.org_id,
            actorType: "user",
            actorId: caller.userId,
            actorName: authorName,
            action: kind === "question" ? "request.question" : kind === "answer" ? "request.answered" : "comment.added",
            after: { preview: text.slice(0, 140) },
        });
    }
    if (kind === "question") {
        await queueNotifications(db, [
            {
                requestId: row.id,
                number: row.number,
                title: row.title,
                template: "request.question",
                recipient: row.requester_email,
                dedupeKey: `question:${row.id}:${now.getTime()}`,
                payload: { author: authorName, question: text },
            },
        ]);
    }
    return getRequest(db, caller, requestId);
}

/**
 * Close the request with what the team sends back: a message and any of
 * the card's documents. The requester is mailed; the card's progress is
 * marked done (the lane stays the team's call).
 */
export async function deliverRequest(
    db: Db,
    caller: Caller,
    requestId: string,
    body: { message?: unknown; document_ids?: unknown },
): Promise<ServiceResult<RequestTeamView>> {
    const loaded = await loadRequestFor(db, caller, requestId);
    if (!loaded.ok) return loaded;
    if (!isTeam(loaded.audience)) return TEAM_ONLY;
    const row = loaded.row;
    if (row.status === "entregue") return failure("conflict", "Este pedido já foi entregue.");
    const message = cleanText(body.message, 4000);
    const requested = Array.isArray(body.document_ids)
        ? body.document_ids.filter((d): d is string => typeof d === "string")
        : [];
    let documentIds: string[] = [];
    if (requested.length && row.project_id) {
        const { data, error } = await db
            .from("documents")
            .select("id")
            .eq("project_id", row.project_id)
            .in("id", requested.slice(0, 10));
        if (error) return internalFailure(error);
        documentIds = ((data ?? []) as { id: string }[]).map((d) => d.id);
    }
    if (!message && documentIds.length === 0) {
        return failure("validation", "Escreva a devolutiva ou escolha um documento do pedido.");
    }
    const now = new Date().toISOString();
    const updated = await updateRow(db, row.id, {
        status: "entregue",
        delivered_at: now,
        paused_at: null,
        delivery: { message, document_ids: documentIds, delivered_by: caller.userId },
    });
    if (!updated.ok) return updated;
    if (row.project_id) {
        await db
            .from("projects")
            .update({ status: "concluido", completed_at: now.slice(0, 10) })
            .eq("id", row.project_id);
        await recordCardEvent(db, {
            projectId: row.project_id,
            orgId: row.org_id,
            actorType: "user",
            actorId: caller.userId,
            actorName: await teamCallerName(db, caller),
            action: "request.delivered",
            after: { documents: documentIds.length },
        });
    }
    await queueNotifications(db, [
        {
            requestId: row.id,
            number: row.number,
            title: row.title,
            template: "request.delivered",
            recipient: row.requester_email,
            dedupeKey: `delivered:${row.id}`,
            payload: { message },
        },
    ]);
    return getTeamView(db, caller, requestId);
}

/**
 * Invite someone outside the team — an outside law firm, a colleague from
 * the business — to follow this one request. They see what the requester
 * sees (never the card), may answer when `external`, and lose access when
 * the invitation expires (90 days by default) or is revoked.
 */
export async function inviteParticipant(
    db: Db,
    caller: Caller,
    requestId: string,
    body: { email?: unknown; role?: unknown; label?: unknown; days?: unknown },
): Promise<ServiceResult<RequestTeamView>> {
    const loaded = await loadRequestFor(db, caller, requestId);
    if (!loaded.ok) return loaded;
    if (!isTeam(loaded.audience)) return TEAM_ONLY;
    const row = loaded.row;
    if (!isEmail(body.email)) return failure("validation", "Informe um e-mail válido.");
    const email = (body.email as string).trim().toLowerCase();
    if (email === row.requester_email) return failure("validation", "Quem pediu já acompanha o pedido.");
    const role = body.role === "viewer" ? "viewer" : "external";
    const days = Math.min(Math.max(Math.trunc(Number(body.days) || 90), 1), 365);
    const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
    const { error } = await db.from("legal_request_participants").upsert(
        {
            request_id: row.id,
            email,
            role,
            label: cleanText(body.label, 120),
            invited_by: caller.userId,
            expires_at: expiresAt,
            revoked_at: null,
        },
        { onConflict: "request_id,email" },
    );
    if (error) return internalFailure(error);
    const inviter = await teamCallerName(db, caller);
    if (row.project_id) {
        await recordCardEvent(db, {
            projectId: row.project_id,
            orgId: row.org_id,
            actorType: "user",
            actorId: caller.userId,
            actorName: inviter,
            action: "participant.invited",
            after: { email, role, label: cleanText(body.label, 120), expires_at: expiresAt },
        });
    }
    await queueNotifications(db, [
        {
            requestId: row.id,
            number: row.number,
            title: row.title,
            template: "request.invited",
            recipient: email,
            dedupeKey: `invited:${row.id}:${email}:${expiresAt.slice(0, 10)}`,
            payload: {
                inviter,
                expires: new Date(expiresAt).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }),
            },
        },
    ]);
    return getTeamView(db, caller, requestId);
}

export async function revokeParticipant(
    db: Db,
    caller: Caller,
    requestId: string,
    participantId: string,
): Promise<ServiceResult<RequestTeamView>> {
    const loaded = await loadRequestFor(db, caller, requestId);
    if (!loaded.ok) return loaded;
    if (!isTeam(loaded.audience)) return TEAM_ONLY;
    const { data, error } = await db
        .from("legal_request_participants")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", participantId)
        .eq("request_id", requestId)
        .select("email")
        .maybeSingle();
    if (error) return internalFailure(error);
    if (!data) return failure("not_found", "Convite não encontrado.");
    if (loaded.row.project_id) {
        await recordCardEvent(db, {
            projectId: loaded.row.project_id,
            orgId: loaded.row.org_id,
            actorType: "user",
            actorId: caller.userId,
            actorName: await teamCallerName(db, caller),
            action: "participant.revoked",
            after: { email: (data as { email: string }).email },
        });
    }
    return getTeamView(db, caller, requestId);
}

/** Who the caller is to the legal team: the frontend picks the screen from this. */
export async function whoAmI(
    db: Db,
    caller: Caller,
): Promise<
    ServiceResult<{ configured: boolean; role: "head" | "team" | "requester"; area: string | null; areas: readonly string[] }>
> {
    let team;
    try {
        team = await loadLegalTeam(db);
    } catch (error) {
        return internalFailure(error);
    }
    const { data } = await db
        .from("legal_requester_areas")
        .select("area")
        .eq("user_id", caller.userId)
        .maybeSingle();
    const area = (data as { area?: string } | null)?.area ?? null;
    if (!team) return ok({ configured: false, role: "requester", area, areas: REQUESTER_AREAS });
    const role = await teamRole(db, caller, team.org_id);
    return ok({
        configured: true,
        role: role === "owner" || role === "admin" ? "head" : role ? "team" : "requester",
        area,
        areas: REQUESTER_AREAS,
    });
}
