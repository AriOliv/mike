// Automatic review of watched folders.
//
// A watched folder groups contract cards. When a document lands in one of
// them — a batch upload, or a Drive file the mirror already brought in — a
// periodic scan opens a contract_reviews row and queues a durable job. The
// job reads the contract's terms (the Ficha), runs the folder's playbook,
// and records the traffic-light counts and a summary on the row, so the home
// screen can show the review without anyone opening the document. Every step
// lands in card_events, so people see what the agent did and with what.
//
// The agent suggests; a person decides: a finished review is "ready" until
// someone accepts it.

import { createHash } from "node:crypto";
import type { Db } from "../../lib/supabase";
import { enqueueDbJob } from "../../lib/dbq/enqueue";
import { NonRetryableJobError } from "../../lib/dbq/runner";
import type { DbJob } from "../../lib/dbq/types";
import { safeError } from "../../lib/safeError";
import { listAccessibleProjectIds } from "../../lib/access";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { findPlaybookForContractType, startPlaybookReview } from "../playbooks/playbooks.service";
import { analysisModel, normalizeString, requireProjectEdit, requireProjectView, type Caller } from "./contracts.shared";
import { extractTermsForAgent } from "./contracts.terms";
import { finishAgentRun, recordCardEvent, startAgentRun } from "./contracts.events";

export const AUTO_REVIEW_JOB = "contracts.auto_review";
export const REVIEWER = { id: "agent:revisor@1", name: "Agente de revisão", agent: "revisor", version: "1" };

// Versions people bring in. The playbook's own redline is an assistant edit
// and must not trigger another review of itself.
const REVIEWABLE_SOURCES = ["upload", "user_upload"];
// How far back a scan looks; older versions predate the folder being watched.
const SCAN_WINDOW_DAYS = 30;
const SCAN_LIMIT = 200;

type FindingStatus =
    | "acceptable"
    | "needs_review"
    | "unacceptable"
    | "missing_required"
    | "not_applicable"
    | "outside_scope";

/** Traffic-light counts of a playbook run's findings. */
export function tallyFindings(findings: { status: FindingStatus }[]) {
    const tally = { aligned: 0, needs_review: 0, deviates: 0 };
    for (const finding of findings) {
        if (finding.status === "acceptable") tally.aligned++;
        else if (finding.status === "needs_review") tally.needs_review++;
        else if (finding.status === "unacceptable" || finding.status === "missing_required") tally.deviates++;
    }
    return tally;
}

// ── Watched folders ─────────────────────────────────────────────────────────

export type WatchedFolder = {
    id: string;
    org_id: string | null;
    name: string;
    source: "upload" | "drive";
    drive_folder_id: string | null;
    drive_link: string | null;
    playbook_id: string | null;
    default_assignee_email: string | null;
    active: boolean;
    last_scanned_at: string | null;
    created_at: string;
};

const FOLDER_COLUMNS =
    "id, org_id, name, source, drive_folder_id, drive_link, playbook_id, default_assignee_email, active, last_scanned_at, created_at";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Folders whose cards the caller can see, plus the ones the caller created. */
export async function listWatchedFolders(
    db: Db,
    caller: Caller,
): Promise<ServiceResult<(WatchedFolder & { contracts: number })[]>> {
    let ids: string[];
    try {
        ids = await listAccessibleProjectIds(caller.userId, caller.userEmail, db);
    } catch (error) {
        return internalFailure(error);
    }
    const counts = new Map<string, number>();
    for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await db
            .from("projects")
            .select("watched_folder_id")
            .in("id", ids.slice(i, i + 200))
            .not("watched_folder_id", "is", null)
            .is("archived_at", null);
        if (error) return internalFailure(error);
        for (const row of (data ?? []) as { watched_folder_id: string }[]) {
            counts.set(row.watched_folder_id, (counts.get(row.watched_folder_id) ?? 0) + 1);
        }
    }
    const { data, error } = await db
        .from("watched_folders")
        .select(FOLDER_COLUMNS)
        .eq("active", true)
        .or(
            counts.size
                ? `created_by.eq.${caller.userId},id.in.(${[...counts.keys()].join(",")})`
                : `created_by.eq.${caller.userId}`,
        )
        .order("created_at", { ascending: true });
    if (error) return internalFailure(error);
    return ok(
        ((data ?? []) as unknown as WatchedFolder[]).map((folder) => ({
            ...folder,
            contracts: counts.get(folder.id) ?? 0,
        })),
    );
}

/** Start watching a folder: a name, and optionally a playbook and an assignee. */
export async function createWatchedFolder(
    db: Db,
    caller: Caller,
    body: Record<string, unknown>,
): Promise<ServiceResult<WatchedFolder>> {
    const name = normalizeString(body.name);
    if (!name) return failure("validation", "Dê um nome à pasta.");
    if (name.length > 200) return failure("validation", "Use um nome de pasta com até 200 caracteres.");
    const source = body.source ?? "upload";
    if (source !== "upload" && source !== "drive") {
        return failure("validation", "A pasta precisa vir de um envio ou do Google Drive.");
    }
    const assignee = normalizeString(body.default_assignee_email)?.toLowerCase() ?? null;
    if (assignee && !EMAIL.test(assignee)) {
        return failure("validation", "O responsável padrão precisa ser um e-mail válido.");
    }
    const { data, error } = await db
        .from("watched_folders")
        .insert({
            name,
            source,
            created_by: caller.userId,
            org_id: normalizeString(body.org_id),
            drive_folder_id: normalizeString(body.drive_folder_id),
            drive_link: normalizeString(body.drive_link),
            playbook_id: normalizeString(body.playbook_id),
            default_assignee_email: assignee,
        })
        .select(FOLDER_COLUMNS)
        .single();
    if (error) return internalFailure(error);
    return ok(data as unknown as WatchedFolder);
}

/**
 * Put a contract card in a watched folder, so its new documents are reviewed
 * on arrival. The card must be one the caller can edit.
 */
export async function watchProject(
    db: Db,
    caller: Caller,
    folderId: string,
    projectId: string,
): Promise<ServiceResult<{ project_id: string; watched_folder_id: string }>> {
    const access = await requireProjectEdit(db, caller, projectId);
    if (!access.ok) return access;
    const { data: folder, error: folderError } = await db
        .from("watched_folders")
        .select("id, name, org_id")
        .eq("id", folderId)
        .eq("active", true)
        .maybeSingle();
    if (folderError) return internalFailure(folderError);
    if (!folder) return failure("not_found", "Não encontrei esta pasta monitorada.");

    const { error } = await db
        .from("projects")
        .update({
            watched_folder_id: folderId,
            // A watched card is a contract on the board from its first document.
            lane: (access.access.project as { lane?: string | null }).lane ?? "triagem",
            updated_at: new Date().toISOString(),
        })
        .eq("id", projectId);
    if (error) return internalFailure(error);
    await recordCardEvent(db, {
        projectId,
        orgId: (folder as { org_id: string | null }).org_id,
        actorType: "user",
        actorId: caller.userId,
        actorName: caller.userEmail ?? null,
        action: "folder.watched",
        after: { folder: (folder as { name: string }).name },
    });
    return ok({ project_id: projectId, watched_folder_id: folderId });
}

// ── Scanning: new documents → queued reviews ────────────────────────────────

type ScanVersion = {
    id: string;
    document_id: string;
    filename: string | null;
    source: string;
    created_at: string;
};

/**
 * Queue a review for every new reviewable version in a watched card. Safe to
 * run on a timer: the unique version_id makes a second scan a no-op.
 */
export async function scanWatchedFolders(db: Db): Promise<{ queued: number }> {
    const { data: folders, error: foldersError } = await db
        .from("watched_folders")
        .select("id, org_id, playbook_id, default_assignee_email, created_by")
        .eq("active", true);
    if (foldersError) throw foldersError;
    let queued = 0;
    for (const folder of (folders ?? []) as {
        id: string;
        org_id: string | null;
        playbook_id: string | null;
        default_assignee_email: string | null;
        created_by: string | null;
    }[]) {
        queued += await scanFolder(db, folder);
        await db
            .from("watched_folders")
            .update({ last_scanned_at: new Date().toISOString() })
            .eq("id", folder.id);
    }
    return { queued };
}

async function scanFolder(
    db: Db,
    folder: {
        id: string;
        org_id: string | null;
        playbook_id: string | null;
        default_assignee_email: string | null;
        created_by: string | null;
    },
): Promise<number> {
    const { data: projects, error: projectsError } = await db
        .from("projects")
        .select("id, user_id, assignee_email")
        .eq("watched_folder_id", folder.id)
        .is("archived_at", null);
    if (projectsError) throw projectsError;
    const projectRows = (projects ?? []) as { id: string; user_id: string | null; assignee_email: string | null }[];
    if (projectRows.length === 0) return 0;

    const { data: docs, error: docsError } = await db
        .from("documents")
        .select("id, project_id")
        .in("project_id", projectRows.map((p) => p.id))
        .is("archived_at", null);
    if (docsError) throw docsError;
    const docRows = (docs ?? []) as { id: string; project_id: string }[];
    if (docRows.length === 0) return 0;

    const since = new Date(Date.now() - SCAN_WINDOW_DAYS * 86_400_000).toISOString();
    const { data: versions, error: versionsError } = await db
        .from("document_versions")
        .select("id, document_id, filename, source, created_at")
        .in("document_id", docRows.map((d) => d.id))
        .in("source", REVIEWABLE_SOURCES)
        .is("deleted_at", null)
        .gte("created_at", since)
        .limit(SCAN_LIMIT);
    if (versionsError) throw versionsError;
    const versionRows = (versions ?? []) as ScanVersion[];
    if (versionRows.length === 0) return 0;

    const { data: existing, error: existingError } = await db
        .from("contract_reviews")
        .select("version_id")
        .in("version_id", versionRows.map((v) => v.id));
    if (existingError) throw existingError;
    const seen = new Set(((existing ?? []) as { version_id: string }[]).map((r) => r.version_id));

    const projectOfDoc = new Map(docRows.map((d) => [d.id, d.project_id]));
    const project = new Map(projectRows.map((p) => [p.id, p]));
    let queued = 0;
    for (const version of versionRows) {
        if (seen.has(version.id)) continue;
        const projectId = projectOfDoc.get(version.document_id)!;
        const card = project.get(projectId)!;
        const requestedBy = folder.created_by ?? card.user_id;
        if (!requestedBy) continue;
        const { data: review, error } = await db
            .from("contract_reviews")
            .insert({
                org_id: folder.org_id,
                project_id: projectId,
                document_id: version.document_id,
                version_id: version.id,
                watched_folder_id: folder.id,
                playbook_id: folder.playbook_id,
                requested_by: requestedBy,
                assignee_email: card.assignee_email ?? folder.default_assignee_email,
                status: "queued",
            })
            .select("id")
            .single();
        // Another scanner inserted it first: the unique version wins.
        if (error) {
            if ((error as { code?: string }).code === "23505") continue;
            throw error;
        }
        await enqueueDbJob(db, {
            kind: AUTO_REVIEW_JOB,
            payload: { reviewId: (review as { id: string }).id },
            dedupeKey: `${AUTO_REVIEW_JOB}:${version.id}`,
            maxAttempts: 3,
        });
        await recordCardEvent(db, {
            projectId,
            orgId: folder.org_id,
            actorType: "agent",
            actorId: REVIEWER.id,
            actorName: REVIEWER.name,
            action: "review.started",
            after: { document: version.filename },
        });
        queued++;
    }
    return queued;
}

/**
 * Queue the latest version of a card for review now, without waiting for the
 * next scan. Used after a batch upload and by "Revisar de novo".
 */
export async function requestReview(
    db: Db,
    caller: Caller,
    projectId: string,
): Promise<ServiceResult<{ review_id: string; queued: boolean }>> {
    const access = await requireProjectEdit(db, caller, projectId);
    if (!access.ok) return access;
    const { data: docs, error: docsError } = await db
        .from("documents")
        .select("id, current_version_id, org_id")
        .eq("project_id", projectId)
        .is("archived_at", null)
        .not("current_version_id", "is", null)
        .order("updated_at", { ascending: false })
        .limit(1);
    if (docsError) return internalFailure(docsError);
    const doc = ((docs ?? []) as { id: string; current_version_id: string; org_id: string | null }[])[0];
    if (!doc) return failure("validation", "Este contrato ainda não tem documento para revisar.", "no_document");

    const { data: card, error: cardError } = await db
        .from("projects")
        .select("watched_folder_id, assignee_email, watched_folders(playbook_id, default_assignee_email)")
        .eq("id", projectId)
        .single();
    if (cardError) return internalFailure(cardError);
    const row = card as unknown as {
        watched_folder_id: string | null;
        assignee_email: string | null;
        watched_folders: { playbook_id: string | null; default_assignee_email: string | null } | null;
    };

    // A finished or failed review of this exact version is re-opened.
    const { data: review, error } = await db
        .from("contract_reviews")
        .upsert(
            {
                org_id: doc.org_id,
                project_id: projectId,
                document_id: doc.id,
                version_id: doc.current_version_id,
                watched_folder_id: row.watched_folder_id,
                playbook_id: row.watched_folders?.playbook_id ?? null,
                requested_by: caller.userId,
                assignee_email: row.assignee_email ?? row.watched_folders?.default_assignee_email ?? null,
                status: "queued",
                step: null,
                error: null,
                decided_by: null,
                decided_at: null,
                updated_at: new Date().toISOString(),
            },
            { onConflict: "version_id" },
        )
        .select("id")
        .single();
    if (error) return internalFailure(error);
    const reviewId = (review as { id: string }).id;
    try {
        const job = await enqueueDbJob(db, {
            kind: AUTO_REVIEW_JOB,
            payload: { reviewId },
            dedupeKey: `${AUTO_REVIEW_JOB}:${doc.current_version_id}`,
            maxAttempts: 3,
        });
        return ok({ review_id: reviewId, queued: !job.deduped });
    } catch (enqueueError) {
        return internalFailure(enqueueError);
    }
}

// ── The job ─────────────────────────────────────────────────────────────────

type ReviewRow = {
    id: string;
    org_id: string | null;
    project_id: string;
    document_id: string;
    version_id: string;
    playbook_id: string | null;
    requested_by: string | null;
    status: string;
};

async function setReview(db: Db, id: string, patch: Record<string, unknown>) {
    const { error } = await db
        .from("contract_reviews")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", id);
    if (error) throw error;
}

/** The organization's playbook for the card's contract type, when it has one. */
async function playbookForCardType(db: Db, review: ReviewRow, caller: Caller): Promise<string | null> {
    if (!review.org_id) return null;
    const { data, error } = await db
        .from("projects")
        .select("contract_type")
        .eq("id", review.project_id)
        .maybeSingle();
    if (error) throw error;
    const contractType = (data as { contract_type: string | null } | null)?.contract_type ?? null;
    const playbook = await findPlaybookForContractType(db, {
        userId: caller.userId,
        orgId: review.org_id,
        contractType,
    });
    return playbook?.id ?? null;
}

/**
 * The job body: read the terms, run the playbook, record the outcome. It is
 * idempotent: a review that already finished is left alone, and a retried
 * one starts over.
 */
export async function handleAutoReview(db: Db, job: DbJob): Promise<Record<string, unknown>> {
    const reviewId = String(job.payload.reviewId ?? "");
    const { data, error } = await db
        .from("contract_reviews")
        .select("id, org_id, project_id, document_id, version_id, playbook_id, requested_by, status")
        .eq("id", reviewId)
        .maybeSingle();
    if (error) throw error;
    const review = data as ReviewRow | null;
    if (!review) throw new NonRetryableJobError("review_not_found");
    if (review.status === "ready" || review.status === "done") return { skipped: true };
    if (!review.requested_by) throw new NonRetryableJobError("review_has_no_requester");

    const started = Date.now();
    const runId = await startAgentRun(db, {
        projectId: review.project_id,
        orgId: review.org_id,
        agent: REVIEWER.agent,
        agentVersion: REVIEWER.version,
        jobId: job.id,
        inputDocSha: createHash("sha256").update(review.version_id).digest("hex").slice(0, 16),
    });
    await setReview(db, review.id, { status: "running", step: "lendo", agent_run_id: runId, error: null });

    const caller: Caller = { userId: review.requested_by };
    try {
        const selected = await analysisModel(db, caller.userId);
        if (!selected.ok) throw new NonRetryableJobError("model_required");

        // 1. The Ficha: terms with the clause each came from.
        await setReview(db, review.id, { step: "ficha" });
        const terms = await extractTermsForAgent(db, caller.userId, review.project_id, selected);

        // 2. The playbook: the folder's, else the organization's playbook for
        // the contract's type, which the Ficha has just classified.
        let tally = { aligned: 0, needs_review: 0, deviates: 0 };
        let summary: string | null = null;
        let playbookRunId: string | null = null;
        let sources = terms ? Object.keys(terms.sources ?? {}).length : 0;
        if (!review.playbook_id) {
            const byType = await playbookForCardType(db, review, caller);
            if (byType) {
                review.playbook_id = byType;
                await setReview(db, review.id, { playbook_id: byType });
            }
        }
        if (review.playbook_id) {
            await setReview(db, review.id, { step: "playbook" });
            const { run, done } = await startPlaybookReview({
                db,
                userId: caller.userId,
                playbookId: review.playbook_id,
                documentId: review.document_id,
                model: selected.model,
                reviewMode: "strict",
                reviewScope: "full",
            });
            playbookRunId = run.id;
            await setReview(db, review.id, { playbook_run_id: playbookRunId });
            const result = await done;
            tally = tallyFindings(result.findings);
            summary = result.summary;
            sources += result.findings.filter((f) => f.quote).length;
        }
        if (!summary) summary = termsSummary(terms);

        const finished = new Date().toISOString();
        await setReview(db, review.id, {
            status: "ready",
            step: null,
            aligned: tally.aligned,
            needs_review: tally.needs_review,
            deviates: tally.deviates,
            summary,
            finished_at: finished,
        });
        await finishAgentRun(db, runId, {
            status: "succeeded",
            output: { ...tally, playbook_run_id: playbookRunId, terms: !!terms },
            modelResolved: selected.model,
            latencyMs: Date.now() - started,
        });
        const { data: doc } = await db
            .from("document_versions")
            .select("filename")
            .eq("id", review.version_id)
            .maybeSingle();
        await recordCardEvent(db, {
            projectId: review.project_id,
            orgId: review.org_id,
            actorType: "agent",
            actorId: REVIEWER.id,
            actorName: REVIEWER.name,
            action: "review.completed",
            runId,
            after: {
                document: (doc as { filename?: string | null } | null)?.filename ?? null,
                sources,
                review_id: review.id,
                playbook_run_id: playbookRunId,
                ...tally,
            },
        });
        return { reviewId: review.id, ...tally };
    } catch (failureError) {
        const permanent = failureError instanceof NonRetryableJobError;
        const lastAttempt = permanent || job.attempts >= job.max_attempts;
        await finishAgentRun(db, runId, {
            status: "failed",
            error: safeError(failureError).category,
            latencyMs: Date.now() - started,
        });
        await setReview(db, review.id, {
            status: lastAttempt ? "failed" : "queued",
            step: null,
            error: lastAttempt ? reviewFailureText(failureError) : null,
        });
        if (lastAttempt) {
            await recordCardEvent(db, {
                projectId: review.project_id,
                orgId: review.org_id,
                actorType: "agent",
                actorId: REVIEWER.id,
                actorName: REVIEWER.name,
                action: "review.failed",
                runId,
            });
        }
        throw failureError;
    }
}

/** Failure hook: the runner gave up, so the row must not stay "running". */
export async function markAutoReviewFailed(db: Db, job: DbJob): Promise<void> {
    const reviewId = String(job.payload.reviewId ?? "");
    if (!reviewId) return;
    await db
        .from("contract_reviews")
        .update({
            status: "failed",
            step: null,
            error: "A revisão não terminou. Tente de novo.",
            updated_at: new Date().toISOString(),
        })
        .eq("id", reviewId)
        .in("status", ["queued", "running"]);
}

function reviewFailureText(error: unknown): string {
    if (error instanceof NonRetryableJobError && /model/i.test(error.message)) {
        return "Escolha um modelo de revisão em Configurações para o agente poder ler contratos.";
    }
    return "Não consegui ler este contrato. Tente de novo.";
}

/** Two lines a person can read when there is no playbook to compare against. */
export function termsSummary(
    terms: {
        term_end: string | null;
        notice_deadline: string | null;
        auto_renewal: boolean | null;
        penalty_value: string | null;
    } | null,
): string {
    if (!terms) return "Não consegui extrair a Ficha deste contrato.";
    const parts: string[] = [];
    if (terms.term_end) parts.push(`Vence em ${brDate(terms.term_end)}`);
    if (terms.auto_renewal === true) parts.push("renova automaticamente");
    if (terms.notice_deadline) parts.push(`aviso de não renovação até ${brDate(terms.notice_deadline)}`);
    if (terms.penalty_value) parts.push(`multa: ${terms.penalty_value}`);
    return parts.length ? `${parts.join("; ")}.` : "Ficha extraída; nenhum prazo ou multa encontrado no texto.";
}

function brDate(iso: string): string {
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
}

// ── People act on a review ──────────────────────────────────────────────────

/** Accept a ready review ("li, está ok") or assign it to someone. */
export async function updateContractReview(
    db: Db,
    caller: Caller,
    reviewId: string,
    body: Record<string, unknown>,
): Promise<ServiceResult<{ id: string; status: string; assignee_email: string | null }>> {
    const { data, error } = await db
        .from("contract_reviews")
        .select("id, project_id, org_id, status, assignee_email")
        .eq("id", reviewId)
        .maybeSingle();
    if (error) return internalFailure(error);
    const review = data as {
        id: string;
        project_id: string;
        org_id: string | null;
        status: string;
        assignee_email: string | null;
    } | null;
    if (!review) return failure("not_found", "Não encontrei esta revisão.");
    const access = await requireProjectEdit(db, caller, review.project_id);
    if (!access.ok) return access;

    const patch: Record<string, unknown> = {};
    const events: Parameters<typeof recordCardEvent>[1][] = [];
    const actor = {
        projectId: review.project_id,
        orgId: review.org_id,
        actorType: "user" as const,
        actorId: caller.userId,
        actorName: caller.userEmail ?? null,
    };
    if ("assignee_email" in body) {
        const email = normalizeString(body.assignee_email)?.toLowerCase() ?? null;
        if (email && !EMAIL.test(email)) {
            return failure("validation", "Escolha uma pessoa válida como responsável.");
        }
        patch.assignee_email = email;
        if (email !== review.assignee_email) {
            events.push({ ...actor, action: "assignee.changed", before: review.assignee_email, after: email });
        }
    }
    if ("status" in body) {
        if (body.status === "done") {
            if (review.status !== "ready") {
                return failure("conflict", "Só dá para aceitar uma revisão que já está pronta.");
            }
            patch.status = "done";
            patch.decided_by = caller.userId;
            patch.decided_at = new Date().toISOString();
            events.push({ ...actor, action: "review.accepted" });
        } else if (body.status === "ready" && review.status === "done") {
            // Undo an accept.
            patch.status = "ready";
            patch.decided_by = null;
            patch.decided_at = null;
        } else {
            return failure("validation", "Esta mudança de status não é permitida.");
        }
    }
    if (Object.keys(patch).length === 0) return failure("validation", "Nada para alterar.");
    patch.updated_at = new Date().toISOString();

    const { data: updated, error: updateError } = await db
        .from("contract_reviews")
        .update(patch)
        .eq("id", reviewId)
        .select("id, status, assignee_email")
        .single();
    if (updateError) return internalFailure(updateError);
    // The card's responsible person follows the review's.
    if ("assignee_email" in patch) {
        await db.from("projects").update({ assignee_email: patch.assignee_email }).eq("id", review.project_id);
    }
    for (const event of events) await recordCardEvent(db, event);
    return ok(updated as { id: string; status: string; assignee_email: string | null });
}

/** One card's latest review, for the card page. */
export async function getLatestReview(
    db: Db,
    caller: Caller,
    projectId: string,
): Promise<ServiceResult<Record<string, unknown> | null>> {
    const access = await requireProjectView(db, caller, projectId);
    if (!access.ok) return access;
    const { data, error } = await db
        .from("contract_reviews")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) return internalFailure(error);
    return ok((data as Record<string, unknown> | null) ?? null);
}
