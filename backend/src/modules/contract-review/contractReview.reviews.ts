// A contract's review by playbook: the upstream playbook run (findings plus a
// redline of tracked changes in the Word document) seen from the contract.
//
// What this adds to a run:
// - the contract's own playbook (Playbook Avenia v1, seeded on first use, so
//   the team reviews before configuring anything);
// - one verdict per clause, combining the playbook's assessment with the
//   deterministic risk rules on the Ficha, and naming the rule that fired;
// - precedent: how many signed contracts of the base hold the same position
//   on the same subject, read from their validated Fichas — a count that can
//   be explained and opened, in place of an opaque similarity score;
// - one decision per suggestion (accept / edit / reject), recorded with who
//   decided and why, applied to the document as the tracked change itself.

import type { Db } from "../../lib/supabase";
import { listAccessibleProjectIds } from "../../lib/access";
import { recordAudit } from "../../lib/audit";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import type { EditAnnotation } from "@mike/contracts";
import {
    createPlaybook,
    getPlaybookRunById,
    listPlaybooks,
    playbookConfiguration,
    PlaybookRequestError,
    startPlaybookReview,
    updatePlaybookContent,
} from "../playbooks/playbooks.service";
import { applyTrackedEditsToDocument, resolveEdit } from "../documents/documents.service";
import { AVENIA_PLAYBOOK_CONTENT, AVENIA_PLAYBOOK_NAME, RULE_RISK_RULES } from "./contractReview.playbook";
import { fieldLabel, type Ficha, type FichaField, type FichaPath } from "./contractReview.ficha";
import { RULES, type RiskFinding } from "./contractReview.rules";
import { contractDocument, requireContractEdit, requireContractView, type Caller } from "./contractReview.shared";

type PlaybookFindingStatus =
    | "not_applicable"
    | "acceptable"
    | "needs_review"
    | "unacceptable"
    | "missing_required"
    | "outside_scope";

type RunFinding = {
    id: string;
    ruleId: string | null;
    topicId: string | null;
    ruleName: string;
    status: PlaybookFindingStatus;
    quote: string;
    location: string;
    analysis: string;
    suggestedText: string;
    edit?: EditAnnotation | null;
};

type Run = NonNullable<Awaited<ReturnType<typeof getPlaybookRunById>>>;

export type Decision = {
    decision: "aceito" | "editado" | "rejeitado";
    edited_text: string | null;
    reason: string | null;
    decided_by: string;
    decided_at: string;
    edit: EditAnnotation | null;
};

export type ClauseSource =
    | { kind: "playbook"; label: string; position: string; criteria: string }
    | { kind: "regra"; rule_id: string; label: string; severity: string; pending_validation: boolean }
    | { kind: "ficha"; path: string; label: string; state: string; quote: string | null };

export type Precedent = {
    /** Signed contracts whose validated Ficha holds the same value for this subject. */
    same: number;
    /** Signed contracts with this subject validated at all. */
    of: number;
    projects: { id: string; name: string }[];
};

export type ReviewClause = RunFinding & {
    verdict: "alinhado" | "precisa_revisao" | "diverge" | "nao_aplica";
    /** The playbook's verdict before the Ficha's rules were weighed in. */
    playbook_status: PlaybookFindingStatus;
    covered: boolean;
    sources: ClauseSource[];
    rule_findings: RiskFinding[];
    precedent: Precedent | null;
    decision: Decision | null;
};

export type ContractReview = {
    id: string;
    status: string;
    error: string | null;
    summary: string | null;
    started_at: string;
    completed_at: string | null;
    model: string;
    playbook: { id: string; name: string };
    document: { id: string | null; name: string | null; edited_version_id: string | null };
    clauses: ReviewClause[];
    /** Ficha rules that fired on a subject no playbook rule covers. */
    uncovered: RiskFinding[];
};

export type ReviewSummary = {
    id: string;
    status: string;
    started_at: string;
    playbook_name: string;
    counts: { alinhado: number; precisa_revisao: number; diverge: number };
};

const VERDICT: Record<PlaybookFindingStatus, ReviewClause["verdict"]> = {
    acceptable: "alinhado",
    needs_review: "precisa_revisao",
    unacceptable: "diverge",
    missing_required: "diverge",
    not_applicable: "nao_aplica",
    outside_scope: "nao_aplica",
};

const RANK = { nao_aplica: 0, alinhado: 1, precisa_revisao: 2, diverge: 3 } as const;

/** Severities that make a clause diverge on their own; the rest ask for a look. */
const DIVERGE_SEVERITIES = new Set(["critica", "alta"]);

function worse(a: ReviewClause["verdict"], b: ReviewClause["verdict"]) {
    return RANK[b] > RANK[a] ? b : a;
}

function failureOf(error: unknown) {
    if (error instanceof PlaybookRequestError) {
        const status = (error as { status?: number }).status ?? 400;
        return failure(status === 404 ? "not_found" : status === 403 ? "forbidden" : "validation", error.message);
    }
    return internalFailure(error);
}

/**
 * The organization's Playbook Avenia, created on first use: the team starts
 * from the standard positions instead of an empty editor. One copy per
 * workspace, found by name, so a Head of Legal who edits it keeps their edits.
 */
export async function ensureAveniaPlaybook(db: Db, caller: Caller, orgId: string | null) {
    const workspace = orgId ?? "personal";
    const existing = (await listPlaybooks(caller.userId, db, { workspace, email: caller.userEmail })).find(
        (playbook) => playbook.name === AVENIA_PLAYBOOK_NAME,
    );
    if (existing) return existing;
    const created = await createPlaybook(
        caller.userId,
        {
            name: AVENIA_PLAYBOOK_NAME,
            description: AVENIA_PLAYBOOK_CONTENT.description,
            representedParty: AVENIA_PLAYBOOK_CONTENT.representedParty,
            documentTypes: AVENIA_PLAYBOOK_CONTENT.documentTypes,
            jurisdictions: AVENIA_PLAYBOOK_CONTENT.jurisdictions,
        },
        db,
        orgId ?? undefined,
        orgId ? "organization" : undefined,
    );
    return updatePlaybookContent(caller.userId, created.id, AVENIA_PLAYBOOK_CONTENT, db, {}, caller.userEmail);
}

/** Starts a review of the contract's document; the run continues on the server. */
export async function startContractReview(
    db: Db,
    caller: Caller,
    projectId: string,
    body: Record<string, unknown>,
): Promise<ServiceResult<{ id: string; status: string }>> {
    const allowed = await requireContractEdit(db, caller, projectId);
    if (!allowed.ok) return allowed;
    try {
        const orgId = allowed.access.project?.org_id ?? null;
        const doc = await contractDocument(db, projectId);
        if (!doc) return failure("validation", "Envie o contrato (.docx) antes de revisar.");
        if (!doc.isDocx) return failure("validation", "A revisão com redline precisa do contrato em Word (.docx).");
        const playbook =
            typeof body.playbook_id === "string" && body.playbook_id
                ? { id: body.playbook_id }
                : await ensureAveniaPlaybook(db, caller, orgId);
        const model =
            typeof body.model === "string" && body.model
                ? body.model
                : (await playbookConfiguration(caller.userId, db, orgId ?? "personal")).defaultModel;
        if (!model) return failure("validation", "Escolha um modelo em Configurações antes de revisar.", "model_required");
        const { run, done } = await startPlaybookReview({
            userId: caller.userId,
            userEmail: caller.userEmail,
            playbookId: playbook.id,
            documentId: doc.documentId,
            model,
            reviewMode: body.mode === "permissive" ? "permissive" : "strict",
            reviewScope: "full",
            instructions:
                "Responda em português do Brasil (analysis, summary e suggestedText). Direito brasileiro. A parte representada é a Avenia.",
            db,
        });
        // The run records its own outcome; a failure is already logged there.
        done.catch(() => undefined);
        const { error } = await db.from("contract_review_runs").insert({
            run_id: run.id,
            project_id: projectId,
            document_id: doc.documentId,
            playbook_id: playbook.id,
            user_id: caller.userId,
        });
        if (error) throw error;
        void recordAudit(db, {
            userId: caller.userId,
            userEmail: caller.userEmail,
            orgId,
            action: "contract_review.started",
            surface: "contract_review",
            projectId,
            documentId: doc.documentId,
            model,
            title: doc.filename,
        });
        return ok({ id: run.id, status: run.status });
    } catch (error) {
        return failureOf(error);
    }
}

async function reviewRow(db: Db, projectId: string, runId: string) {
    const { data, error } = await db
        .from("contract_review_runs")
        .select("run_id, project_id, playbook_id")
        .eq("run_id", runId)
        .eq("project_id", projectId)
        .maybeSingle();
    if (error) throw error;
    return data as { run_id: string; project_id: string; playbook_id: string } | null;
}

async function decisionsOf(db: Db, runId: string): Promise<Map<string, Decision>> {
    const { data, error } = await db
        .from("contract_review_decisions")
        .select("finding_id, decision, edited_text, reason, decided_by, decided_at, edit")
        .eq("run_id", runId);
    if (error) throw error;
    return new Map(
        ((data ?? []) as (Decision & { finding_id: string })[]).map(({ finding_id, ...decision }) => [
            finding_id,
            decision,
        ]),
    );
}

async function fichaOf(db: Db, projectId: string): Promise<{ ficha: Ficha; findings: RiskFinding[] } | null> {
    const { data, error } = await db
        .from("contract_fichas")
        .select("ficha, findings")
        .eq("project_id", projectId)
        .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { ficha: (data.ficha ?? {}) as Ficha, findings: (data.findings ?? []) as RiskFinding[] };
}

function fieldsForRule(ruleId: string | null): FichaPath[] {
    const ids = (ruleId && RULE_RISK_RULES[ruleId]) || [];
    return [...new Set(RULES.filter((rule) => ids.includes(rule.id)).flatMap((rule) => rule.campos))];
}

/**
 * Signed contracts (lane arquivado) the caller can open whose validated Ficha
 * holds the same value as this contract on the subject's main field.
 */
async function precedents(
    db: Db,
    caller: Caller,
    projectId: string,
    ficha: Ficha | null,
): Promise<(paths: FichaPath[]) => Precedent | null> {
    if (!ficha) return () => null;
    const ids = (await listAccessibleProjectIds(caller.userId, caller.userEmail, db)).filter((id) => id !== projectId);
    if (!ids.length) return () => null;
    const { data: signed, error } = await db
        .from("projects")
        .select("id, name")
        .in("id", ids.slice(0, 500))
        .eq("lane", "arquivado")
        .is("archived_at", null);
    if (error) throw error;
    const names = new Map(((signed ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]));
    if (!names.size) return () => null;
    const { data: rows, error: fichaError } = await db
        .from("contract_fichas")
        .select("project_id, ficha")
        .in("project_id", [...names.keys()]);
    if (fichaError) throw fichaError;
    const others = (rows ?? []) as { project_id: string; ficha: Ficha }[];
    return (paths) => {
        const path = paths[0];
        const mine = path ? ficha[path] : undefined;
        if (!path || !mine || mine.status === "nao_encontrado") return null;
        let of = 0;
        const same: { id: string; name: string }[] = [];
        for (const other of others) {
            const field = other.ficha?.[path] as FichaField | undefined;
            if (!field || field.review.state === "pendente") continue;
            of += 1;
            if (JSON.stringify(field.value) === JSON.stringify(mine.value))
                same.push({ id: other.project_id, name: names.get(other.project_id) ?? "Contrato" });
        }
        return of ? { same: same.length, of, projects: same.slice(0, 5) } : null;
    };
}

function positionSource(finding: RunFinding, content: unknown): ClauseSource[] {
    const topics = ((content as { topics?: { rules: Record<string, unknown>[] }[] })?.topics ?? []).flatMap(
        (topic) => topic.rules,
    );
    const rules = [...((content as { rules?: Record<string, unknown>[] })?.rules ?? []), ...topics];
    const rule = rules.find((r) => r.id === finding.ruleId);
    const standard = rule?.standard as { name?: string; criteria?: string } | null | undefined;
    if (!standard?.name) return [];
    return [
        {
            kind: "playbook",
            label: String(rule?.name ?? finding.ruleName),
            position: standard.name,
            criteria: String(standard.criteria ?? ""),
        },
    ];
}

/** One clause's verdict, sources and precedent, from the run and the Ficha. */
export function buildClauses(args: {
    run: Run;
    content: unknown;
    ficha: { ficha: Ficha; findings: RiskFinding[] } | null;
    decisions: Map<string, Decision>;
    precedentOf: (paths: FichaPath[]) => Precedent | null;
}): { clauses: ReviewClause[]; uncovered: RiskFinding[] } {
    const used = new Set<string>();
    const clauses = (args.run.findings as RunFinding[]).map((finding) => {
        const ruleIds = (finding.ruleId && RULE_RISK_RULES[finding.ruleId]) || [];
        const fired = (args.ficha?.findings ?? []).filter((f) => ruleIds.includes(f.rule_id));
        fired.forEach((f) => used.add(f.rule_id));
        let verdict = VERDICT[finding.status];
        for (const f of fired)
            verdict = worse(verdict, DIVERGE_SEVERITIES.has(f.severidade) ? "diverge" : "precisa_revisao");
        const paths = fieldsForRule(finding.ruleId);
        const sources: ClauseSource[] = [
            ...positionSource(finding, args.content),
            ...fired.map((f) => ({
                kind: "regra" as const,
                rule_id: f.rule_id,
                label: f.titulo,
                severity: f.severidade,
                pending_validation: f.depende_de_campo_nao_validado,
            })),
            ...paths.flatMap((path) => {
                const field = args.ficha?.ficha[path];
                if (!field || field.status === "nao_aplicavel") return [];
                return [
                    {
                        kind: "ficha" as const,
                        path,
                        label: fieldLabel(path),
                        state: field.status === "nao_encontrado" ? "nao_encontrado" : field.review.state,
                        quote: field.citations[0]?.quote ?? null,
                    },
                ];
            }),
        ];
        return {
            ...finding,
            verdict,
            playbook_status: finding.status,
            covered: !!finding.ruleId,
            sources,
            rule_findings: fired,
            precedent: paths.length ? args.precedentOf(paths) : null,
            decision: args.decisions.get(finding.id) ?? null,
        };
    });
    const uncovered = (args.ficha?.findings ?? []).filter(
        (f) => !used.has(f.rule_id) && !Object.values(RULE_RISK_RULES).some((ids) => ids.includes(f.rule_id)),
    );
    return { clauses, uncovered };
}

export async function getContractReview(
    db: Db,
    caller: Caller,
    projectId: string,
    runId: string,
): Promise<ServiceResult<ContractReview>> {
    const allowed = await requireContractView(db, caller, projectId);
    if (!allowed.ok) return allowed;
    try {
        const row = await reviewRow(db, projectId, runId);
        if (!row) return failure("not_found", "Revisão não encontrada.");
        const run = await getPlaybookRunById(db, runId);
        if (!run) return failure("not_found", "Revisão não encontrada.");
        const [{ data: snapshot }, { data: playbook }, decisions, ficha] = await Promise.all([
            db.from("playbook_runs").select("content_json").eq("id", runId).maybeSingle(),
            db.from("playbooks").select("id, name").eq("id", row.playbook_id).maybeSingle(),
            decisionsOf(db, runId),
            fichaOf(db, projectId),
        ]);
        const precedentOf = await precedents(db, caller, projectId, ficha?.ficha ?? null);
        const { clauses, uncovered } = buildClauses({
            run,
            content: snapshot?.content_json ?? null,
            ficha,
            decisions,
            precedentOf,
        });
        return ok({
            id: run.id,
            status: run.status,
            error: run.error,
            summary: run.summary,
            started_at: run.startedAt,
            completed_at: run.completedAt,
            model: run.model,
            playbook: { id: row.playbook_id, name: (playbook?.name as string) ?? AVENIA_PLAYBOOK_NAME },
            document: { id: run.documentId ?? null, name: run.documentName, edited_version_id: run.editedVersionId ?? null },
            clauses,
            uncovered,
        });
    } catch (error) {
        return internalFailure(error);
    }
}

/** The contract's reviews, newest first, with their verdict counts: the Versions menu. */
export async function listContractReviews(
    db: Db,
    caller: Caller,
    projectId: string,
): Promise<ServiceResult<ReviewSummary[]>> {
    const allowed = await requireContractView(db, caller, projectId);
    if (!allowed.ok) return allowed;
    try {
        const { data, error } = await db
            .from("contract_review_runs")
            .select("run_id, playbook_id, created_at")
            .eq("project_id", projectId)
            .order("created_at", { ascending: false })
            .limit(20);
        if (error) throw error;
        const rows = (data ?? []) as { run_id: string; playbook_id: string; created_at: string }[];
        if (!rows.length) return ok([]);
        const [{ data: runs, error: runsError }, { data: playbooks, error: playbooksError }] = await Promise.all([
            db.from("playbook_runs").select("id, status, started_at, findings_json, updated_at").in("id", rows.map((r) => r.run_id)),
            db.from("playbooks").select("id, name").in("id", [...new Set(rows.map((r) => r.playbook_id))]),
        ]);
        if (runsError) throw runsError;
        if (playbooksError) throw playbooksError;
        const runById = new Map(((runs ?? []) as Record<string, unknown>[]).map((r) => [String(r.id), r]));
        const nameById = new Map(((playbooks ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]));
        return ok(
            rows.flatMap((row) => {
                const run = runById.get(row.run_id);
                if (!run) return [];
                const counts = { alinhado: 0, precisa_revisao: 0, diverge: 0 };
                for (const finding of (Array.isArray(run.findings_json) ? run.findings_json : []) as RunFinding[]) {
                    const verdict = VERDICT[finding.status];
                    if (verdict !== "nao_aplica") counts[verdict] += 1;
                }
                return [
                    {
                        id: row.run_id,
                        status: String(run.status),
                        started_at: String(run.started_at ?? row.created_at),
                        playbook_name: nameById.get(row.playbook_id) ?? AVENIA_PLAYBOOK_NAME,
                        counts,
                    },
                ];
            }),
        );
    } catch (error) {
        return internalFailure(error);
    }
}

const DECISIONS = new Set(["aceito", "editado", "rejeitado", "desfeito"]);

/**
 * Records a person's decision on one suggestion and applies it to the Word
 * document: accepting keeps the tracked change for the counterparty, rejecting
 * removes it, editing writes the person's wording over the suggestion's
 * inserted text as a new tracked change (the contract's original text stays
 * marked as deleted). A suggestion takes one decision; "desfeito" reopens it
 * only while the document is untouched — after an accept, or before any
 * decision reached the server (the toast's undo never sends one). A reject or
 * an edit already applied to the document is adjusted in the document itself.
 */
export async function decideReviewClause(
    db: Db,
    caller: Caller,
    projectId: string,
    runId: string,
    findingId: string,
    body: Record<string, unknown>,
): Promise<ServiceResult<{ decision: Decision | null; edit: EditAnnotation | null }>> {
    const decision = body.decision;
    if (typeof decision !== "string" || !DECISIONS.has(decision))
        return failure("validation", "Não reconheci a decisão. Escolha Aceitar, Editar ou Rejeitar.");
    const editedText = typeof body.edited_text === "string" ? body.edited_text.trim().slice(0, 20_000) : "";
    if (decision === "editado" && !editedText) return failure("validation", "Escreva a redação editada.");
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) || null : null;
    const allowed = await requireContractEdit(db, caller, projectId);
    if (!allowed.ok) return allowed;
    try {
        const row = await reviewRow(db, projectId, runId);
        if (!row) return failure("not_found", "Revisão não encontrada.");
        const existing = (await decisionsOf(db, runId)).get(findingId) ?? null;
        if (decision === "desfeito") {
            if (!existing) return ok({ decision: null, edit: null });
            if (existing.decision !== "aceito")
                return failure(
                    "conflict",
                    "Esta decisão já foi aplicada ao documento. Ajuste a alteração direto no documento.",
                );
            const { error } = await db
                .from("contract_review_decisions")
                .delete()
                .eq("run_id", runId)
                .eq("finding_id", findingId);
            if (error) throw error;
            return ok({ decision: null, edit: null });
        }
        if (existing) return failure("conflict", "Esta sugestão já foi decidida. Recarregue para ver a decisão.");
        const run = await getPlaybookRunById(db, runId);
        const finding = (run?.findings as RunFinding[] | undefined)?.find((f) => f.id === findingId);
        if (!run || !finding) return failure("not_found", "Sugestão não encontrada.");
        let edit: EditAnnotation | null = null;
        const documentId = run.documentId ?? null;
        const pending = finding.edit && finding.edit.status === "pending" ? finding.edit : null;
        if (decision === "editado" && documentId) {
            // Over the suggestion's own inserted text when it is in the
            // document, else over the contract language it quoted. One write:
            // if the wording cannot be placed, the document is unchanged.
            const target = pending?.inserted_text || finding.quote;
            if (!target) return failure("validation", "Esta sugestão não tem trecho no documento para editar.");
            const applied = await applyTrackedEditsToDocument({
                documentId,
                userId: caller.userId,
                userEmail: caller.userEmail,
                db,
                edits: [{ find: target, replace: editedText, context_before: "", context_after: "", reason: finding.ruleName }],
            });
            if (!applied.ok || !applied.annotations[0])
                return failure("conflict", "Não consegui aplicar a redação editada no documento. Recarregue e tente de novo.");
            edit = applied.annotations[0];
        } else if (decision === "rejeitado" && pending && documentId) {
            const rejected = await resolveEdit("reject", documentId, pending.edit_id, caller.userId, caller.userEmail ?? undefined, db);
            if (!rejected.ok) return failure("conflict", "O documento mudou desde a revisão. Recarregue e tente de novo.");
        }
        const decided: Decision = {
            decision: decision as Decision["decision"],
            edited_text: decision === "editado" ? editedText : null,
            reason: decision === "rejeitado" ? reason : null,
            decided_by: caller.userEmail ?? caller.userId,
            decided_at: new Date().toISOString(),
            edit,
        };
        // The primary key settles two people deciding at once: the second loses.
        const { error } = await db.from("contract_review_decisions").insert({ run_id: runId, finding_id: findingId, ...decided });
        if (error && (error as { code?: string }).code === "23505")
            return failure("conflict", "Esta sugestão já foi decidida. Recarregue para ver a decisão.");
        if (error) throw error;
        void recordAudit(db, {
            userId: caller.userId,
            userEmail: caller.userEmail,
            orgId: allowed.access.project?.org_id ?? null,
            action: `contract_review.${decision}`,
            surface: "contract_review",
            projectId,
            documentId,
            title: finding.ruleName,
            detail: { run_id: runId, finding_id: findingId, rule_id: finding.ruleId, reason: decided.reason },
        });
        return ok({ decision: decided, edit });
    } catch (error) {
        return internalFailure(error);
    }
}
