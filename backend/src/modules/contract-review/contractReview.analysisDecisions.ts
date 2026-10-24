// What the legal team does with an analysis: decide each redline suggestion,
// and take the analysis out as Markdown (to paste in a chat) or Word.
//
// A redline reaches the contract only when a person accepts or edits it: then
// it is applied to the Word document as a tracked change, in one write, so the
// document is unchanged if the wording cannot be placed. A rejection is only
// recorded. A PDF contract has no redline; its decisions are recorded alone.

import type { Db } from "../../lib/supabase";
import { recordAudit } from "../../lib/audit";
import { profileAttributionName } from "../../lib/userLookup";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import type { EditAnnotation } from "@mike/contracts";
import { applyTrackedEditsToDocument } from "../documents/documents.service";
import { recordCardEvent } from "../contracts/contracts.service";
import { contractDocument, requireContractEdit, type Caller } from "./contractReview.shared";
import type { AnalysisItem, AnalysisResult, Redline } from "./contractReview.analysis";

export type RedlineDecision = {
    redline_id: string;
    decision: "aceito" | "editado" | "rejeitado";
    edited_text: string | null;
    reason: string | null;
    decided_by: string;
    decided_at: string;
    edit: EditAnnotation | null;
};

/** Two people wrote the same contract at once and this one lost every retry: nothing was saved, and the person is told. */
export const SAVE_CONFLICT = "O contrato foi alterado por outra pessoa ao mesmo tempo. Sua decisão não foi gravada; tente de novo.";

/** The redline's quote is no longer in the contract (someone changed that clause since the analysis). */
export const TEXT_CHANGED = "Esse trecho já foi alterado no contrato. Peça uma nova análise para esta cláusula.";
/** The quote is in the contract more than once: the server does not guess where. */
export const TEXT_AMBIGUOUS = "Esse trecho aparece em mais de um lugar do contrato; aplique pela tela de revisão.";

const DECISIONS = new Set(["aceito", "editado", "rejeitado"]);

async function callerName(db: Db, caller: Caller): Promise<string> {
    const { data } = await db.from("user_profiles").select("display_name, email").eq("user_id", caller.userId).maybeSingle();
    return profileAttributionName(data as { display_name?: unknown; email?: unknown } | null, caller.userEmail ?? "Alguém da equipe");
}

type AnalysisRow = { id: string; project_id: string; version_id: string | null; status: string; result: AnalysisResult | null };

async function analysisOf(db: Db, projectId: string, analysisId: string): Promise<AnalysisRow | null> {
    if (!/^[0-9a-f-]{36}$/i.test(analysisId)) return null;
    const { data, error } = await db
        .from("contract_analyses")
        .select("id, project_id, version_id, status, result")
        .eq("id", analysisId)
        .eq("project_id", projectId)
        .maybeSingle();
    if (error) throw error;
    return (data as AnalysisRow | null) ?? null;
}

/** The decisions taken on an analysis's redlines, by redline id. */
export async function listRedlineDecisions(
    db: Db,
    caller: Caller,
    projectId: string,
    analysisId: string,
): Promise<ServiceResult<RedlineDecision[]>> {
    const allowed = await requireContractEdit(db, caller, projectId);
    if (!allowed.ok) return allowed;
    try {
        if (!(await analysisOf(db, projectId, analysisId))) return failure("not_found", "Análise não encontrada.");
        const { data, error } = await db
            .from("contract_analysis_decisions")
            .select("redline_id, decision, edited_text, reason, decided_by, decided_at, edit")
            .eq("analysis_id", analysisId);
        if (error) throw error;
        return ok((data ?? []) as RedlineDecision[]);
    } catch (error) {
        return internalFailure(error);
    }
}

/** Accept, edit or reject one redline suggestion. */
export async function decideAnalysisRedline(
    db: Db,
    caller: Caller,
    projectId: string,
    analysisId: string,
    redlineId: string,
    body: Record<string, unknown>,
): Promise<ServiceResult<RedlineDecision>> {
    const decision = body.decision;
    if (typeof decision !== "string" || !DECISIONS.has(decision))
        return failure("validation", "Não reconheci a decisão. Escolha Aceitar, Editar ou Rejeitar.");
    const editedText = typeof body.edited_text === "string" ? body.edited_text.trim().slice(0, 20_000) : "";
    if (decision === "editado" && !editedText) return failure("validation", "Escreva a redação editada.");
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) || null : null;
    const allowed = await requireContractEdit(db, caller, projectId);
    if (!allowed.ok) return allowed;
    try {
        const analysis = await analysisOf(db, projectId, analysisId);
        if (!analysis || analysis.status !== "done" || !analysis.result) return failure("not_found", "Análise não encontrada.");
        const redline = analysis.result.redlines.find((r) => r.id === redlineId);
        if (!redline) return failure("not_found", "Sugestão não encontrada.");
        const { data: existing, error: existingError } = await db
            .from("contract_analysis_decisions")
            .select("redline_id")
            .eq("analysis_id", analysisId)
            .eq("redline_id", redlineId)
            .maybeSingle();
        if (existingError) throw existingError;
        if (existing) return failure("conflict", "Esta sugestão já foi decidida. Recarregue para ver a decisão.");

        let edit: EditAnnotation | null = null;
        if (decision !== "rejeitado") {
            const doc = await contractDocument(db, projectId);
            // What decides is the FACT, not the version: the applier places the redline's "from" in the
            // ACTIVE document only when it is there exactly once. A decision taken on another clause of the
            // contract (a playbook review, another redline) makes a newer version without touching this
            // quote, and must not stop it; a quote that changed, or that is repeated, is told to the person.
            if (!doc) return failure("not_found", "O contrato não tem documento para aplicar a redação.");
            if (doc.isDocx) {
                const applied = await applyTrackedEditsToDocument({
                    documentId: doc.documentId,
                    userId: caller.userId,
                    userEmail: caller.userEmail,
                    db,
                    edits: [
                        {
                            find: redline.from,
                            replace: decision === "editado" ? editedText : redline.to,
                            context_before: "",
                            context_after: "",
                            reason: redline.why || redline.clause || "Análise do analista",
                        },
                    ],
                });
                if (!applied.ok && applied.conflict) return failure("conflict", SAVE_CONFLICT, "document_busy");
                if (!applied.ok && applied.reason === "not_found") return failure("conflict", TEXT_CHANGED, "analysis_text_changed");
                if (!applied.ok && applied.reason === "ambiguous") return failure("conflict", TEXT_AMBIGUOUS, "analysis_text_ambiguous");
                if (!applied.ok || !applied.annotations[0])
                    return failure("conflict", "Não consegui colocar a redação no documento. Recarregue e tente de novo.");
                edit = applied.annotations[0];
            }
        }
        const decided: RedlineDecision = {
            redline_id: redlineId,
            decision: decision as RedlineDecision["decision"],
            edited_text: decision === "editado" ? editedText : null,
            reason: decision === "rejeitado" ? reason : null,
            decided_by: await callerName(db, caller),
            decided_at: new Date().toISOString(),
            edit,
        };
        // The primary key settles two people deciding at once: the second loses.
        const { error } = await db.from("contract_analysis_decisions").insert({ analysis_id: analysisId, ...decided });
        if (error && (error as { code?: string }).code === "23505")
            return failure("conflict", "Esta sugestão já foi decidida. Recarregue para ver a decisão.");
        if (error) throw error;
        void recordAudit(db, {
            userId: caller.userId,
            userEmail: caller.userEmail,
            orgId: allowed.access.project?.org_id ?? null,
            action: `contract_analysis.${decision}`,
            surface: "contract_review",
            projectId,
            title: redline.clause ?? "Redline",
            detail: { analysis_id: analysisId, redline_id: redlineId, reason: decided.reason },
        });
        void recordCardEvent(db, {
            projectId,
            orgId: allowed.access.project?.org_id ?? null,
            actorType: "user",
            actorId: caller.userId,
            actorName: decided.decided_by,
            action: `analysis.redline_${decision}`,
            field: redline.clause ?? null,
            after: { analysis_id: analysisId, redline_id: redlineId, reason: decided.reason },
        });
        return ok(decided);
    } catch (error) {
        return internalFailure(error);
    }
}

const DEPENDS_ON_LABEL: Record<string, string> = {
    juridico_interno: "jurídico interno",
    founder: "founder",
    contraparte: "contraparte",
    due_diligence: "due diligence",
    outro: "outro",
};

function itemLines(items: AnalysisItem[], withSuggestion: boolean): string[] {
    if (!items.length) return ["- Nenhum."];
    return items.flatMap((item) => [
        `- *${item.title}*${item.clause ? ` (${item.clause})` : ""}: "${item.quote}"`,
        `  ${item.rationale}`,
        ...(withSuggestion && item.suggestion ? [`  Sugestão: ${item.suggestion}`] : []),
    ]);
}

/**
 * The analysis as Markdown in the analyst's fixed layout, ready to paste in a
 * chat (single-asterisk bold, which chat tools render). Decided redlines show
 * the decision; a rejected one is left out.
 */
export function analysisMarkdown(title: string, result: AnalysisResult, decisions: RedlineDecision[] = []): string {
    const byRedline = new Map(decisions.map((d) => [d.redline_id, d]));
    const redlines = result.redlines.filter((r) => byRedline.get(r.id)?.decision !== "rejeitado");
    const redlineLines = (r: Redline, index: number) => {
        const decided = byRedline.get(r.id);
        const to = decided?.decision === "editado" && decided.edited_text ? decided.edited_text : r.to;
        const status = decided ? ` [${decided.decision}]` : "";
        return [
            `${index + 1}. ${r.clause ? `(${r.clause}) ` : ""}DE: "${r.from}"${status}`,
            `   PARA: "${to}"`,
            `   POR QUÊ: ${r.why}`,
        ];
    };
    return [
        `📋 *Análise — ${title}*`,
        `_${result.notice}_`,
        "",
        "*Resumo executivo*",
        result.executive_summary.text || "—",
        "",
        "🔴 *Riscos críticos*",
        ...itemLines(result.critical, true),
        "",
        "🟡 *Pontos de atenção*",
        ...itemLines(result.attention, true),
        "",
        "🟢 *Pontos favoráveis*",
        ...itemLines(result.favorable, false),
        "",
        "📌 *Sugestões de redline*",
        ...(redlines.length ? redlines.flatMap(redlineLines) : ["- Nenhuma."]),
        "",
        "*Conformidade*",
        `- Proteção de dados (LGPD): ${result.compliance.data_protection || "—"}`,
        `- Confidencialidade: ${result.compliance.confidentiality || "—"}`,
        `- Lei aplicável e foro: ${result.compliance.governing_law_forum || "—"}`,
        `- Prazo, rescisão e penalidades: ${result.compliance.term_termination_penalties || "—"}`,
        "",
        "❓ *Pontos abertos*",
        ...(result.open_points.length
            ? result.open_points.map((p) => `- ${p.text} (depende de: ${DEPENDS_ON_LABEL[p.depends_on] ?? p.depends_on})`)
            : ["- Nenhum."]),
    ].join("\n");
}

/**
 * The Markdown layout as a Word file: one paragraph per line, the section
 * lines as headings and *bold* runs kept. Simple on purpose: it is for
 * reading and forwarding, not for editing the contract.
 */
export async function analysisDocx(markdown: string): Promise<Buffer> {
    const { Document, HeadingLevel, Packer, Paragraph, TextRun } = await import("docx");
    const runs = (line: string) =>
        line.split(/(\*[^*]+\*|_[^_]+_)/).filter(Boolean).map((part) =>
            /^\*[^*]+\*$/.test(part)
                ? new TextRun({ text: part.slice(1, -1), bold: true })
                : /^_[^_]+_$/.test(part)
                  ? new TextRun({ text: part.slice(1, -1), italics: true })
                  : new TextRun({ text: part }),
        );
    const lines = markdown.split("\n");
    const children = lines.map((line, index) => {
        const section = /^(📋|🔴|🟡|🟢|📌|❓)?\s*\*[^*]+\*$/.test(line.trim());
        if (index === 0) return new Paragraph({ heading: HeadingLevel.HEADING_1, children: runs(line) });
        if (section) return new Paragraph({ heading: HeadingLevel.HEADING_2, children: runs(line) });
        return new Paragraph({ children: runs(line) });
    });
    return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

/** The analysis to take out of the app, for the legal team. */
export async function exportAnalysis(
    db: Db,
    caller: Caller,
    projectId: string,
    analysisId: string,
): Promise<ServiceResult<{ filename: string; markdown: string }>> {
    const allowed = await requireContractEdit(db, caller, projectId);
    if (!allowed.ok) return allowed;
    try {
        const analysis = await analysisOf(db, projectId, analysisId);
        if (!analysis || analysis.status !== "done" || !analysis.result) return failure("not_found", "Análise não encontrada.");
        const { data: project } = await db.from("projects").select("name").eq("id", projectId).maybeSingle();
        const title = String((project as { name?: unknown } | null)?.name ?? "Contrato");
        const { data: decisions, error } = await db
            .from("contract_analysis_decisions")
            .select("redline_id, decision, edited_text, reason, decided_by, decided_at, edit")
            .eq("analysis_id", analysisId);
        if (error) throw error;
        const filename = `Análise - ${title}`.replace(/[\\/:*?"<>|]+/g, " ").slice(0, 120);
        return ok({ filename, markdown: analysisMarkdown(title, analysis.result, (decisions ?? []) as RedlineDecision[]) });
    } catch (error) {
        return internalFailure(error);
    }
}
