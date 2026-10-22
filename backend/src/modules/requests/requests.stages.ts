// The spine of a request (U-13): one catalogue of stages, read three ways.
// The pipeline's lane (what the kanban writes), the four steps whoever asked
// sees, and the team's strip and timeline are columns of the same table, so
// they can no longer drift apart. Pure functions: no I/O, no model.
//
// The stage is computed, not stored: moving a card on the board still moves
// the request. What is stored (legal_request_stages) is the history: which
// stage, with whom, since when.

import type { Db } from "../../lib/supabase";
import { safeError } from "../../lib/safeError";
import type { RequestStatus } from "./requests.shared";

export const STAGES = ["recebido", "triagem", "checklist", "analise", "negociacao", "assinatura", "concluido"] as const;
export type Stage = (typeof STAGES)[number];

export const REQUESTER_STEPS = ["recebido", "em_analise", "assinatura", "concluido"] as const;
export type RequesterStep = (typeof REQUESTER_STEPS)[number];

/** Who holds the ball in a stage. */
export type OwnerKind = "agent" | "person" | "requester" | "none";

type StageDef = {
    label: string;
    /** The pipeline lane a card sits on during this stage. */
    lane: string;
    /** The step whoever asked sees. */
    step: RequesterStep;
};

export const STAGE_CATALOG: Record<Stage, StageDef> = {
    recebido: { label: "Recebido", lane: "entrada", step: "recebido" },
    triagem: { label: "Triagem", lane: "triagem", step: "em_analise" },
    checklist: { label: "Checklist", lane: "triagem", step: "em_analise" },
    analise: { label: "Análise", lane: "revisao", step: "em_analise" },
    negociacao: { label: "Negociação", lane: "negociacao", step: "em_analise" },
    assinatura: { label: "Assinatura", lane: "assinatura", step: "assinatura" },
    concluido: { label: "Concluído", lane: "arquivado", step: "concluido" },
};

/** The stages that count in "etapa 3 de 5": the two ends do not (they would make a fresh request look far from done). */
export const COUNTED_STAGES: readonly Stage[] = STAGES.filter((s) => s !== "recebido" && s !== "concluido");

const LANE_STAGE: Record<string, Stage> = {
    entrada: "recebido",
    triagem: "triagem",
    revisao: "analise",
    negociacao: "negociacao",
    assinatura: "assinatura",
    arquivado: "concluido",
};

export type StageInput = {
    status: RequestStatus;
    lane: string | null;
    /** The triage agent has already read the request. */
    triaged: boolean;
    /** The checklist has questions the requester still owes. */
    checklistOpen: boolean;
};

/**
 * The stage a request is in. A closed request is "concluido" whatever the
 * lane says; a request the team has not picked up yet is "recebido" or
 * "triagem"; before the analysis the open checklist is its own stage; after
 * that, the lane the card sits on decides.
 */
export function currentStage(input: StageInput): Stage {
    const { status, lane } = input;
    if (status === "entregue" || status === "cancelado" || lane === "arquivado") return "concluido";
    if (lane === "assinatura") return "assinatura";
    if (lane === "negociacao") return "negociacao";
    if (lane === "revisao") return "analise";

    // Not yet in review: the front of the line.
    const picked = status === "em_andamento" || status === "aguardando_solicitante";
    if (!picked && !input.triaged && (status === "novo" || lane === null || lane === "entrada")) return "recebido";
    if (!picked && !input.triaged) return "triagem";
    if (input.checklistOpen) return "checklist";
    return picked ? "analise" : "triagem";
}

/** The step a stage belongs to, for the team's strip ("Em análise" covers four stages). */
export function stepOfStage(stage: Stage): RequesterStep {
    return STAGE_CATALOG[stage].step;
}

/**
 * The four steps whoever asked sees. Kept on its own rule, not derived from
 * the computed stage: a requester keeps reading "Recebido" until the team has
 * picked the request up, even after the triage agent has read it, and a card
 * already in review or negotiation is "Em análise" whatever the status says.
 * The catalogue's `step` column is the table behind the lanes it covers.
 */
export function requesterStep(status: RequestStatus, lane: string | null): RequesterStep {
    if (status === "entregue" || status === "cancelado" || lane === "arquivado") return "concluido";
    if (lane === "assinatura") return stepOfStage("assinatura");
    if (status === "novo" || status === "em_triagem" || lane === "entrada" || lane === "triagem") {
        return status === "em_andamento" || status === "aguardando_solicitante" ? stepOfStage("analise") : stepOfStage("recebido");
    }
    return stepOfStage("analise");
}

/** The lane a card should sit on for a stage (for moving a card from the request side). */
export function laneOfStage(stage: Stage): string {
    return STAGE_CATALOG[stage].lane;
}

export function stageOfLane(lane: string | null): Stage | null {
    return lane ? (LANE_STAGE[lane] ?? null) : null;
}

export type StageOwner = { kind: OwnerKind; id: string | null; name: string | null };

export type StageContext = {
    assignee: { id: string; name: string } | null;
    requester: { name: string | null; email: string };
    /** Waiting on the requester: the SLA is paused. */
    waitingOnRequester: boolean;
};

/** Who holds the ball in a stage, in the words the strip shows. */
export function stageOwner(stage: Stage, ctx: StageContext): StageOwner {
    if (stage === "concluido") return { kind: "none", id: null, name: null };
    if (ctx.waitingOnRequester || stage === "checklist") {
        return { kind: "requester", id: null, name: ctx.requester.name ?? ctx.requester.email };
    }
    if (stage === "recebido" || stage === "triagem") {
        return ctx.assignee
            ? { kind: "person", id: ctx.assignee.id, name: ctx.assignee.name }
            : { kind: "agent", id: null, name: "Agente de triagem" };
    }
    return ctx.assignee ? { kind: "person", id: ctx.assignee.id, name: ctx.assignee.name } : { kind: "none", id: null, name: null };
}

// ---------------------------------------------------------------------------
// History: one row per entry into a stage.
// ---------------------------------------------------------------------------

export type StageRow = {
    stage: Stage;
    owner_kind: OwnerKind;
    owner_id: string | null;
    owner_name: string | null;
    entered_at: string;
    left_at: string | null;
    note: string | null;
};

const STAGE_COLUMNS = "stage, owner_kind, owner_id, owner_name, entered_at, left_at, note";

/**
 * Record that a request is now in `stage`, with `owner`. Closes the open row
 * and opens a new one; does nothing when the stage and the owner are the same
 * (a retried job must not stack rows). A different owner in the same stage
 * opens a new row too: the timeline says who had it and since when.
 * Never fails the caller: the history is a record, not a gate.
 */
export async function moveStage(
    db: Db,
    requestId: string,
    stage: Stage,
    owner: StageOwner,
    note: string | null = null,
    now: Date = new Date(),
): Promise<{ moved: boolean }> {
    try {
        const { data, error } = await db
            .from("legal_request_stages")
            .select("stage, owner_kind, owner_id, owner_name")
            .eq("request_id", requestId)
            .is("left_at", null)
            .limit(1);
        if (error) throw error;
        const open = ((data ?? []) as Pick<StageRow, "stage" | "owner_kind" | "owner_id" | "owner_name">[])[0];
        if (open && open.stage === stage && open.owner_kind === owner.kind && open.owner_id === owner.id && open.owner_name === owner.name) {
            return { moved: false };
        }
        const at = now.toISOString();
        if (open) {
            const { error: closeError } = await db
                .from("legal_request_stages")
                .update({ left_at: at })
                .eq("request_id", requestId)
                .is("left_at", null);
            if (closeError) throw closeError;
        }
        const { error: insertError } = await db.from("legal_request_stages").insert({
            request_id: requestId,
            stage,
            owner_kind: owner.kind,
            owner_id: owner.id,
            owner_name: owner.name,
            entered_at: at,
            note: note ? note.slice(0, 140) : null,
        });
        if (insertError) throw insertError;
        return { moved: true };
    } catch (error) {
        console.error("[requests] stage history failed", { requestId, error: safeError(error) });
        return { moved: false };
    }
}

/** The stages a request has been through, oldest first. */
export async function loadStageHistory(db: Db, requestId: string): Promise<StageRow[]> {
    const { data, error } = await db
        .from("legal_request_stages")
        .select(STAGE_COLUMNS)
        .eq("request_id", requestId)
        .order("entered_at", { ascending: true });
    if (error) throw error;
    return (data ?? []) as StageRow[];
}

// ---------------------------------------------------------------------------
// The strip: what the request page shows.
// ---------------------------------------------------------------------------

export type StripEntry = {
    stage: Stage;
    label: string;
    state: "concluida" | "atual" | "pendente";
    /** Who holds the ball and since when, for the current stage only. */
    owner: StageOwner | null;
    since: string | null;
};

export type StageStrip = {
    stage: Stage;
    label: string;
    /** "etapa 3 de 5": the two ends do not count. Null on "recebido" and "concluido". */
    position: { index: number; of: number } | null;
    owner: StageOwner;
    since: string | null;
    strip: StripEntry[];
};

/**
 * The strip for the team: every stage as done, current or pending, and for
 * the current one who holds the ball and since when. `since` comes from the
 * history's open row for that stage; without it (a request older than the
 * history) it is null and the page simply omits "desde".
 */
export function buildStrip(stage: Stage, owner: StageOwner, history: readonly StageRow[]): StageStrip {
    const at = STAGES.indexOf(stage);
    const open = [...history].reverse().find((h) => h.left_at === null && h.stage === stage);
    const since = open?.entered_at ?? null;
    const counted = COUNTED_STAGES.indexOf(stage);
    return {
        stage,
        label: STAGE_CATALOG[stage].label,
        position: counted >= 0 ? { index: counted + 1, of: COUNTED_STAGES.length } : null,
        owner,
        since,
        strip: STAGES.map((s, i) => ({
            stage: s,
            label: STAGE_CATALOG[s].label,
            state: stage === "concluido" || i < at ? "concluida" : i === at ? "atual" : "pendente",
            owner: i === at ? owner : null,
            since: i === at ? since : null,
        })),
    };
}

// ---------------------------------------------------------------------------
// Keeping the history in step with the request.
// ---------------------------------------------------------------------------

type SyncRow = {
    id: string;
    org_id: string;
    project_id: string | null;
    status: string;
    assignee_id: string | null;
    requester_name: string | null;
    requester_email: string;
    triage: Record<string, unknown> | null;
    intake_completed_at: string | null;
};

/** Is the checklist still owed by the requester? It is open until it closes; a request with no card has none. */
export function checklistIsOpen(row: Pick<SyncRow, "project_id" | "intake_completed_at">): boolean {
    return !!row.project_id && !row.intake_completed_at;
}

/**
 * Read the request as it stands (status, the card's lane, the checklist, the
 * owner) and record the stage it is in. Safe to call after any change and
 * from a read: `moveStage` does nothing when nothing moved. `note` says why
 * ("movido na Esteira", "checklist fechado"); a label, never contract text.
 */
export async function syncStage(
    db: Db,
    row: SyncRow,
    note: string | null = null,
    now: Date = new Date(),
): Promise<{ stage: Stage; owner: StageOwner }> {
    let lane: string | null = null;
    if (row.project_id) {
        const { data } = await db.from("projects").select("lane").eq("id", row.project_id).maybeSingle();
        lane = (data as { lane?: string | null } | null)?.lane ?? null;
    }
    let assignee: StageContext["assignee"] = null;
    if (row.assignee_id) {
        const { data } = await db.from("user_profiles").select("email, display_name").eq("user_id", row.assignee_id).maybeSingle();
        const profile = data as { email?: string | null; display_name?: string | null } | null;
        assignee = { id: row.assignee_id, name: profile?.display_name?.trim() || profile?.email?.split("@")[0] || "Responsável" };
    }
    const status = row.status as RequestStatus;
    const stage = currentStage({
        status,
        lane,
        triaged: !!row.triage,
        checklistOpen: checklistIsOpen(row) && status !== "entregue" && status !== "cancelado",
    });
    const owner = stageOwner(stage, {
        assignee,
        requester: { name: row.requester_name, email: row.requester_email },
        waitingOnRequester: status === "aguardando_solicitante",
    });
    await moveStage(db, row.id, stage, owner, note, now);
    return { stage, owner };
}
