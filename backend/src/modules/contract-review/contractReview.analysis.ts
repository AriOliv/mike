// The analyst's analysis of a contract, as a legal analyst writes it before the
// team decides: an executive summary (object, parties, value), critical risks
// (reject or renegotiate, each quoting the contract), points of attention
// (with the adjustment), favourable points, redline suggestions (clause, from,
// to, why), compliance (data protection, confidentiality, governing law and
// forum, term / termination / penalties) and open points (what depends on
// internal legal, a founder, the counterparty or due diligence).
//
// This file is the pure part: the prompt, and the normalization that turns the
// model's answer into the stored result. Every item must quote the contract;
// the verifier looks each quote up in the document's text and drops an item
// whose quote is not there, recording why. When the organization has a
// playbook for the contract's type, its run is the yardstick: an item on a
// rule takes the light the playbook gave that rule.

import { locateQuote } from "./contractReview.ficha";

/** Shown on every analysis: it is a draft for the legal team. */
export const ANALYSIS_NOTICE = "Rascunho gerado por IA para o time jurídico. Não é parecer jurídico.";
export const ANALYSIS_PROMPT_VERSION = "analise-analista-v1";

export type Light = "red" | "yellow" | "green";
export type IntakeAnswer = { key: string; label: string; value: string; source?: string | null };

export type AnalysisItem = {
    id: string;
    title: string;
    /** Verbatim from the contract; verified against the text. */
    quote: string;
    clause: string | null;
    rationale: string;
    suggestion: string | null;
    light: Light;
    rule_id: string | null;
    /** Where the quote is in the document's text, for scrolling to it. */
    span: { start: number; end: number } | null;
};
export type Redline = {
    id: string;
    clause: string | null;
    from: string;
    to: string;
    why: string;
    item_id: string | null;
    span: { start: number; end: number } | null;
};
export type OpenPoint = {
    id: string;
    text: string;
    depends_on: "juridico_interno" | "founder" | "contraparte" | "due_diligence" | "outro";
};
export type AnalysisResult = {
    notice: string;
    executive_summary: { text: string; object: string | null; parties: string[]; value: string | null };
    critical: AnalysisItem[];
    attention: AnalysisItem[];
    favorable: AnalysisItem[];
    redlines: Redline[];
    compliance: {
        data_protection: string;
        confidentiality: string;
        governing_law_forum: string;
        term_termination_penalties: string;
    };
    open_points: OpenPoint[];
};
export type DroppedCitation = { section: string; title: string; quote: string; reason: string };

/** A playbook finding, as far as the analysis needs it. */
export type RuleFinding = { ruleId: string | null; ruleName: string; status: string; quote?: string; analysis?: string };

const LIGHT_BY_STATUS: Record<string, Light | undefined> = {
    unacceptable: "red",
    missing_required: "red",
    needs_review: "yellow",
    acceptable: "green",
};
const SECTION_LIGHT: Record<"critical" | "attention" | "favorable", Light> = {
    critical: "red",
    attention: "yellow",
    favorable: "green",
};
const SECTION_BY_LIGHT: Record<Light, "critical" | "attention" | "favorable"> = {
    red: "critical",
    yellow: "attention",
    green: "favorable",
};
const DEPENDS_ON = new Set<OpenPoint["depends_on"]>(["juridico_interno", "founder", "contraparte", "due_diligence", "outro"]);

/** The prompt: the contract, the intake answers as context, and the playbook as the yardstick when there is one. */
export function analysisPrompt(args: {
    documentText: string;
    documentName: string;
    intake: IntakeAnswer[];
    playbook: { name: string; findings: RuleFinding[] } | null;
}): string {
    const intake = args.intake.length
        ? args.intake.map((a) => `- ${a.label}: ${a.value}`).join("\n")
        : "(o checklist de intake não foi preenchido; trate o que faltar como ponto aberto)";
    const yardstick = args.playbook
        ? `\nRÉGUA: o playbook "${args.playbook.name}" da organização já julgou este contrato. Use esses julgamentos: um item sobre uma regra leva o rule_id dela, e regra inaceitável ou obrigatória ausente é risco crítico; regra a revisar é ponto de atenção; regra aceitável pode ser ponto favorável.\n${JSON.stringify(
              args.playbook.findings
                  .filter((f) => f.status !== "not_applicable" && f.status !== "outside_scope")
                  .map((f) => ({ rule_id: f.ruleId, regra: f.ruleName, status: f.status, analise: (f.analysis ?? "").slice(0, 400) })),
          ).slice(0, 30_000)}\n`
        : "\nSem playbook da organização para este tipo de contrato: use o critério geral de um advogado brasileiro que representa a Avenia.\n";
    return `Revise o contrato abaixo considerando as respostas do checklist de intake. A parte representada é a Avenia.

Regras invioláveis:
- Português do Brasil, tom profissional e objetivo.
- NUNCA diga se a Avenia deve ou não assinar: aponte riscos e sugira ajustes; a decisão é humana.
- NUNCA invente cláusula ou trecho. Todo risco, ponto de atenção e ponto favorável cita TEXTUALMENTE um trecho do contrato (até 400 caracteres, copiado sem alterar), com o número da cláusula quando houver.
- Redline: "from" é o trecho original exato; "to" é a redação completa que o substitui.
- Ponto aberto é o que depende de informação externa: jurídico interno, founder, contraparte ou due diligence.

CHECKLIST DE INTAKE (contexto do pedido):
${intake}
${yardstick}
Responda só JSON:
{"executive_summary":{"text":"3 a 5 linhas: objeto, partes e valor","object":"","parties":[""],"value":""|null},
"critical":[{"title":"","quote":"trecho literal","clause":"cl. X"|null,"rationale":"","suggestion":""|null,"rule_id":""|null}],
"attention":[mesmo formato, com suggestion],
"favorable":[mesmo formato],
"redlines":[{"clause":"cl. X"|null,"from":"trecho original exato","to":"redação sugerida","why":"","item_index":{"section":"critical|attention","index":0}|null}],
"compliance":{"data_protection":"","confidentiality":"","governing_law_forum":"","term_termination_penalties":""},
"open_points":[{"text":"","depends_on":"juridico_interno|founder|contraparte|due_diligence|outro"}]}

CONTRATO (${args.documentName}):
${args.documentText.slice(0, 180_000)}`;
}

const text = (value: unknown, max: number): string =>
    typeof value === "string" ? value.trim().slice(0, max) : "";
const textOrNull = (value: unknown, max: number): string | null => text(value, max) || null;

/**
 * The stored result from the model's answer: every quote verified (an item or
 * redline whose quote is not in the text is dropped and recorded), the light
 * set by the playbook's verdict on the item's rule when there is one, and the
 * notice always present.
 */
export function normalizeAnalysis(
    raw: unknown,
    documentText: string,
    playbookFindings: RuleFinding[] = [],
): { result: AnalysisResult; dropped: DroppedCitation[] } {
    const answer = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const dropped: DroppedCitation[] = [];
    const ruleLight = new Map<string, Light>();
    for (const finding of playbookFindings) {
        const light = finding.ruleId ? LIGHT_BY_STATUS[finding.status] : undefined;
        if (finding.ruleId && light) ruleLight.set(finding.ruleId, light);
    }
    const sections: Record<"critical" | "attention" | "favorable", AnalysisItem[]> = { critical: [], attention: [], favorable: [] };
    // Index of each model item → the id it kept, so a redline can point at it.
    const kept = new Map<string, string>();
    for (const section of ["critical", "attention", "favorable"] as const) {
        const items = Array.isArray(answer[section]) ? (answer[section] as unknown[]) : [];
        items.slice(0, 40).forEach((entry, index) => {
            if (!entry || typeof entry !== "object") return;
            const item = entry as Record<string, unknown>;
            const title = text(item.title, 300) || "Sem título";
            const quote = text(item.quote, 1_000);
            if (!quote) {
                dropped.push({ section, title, quote: "", reason: "sem trecho citado" });
                return;
            }
            const located = locateQuote(documentText, quote);
            if (located.match === "nao_encontrado") {
                dropped.push({ section, title, quote, reason: "trecho não encontrado no documento" });
                return;
            }
            const ruleId = textOrNull(item.rule_id, 100);
            // The playbook's verdict on the rule decides the light, and so the section.
            const light = (ruleId && ruleLight.get(ruleId)) || SECTION_LIGHT[section];
            const id = `${section[0]}${index + 1}`;
            kept.set(`${section}:${index}`, id);
            sections[SECTION_BY_LIGHT[light]].push({
                id,
                title,
                quote,
                clause: textOrNull(item.clause, 60),
                rationale: text(item.rationale, 4_000),
                suggestion: textOrNull(item.suggestion, 4_000),
                light,
                rule_id: ruleId,
                span: located.span,
            });
        });
    }
    const redlines: Redline[] = [];
    (Array.isArray(answer.redlines) ? (answer.redlines as unknown[]) : []).slice(0, 40).forEach((entry, index) => {
        if (!entry || typeof entry !== "object") return;
        const item = entry as Record<string, unknown>;
        const from = text(item.from, 4_000);
        const to = text(item.to, 6_000);
        const clause = textOrNull(item.clause, 60);
        if (!from || !to) {
            dropped.push({ section: "redlines", title: clause ?? `redline ${index + 1}`, quote: from, reason: "redline sem DE ou PARA" });
            return;
        }
        const located = locateQuote(documentText, from);
        if (located.match === "nao_encontrado") {
            dropped.push({ section: "redlines", title: clause ?? `redline ${index + 1}`, quote: from, reason: "trecho DE não encontrado no documento" });
            return;
        }
        const ref = item.item_index as { section?: unknown; index?: unknown } | null | undefined;
        const itemId =
            ref && typeof ref.section === "string" && typeof ref.index === "number"
                ? (kept.get(`${ref.section}:${ref.index}`) ?? null)
                : null;
        redlines.push({ id: `r${index + 1}`, clause, from, to, why: text(item.why, 2_000), item_id: itemId, span: located.span });
    });
    const summary = (answer.executive_summary ?? {}) as Record<string, unknown>;
    const compliance = (answer.compliance ?? {}) as Record<string, unknown>;
    const openPoints: OpenPoint[] = (Array.isArray(answer.open_points) ? (answer.open_points as unknown[]) : [])
        .slice(0, 30)
        .flatMap((entry, index) => {
            const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
            const body = text(item.text, 1_000);
            if (!body) return [];
            const dependsOn = DEPENDS_ON.has(item.depends_on as OpenPoint["depends_on"])
                ? (item.depends_on as OpenPoint["depends_on"])
                : "outro";
            return [{ id: `o${index + 1}`, text: body, depends_on: dependsOn }];
        });
    return {
        result: {
            notice: ANALYSIS_NOTICE,
            executive_summary: {
                text: text(summary.text, 2_000),
                object: textOrNull(summary.object, 500),
                parties: (Array.isArray(summary.parties) ? summary.parties : []).map((p) => text(p, 300)).filter(Boolean).slice(0, 10),
                value: textOrNull(summary.value, 500),
            },
            ...sections,
            redlines,
            compliance: {
                data_protection: text(compliance.data_protection, 2_000),
                confidentiality: text(compliance.confidentiality, 2_000),
                governing_law_forum: text(compliance.governing_law_forum, 2_000),
                term_termination_penalties: text(compliance.term_termination_penalties, 2_000),
            },
            open_points: openPoints,
        },
        dropped,
    };
}

/** An open point that the intake checklist was not filled, added when the analysis ran without it. */
export function withMissingIntake(result: AnalysisResult, intake: IntakeAnswer[]): AnalysisResult {
    if (intake.length) return result;
    return {
        ...result,
        open_points: [
            { id: "o0", text: "Checklist de intake não preenchido: a análise não considerou o contexto do pedido.", depends_on: "outro" },
            ...result.open_points,
        ],
    };
}

// List prices in US$ per million tokens (input, output), by model family.
const PRICES: [RegExp, number, number][] = [
    [/haiku/i, 1, 5],
    [/sonnet/i, 3, 15],
    [/opus/i, 15, 75],
];

/**
 * Tokens as the provider reported them, else from characters (≈4 per token,
 * which undercounts Portuguese), at the list price of the model's family;
 * null price when unknown. `estimated` says whether any call had no report.
 */
export function estimateUsage(
    model: string,
    calls: { input: number; output: number; reported?: { inputTokens: number; outputTokens: number } | null }[],
) {
    const input = calls.reduce((sum, call) => sum + (call.reported ? call.reported.inputTokens : Math.round(call.input / 4)), 0);
    const output = calls.reduce((sum, call) => sum + (call.reported ? call.reported.outputTokens : Math.round(call.output / 4)), 0);
    const price = PRICES.find(([pattern]) => pattern.test(model));
    const cost = price ? (input / 1e6) * price[1] + (output / 1e6) * price[2] : null;
    return {
        model,
        calls: calls.length,
        input_tokens: input,
        output_tokens: output,
        estimated_cost_usd: cost === null ? null : Math.round(cost * 10_000) / 10_000,
        estimated: calls.some((call) => !call.reported),
    };
}

/** Counts for the alert and the card event. */
export function analysisCounts(result: AnalysisResult) {
    return { critical: result.critical.length, attention: result.attention.length };
}
