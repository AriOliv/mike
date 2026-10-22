// The contract portfolio: one row per contract the caller can open, with the
// Ficha's headline numbers and the dates that matter (term end, notice in
// days, notice deadline). The list is scoped on the server by the caller's
// project access; nothing here trusts a project id from the client.
//
// Term end and notice deadline come from the existing terms extraction
// (contract_terms) until the Ficha carries the term dates; the notice in
// days prefers the Ficha's literal reading and falls back to the terms.

import { workspaceMatches, type WorkspaceFilter } from "../../lib/workspace";
import type { Db } from "../../lib/supabase";
import { listAccessibleProjectIds } from "../../lib/access";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { fichaProgress, type Ficha } from "./contractReview.ficha";
import { durationDays } from "./contractReview.rules";
import type { Caller } from "./contractReview.shared";

export type PortfolioRow = {
    project_id: string;
    name: string;
    counterparty: string | null;
    contract_type: string | null;
    lane: string | null;
    term_end: string | null;
    notice_days: number | null;
    notice_deadline: string | null;
    filled: number;
    verified: number;
    total: number;
    risk: "critico" | "atencao" | "ok" | null;
};

export type Portfolio = { rows: PortfolioRow[]; total: number; next_offset: number | null };

const SORTS = new Set(["nome", "aviso"]);
const MAX_LIMIT = 100;
const CHUNK = 200;

type ProjectRow = { id: string; name: string; counterparty: string | null; contract_type: string | null; lane: string | null; org_id: string | null };

/** Fields that hold a reading of the contract: found, inferred or ambiguous. */
function filledCount(ficha: Ficha | null): number {
    return Object.values(ficha ?? {}).filter(
        (field) => !!field && field.status !== "nao_encontrado" && field.status !== "nao_aplicavel",
    ).length;
}

/** The notice the Ficha read: the non-renewal notice when it renews automatically, else the Avenia's notice to terminate. */
function fichaNoticeDays(ficha: Ficha | null): number | null {
    const renewal = ficha?.["vigencia.renovacao"];
    const value = renewal?.status === "encontrado" || renewal?.status === "inferido" ? (renewal.value as Record<string, unknown> | null) : null;
    if (value?.tipo === "automatica") return durationDays(value.aviso_nao_renovacao);
    const exit = ficha?.["rescisao.imotivada"];
    const exitValue = exit?.status === "encontrado" || exit?.status === "inferido" ? (exit.value as Record<string, unknown> | null) : null;
    return exitValue ? durationDays(exitValue.aviso_previo_avenia) : null;
}

export async function listContractPortfolio(
    db: Db,
    caller: Caller,
    query: Record<string, unknown>,
    /** Narrow to one workspace, the cut the home screen counts in; null = every contract the caller sees. */
    workspace: WorkspaceFilter = null,
): Promise<ServiceResult<Portfolio>> {
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    const offset = query.offset === undefined ? 0 : Number(query.offset);
    const sort = typeof query.sort === "string" ? query.sort : "nome";
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT || !Number.isInteger(offset) || offset < 0 || !SORTS.has(sort))
        return failure("validation", "Não entendi a página pedida. Recarregue a lista.");
    try {
        const ids = await listAccessibleProjectIds(caller.userId, caller.userEmail, db);
        const projects: ProjectRow[] = [];
        const fichas = new Map<string, { ficha: Ficha | null; risk_overall: PortfolioRow["risk"] }>();
        const terms = new Map<string, { term_end: string | null; notice_days: number | null; notice_deadline: string | null }>();
        for (let i = 0; i < ids.length; i += CHUNK) {
            const chunk = ids.slice(i, i + CHUNK);
            const [p, f, t] = await Promise.all([
                db
                    .from("projects")
                    .select("id, name, counterparty, contract_type, lane, org_id")
                    .in("id", chunk)
                    .not("lane", "is", null)
                    .is("archived_at", null),
                db.from("contract_fichas").select("project_id, ficha, risk_overall").in("project_id", chunk),
                db.from("contract_terms").select("project_id, term_end, notice_days, notice_deadline").in("project_id", chunk),
            ]);
            if (p.error) throw p.error;
            if (f.error) throw f.error;
            if (t.error) throw t.error;
            projects.push(...((p.data ?? []) as ProjectRow[]).filter((row) => workspaceMatches(workspace, row.org_id)));
            for (const row of (f.data ?? []) as { project_id: string; ficha: Ficha | null; risk_overall: PortfolioRow["risk"] }[])
                fichas.set(row.project_id, row);
            for (const row of (t.data ?? []) as ({ project_id: string } & PortfolioRow)[]) terms.set(row.project_id, row);
        }
        const rows: PortfolioRow[] = projects.map((project) => {
            const ficha = fichas.get(project.id)?.ficha ?? null;
            const term = terms.get(project.id);
            const progress = fichaProgress(ficha);
            return {
                project_id: project.id,
                name: project.name,
                counterparty: project.counterparty,
                contract_type: project.contract_type,
                lane: project.lane,
                term_end: term?.term_end ?? null,
                notice_days: fichaNoticeDays(ficha) ?? term?.notice_days ?? null,
                notice_deadline: term?.notice_deadline ?? null,
                filled: filledCount(ficha),
                verified: progress.verified,
                total: progress.total,
                risk: fichas.get(project.id)?.risk_overall ?? null,
            };
        });
        rows.sort((a, b) => {
            if (sort === "aviso") {
                // Soonest notice deadline first; contracts without one last.
                if (a.notice_deadline !== b.notice_deadline) {
                    if (!a.notice_deadline) return 1;
                    if (!b.notice_deadline) return -1;
                    return a.notice_deadline.localeCompare(b.notice_deadline);
                }
            }
            return a.name.localeCompare(b.name, "pt-BR");
        });
        const page = rows.slice(offset, offset + limit);
        return ok({ rows: page, total: rows.length, next_offset: offset + limit < rows.length ? offset + limit : null });
    } catch (error) {
        return internalFailure(error);
    }
}
