// The review's slice of the Ficha (docs/product/contract-schema.v1.json): the
// fields a playbook review judges, each in the schema's envelope (status,
// value, citations, confidence, origin, review). The model extracts literal
// values with quotes; code verifies every quote against the contract text and
// can only lower confidence, never raise it (02-ficha-do-contrato §1, §7).
//
// A field a person confirmed or corrected is never overwritten by a new
// extraction: the model's new reading goes to `ai_value` with a note instead.

export type FieldStatus = "encontrado" | "inferido" | "ambiguo" | "nao_encontrado" | "nao_aplicavel";
export type Confidence = "alta" | "media" | "baixa";
export type Match = "exato" | "normalizado" | "nao_encontrado";
export type ReviewState = "pendente" | "confirmado" | "corrigido";

export type Citation = {
    quote: string;
    clause: string | null;
    span: { start: number; end: number } | null;
    verified: boolean;
    match: Match;
};

export type FichaField = {
    status: FieldStatus;
    value: unknown;
    citations: Citation[];
    confidence: Confidence | null;
    origin: "ia" | "humano";
    notes: string | null;
    ai_value?: unknown;
    review: { state: ReviewState; by: string | null; at: string | null; comment: string | null };
};

export type Duration = {
    amount: number;
    unit: "horas" | "dias" | "meses" | "anos";
    day_count: "corridos" | "uteis" | "nao_especificado";
};

/**
 * The fields the review shows and the rules read, with the plain-language
 * label the Legal team uses (the spreadsheet's columns) and the value shape
 * the model must return. Paths are the schema's.
 */
export const FICHA_FIELDS = [
    {
        path: "identificacao.tipo_contrato",
        label: "Tipo de contrato",
        shape: '{"categoria": "nda|prestacao_servicos|msa|pedido_sow|licenca_saas|parceria_comercial|indicacao_rebate|parceiro_bancario_baas|arranjo_psp_adquirencia|liquidez_otc_cambio|custodia_cripto|cliente_api_plataforma|locacao|prestador_pj|mutuo_emprestimo|carta_intencao_mou|procuracao|outro"}',
    },
    { path: "identificacao.papel_avenia", label: "Papel da Avenia", shape: '"contratante|contratada|mutuo|outro"' },
    { path: "identificacao.contraparte", label: "Contraparte", shape: '{"nome": "razão social"}' },
    {
        path: "vigencia.prazo",
        label: "Prazo de vigência",
        shape: '{"tipo": "determinado|indeterminado", "duracao": DURACAO|null}',
    },
    {
        path: "vigencia.renovacao",
        label: "Renovação",
        shape: '{"tipo": "automatica|mediante_aditivo|opcao_unilateral|sem_renovacao|nao_regulada", "aviso_nao_renovacao": DURACAO|null, "limite_renovacoes": inteiro|null}',
    },
    {
        path: "rescisao.imotivada",
        label: "Rescisão sem justa causa",
        shape: '{"permitida_para": "ambas|somente_avenia|somente_contraparte|nenhuma", "aviso_previo_avenia": DURACAO|null, "aviso_previo_contraparte": DURACAO|null}',
    },
    {
        path: "rescisao.multa_rescisoria",
        label: "Multa rescisória",
        shape: '{"existe": bool, "tipo": "fixo|percentual_valor_total|percentual_saldo|meses_remuneracao|proporcional|formula"|null, "percentual": número|null, "meses": número|null, "devida_por": "avenia|contraparte|ambas"|null}',
    },
    {
        path: "alteracao_parte.cessao",
        label: "Cessão",
        shape: '{"regime": "livre|notificacao|consentimento_previo|vedada|nao_regulada", "aplica_a": "avenia|contraparte|ambas"|null, "excecoes": ["afiliadas"|"reorganizacao_societaria"|"sucessor_fusao_incorporacao"|"outro"]}',
    },
    {
        path: "alteracao_parte.mudanca_controle",
        label: "Mudança de controle",
        shape: '{"regime": "livre|notificacao|consentimento_previo|vedada|nao_regulada", "aplica_a": "avenia|contraparte|ambas"|null, "direito_rescisao_contraparte": bool|null, "define_controle": bool|null}',
    },
    { path: "dados_pessoais.compartilhamento", label: "Compartilha dados pessoais", shape: "bool" },
    {
        path: "dados_pessoais.papel_avenia",
        label: "Papel LGPD da Avenia",
        shape: '"controlador|operador|controlador_conjunto|suboperador|nao_definido"',
    },
    { path: "dados_pessoais.dpa", label: "Regras de tratamento (DPA)", shape: '"no_corpo|anexo|por_referencia|ausente"' },
    {
        path: "dados_pessoais.transferencia_internacional",
        label: "Transferência internacional",
        shape: '{"ocorre": bool, "mecanismo": "texto"|null}',
    },
    {
        path: "responsabilidade.limitacao",
        label: "Limitação de responsabilidade",
        shape: '{"existe": bool, "protege": "avenia|contraparte|ambas"|null, "tipo": "valor_fixo|multiplo_remuneracao|meses_remuneracao|ilimitada"|null, "meses": número|null}',
    },
    {
        path: "responsabilidade.multa_geral",
        label: "Multa por descumprimento",
        shape: '{"existe": bool, "devida_por": "avenia|contraparte|ambas"|null, "limitada": bool|null}',
    },
    {
        path: "regulatorio.confidencialidade",
        label: "Confidencialidade e reguladores",
        shape: '{"existe": bool, "carve_out_autoridades": bool|null, "exige_aviso_previo_a_contraparte": bool|null}',
    },
    { path: "foro.lei_aplicavel", label: "Lei aplicável", shape: '{"jurisdicao": "código ISO do país, ex. BR"}' },
] as const;

export type FichaPath = (typeof FICHA_FIELDS)[number]["path"];
export type Ficha = Partial<Record<FichaPath, FichaField>>;

const PATHS = new Set<string>(FICHA_FIELDS.map((field) => field.path));
const STATUSES = new Set<FieldStatus>(["encontrado", "inferido", "ambiguo", "nao_encontrado", "nao_aplicavel"]);
const CONFIDENCES = new Set<Confidence>(["alta", "media", "baixa"]);

export function extractionPrompt(documentText: string): string {
    const fields = FICHA_FIELDS.map((field) => `- ${field.path} (${field.label}): ${field.shape}`).join("\n");
    return `Extraia do contrato abaixo os campos da Ficha. A parte representada é a Avenia.

Regras invioláveis:
- Extraia o LITERAL. Nunca calcule datas nem converta prazos: "30 (trinta) dias úteis" vira {"amount":30,"unit":"dias","day_count":"uteis"}.
- DURACAO = {"amount": número, "unit": "horas|dias|meses|anos", "day_count": "corridos|uteis|nao_especificado"}.
- status: encontrado (o texto diz; cite), inferido (conclusão sobre o todo; explique em notes), ambiguo (cláusulas conflitantes; cite as duas), nao_encontrado (o contrato não trata do tema; value null), nao_aplicavel (o tema não cabe neste tipo de contrato; value null).
- Toda citação é um trecho VERBATIM do contrato, curto (até 400 caracteres), com a cláusula (ex.: "cl. 12.1") quando houver.
- confidence: alta (literal e explícito), media (exige combinar cláusulas), baixa (redação vaga).
- Nunca invente cláusula, número ou valor.

Campos:
${fields}

Responda só JSON: {"fields": {"<caminho>": {"status": "...", "value": ..., "citations": [{"quote": "...", "clause": "..."}], "confidence": "alta|media|baixa", "notes": "..."|null}}}

CONTRATO:
${documentText.slice(0, 180_000)}`;
}

function collapse(text: string): { text: string; map: number[] } {
    // Lower-cased, accents kept, every whitespace run collapsed to one space;
    // `map[i]` is the original offset of collapsed character i.
    const map: number[] = [];
    let out = "";
    let lastSpace = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (/\s/.test(ch)) {
            if (lastSpace) continue;
            lastSpace = true;
            out += " ";
        } else {
            lastSpace = false;
            out += ch.toLowerCase();
        }
        map.push(i);
    }
    return { text: out, map };
}

/** Finds a quote in the contract: exactly, then ignoring case and spacing. */
export function locateQuote(documentText: string, quote: string): { match: Match; span: Citation["span"] } {
    const wanted = quote.trim();
    if (!wanted) return { match: "nao_encontrado", span: null };
    const exact = documentText.indexOf(wanted);
    if (exact >= 0) return { match: "exato", span: { start: exact, end: exact + wanted.length } };
    const doc = collapse(documentText);
    const needle = collapse(wanted).text.trim();
    const at = needle ? doc.text.indexOf(needle) : -1;
    if (at < 0) return { match: "nao_encontrado", span: null };
    const start = doc.map[at];
    const end = doc.map[at + needle.length - 1] + 1;
    return { match: "normalizado", span: { start, end } };
}

function lowerConfidence(current: Confidence | null, citations: Citation[]): Confidence | null {
    if (!current) return current;
    if (citations.some((citation) => citation.match === "nao_encontrado")) return "baixa";
    if (current === "alta" && citations.some((citation) => citation.match === "normalizado")) return "media";
    return current;
}

function pendingReview(): FichaField["review"] {
    return { state: "pendente", by: null, at: null, comment: null };
}

/**
 * Turns the model's answer into envelopes: unknown paths are dropped, every
 * quote is verified, and the schema's invariants are enforced (a value marked
 * found needs a citation; not found has no value).
 */
export function normalizeExtraction(raw: unknown, documentText: string): Ficha {
    const fields = (raw && typeof raw === "object" ? (raw as { fields?: unknown }).fields : null) ?? {};
    const out: Ficha = {};
    for (const [path, entry] of Object.entries(fields as Record<string, unknown>)) {
        if (!PATHS.has(path) || !entry || typeof entry !== "object") continue;
        const item = entry as Record<string, unknown>;
        let status = STATUSES.has(item.status as FieldStatus) ? (item.status as FieldStatus) : "ambiguo";
        const citations: Citation[] = (Array.isArray(item.citations) ? item.citations : [])
            .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && typeof c.quote === "string")
            .slice(0, 4)
            .map((c) => {
                const located = locateQuote(documentText, String(c.quote));
                return {
                    quote: String(c.quote).trim().slice(0, 1_000),
                    clause: typeof c.clause === "string" && c.clause.trim() ? c.clause.trim().slice(0, 60) : null,
                    span: located.span,
                    verified: located.match !== "nao_encontrado",
                    match: located.match,
                };
            });
        let value = item.value ?? null;
        let notes = typeof item.notes === "string" && item.notes.trim() ? item.notes.trim().slice(0, 1_000) : null;
        if (status === "nao_encontrado" || status === "nao_aplicavel") value = null;
        // A value the text "says" with no quote is not a finding: nobody can check it.
        if ((status === "encontrado" || status === "ambiguo") && citations.length === 0) {
            status = "ambiguo";
            notes = notes ?? "Valor sem citação: confira no documento.";
        }
        if ((status === "encontrado" || status === "inferido") && value === null) status = "nao_encontrado";
        const confidence = CONFIDENCES.has(item.confidence as Confidence) ? (item.confidence as Confidence) : "baixa";
        out[path as FichaPath] = {
            status,
            value,
            citations,
            confidence: status === "nao_encontrado" || status === "nao_aplicavel" ? null : lowerConfidence(confidence, citations),
            origin: "ia",
            notes,
            review: pendingReview(),
        };
    }
    for (const field of FICHA_FIELDS) {
        // A field the model skipped is "not extracted", shown as such — never a silent blank.
        out[field.path] ??= {
            status: "nao_encontrado",
            value: null,
            citations: [],
            confidence: null,
            origin: "ia",
            notes: "A extração não retornou este campo.",
            review: pendingReview(),
        };
    }
    return out;
}

function sameValue(a: unknown, b: unknown): boolean {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** A new extraction never overwrites what a person confirmed or corrected. */
export function mergeExtraction(previous: Ficha | null, next: Ficha): Ficha {
    if (!previous) return next;
    const out: Ficha = { ...next };
    for (const [path, old] of Object.entries(previous) as [FichaPath, FichaField][]) {
        if (!old || (old.origin !== "humano" && old.review.state === "pendente")) continue;
        const fresh = next[path];
        out[path] =
            fresh && !sameValue(fresh.value, old.value)
                ? { ...old, ai_value: fresh.value, notes: "A IA leu diferente na nova versão do documento." }
                : old;
    }
    return out;
}

export type FieldDecision =
    | { action: "confirmar"; by: string; comment?: string | null }
    | { action: "corrigir"; by: string; value: unknown; comment?: string | null };

/** Confirming keeps the value; correcting keeps the model's reading in ai_value. */
export function applyFieldDecision(field: FichaField, decision: FieldDecision, at: string): FichaField {
    const review = { state: decision.action === "confirmar" ? "confirmado" : "corrigido", by: decision.by, at, comment: decision.comment ?? null } as const;
    if (decision.action === "confirmar") return { ...field, review };
    return {
        ...field,
        status: decision.value === null ? "nao_encontrado" : field.status === "nao_encontrado" ? "encontrado" : field.status,
        value: decision.value,
        origin: "humano",
        ai_value: field.origin === "ia" ? field.value : field.ai_value,
        review,
    };
}

/** "14/17 verificados": the Ficha's headline number. */
export function fichaProgress(ficha: Ficha | null): { verified: number; total: number } {
    const fields = Object.values(ficha ?? {}).filter((field): field is FichaField => !!field && field.status !== "nao_aplicavel");
    return {
        verified: fields.filter((field) => field.review.state !== "pendente").length,
        total: fields.length,
    };
}

export function isFichaPath(path: unknown): path is FichaPath {
    return typeof path === "string" && PATHS.has(path);
}

export function fieldLabel(path: FichaPath): string {
    return FICHA_FIELDS.find((field) => field.path === path)!.label;
}

// ── corrections typed by a person ────────────────────────────────────────────
const ENUMS: Partial<Record<FichaPath, { key?: string; values: string[] }[]>> = {
    "identificacao.papel_avenia": [{ values: ["contratante", "contratada", "mutuo", "outro"] }],
    "vigencia.prazo": [{ key: "tipo", values: ["determinado", "indeterminado"] }],
    "vigencia.renovacao": [
        { key: "tipo", values: ["automatica", "mediante_aditivo", "opcao_unilateral", "sem_renovacao", "nao_regulada"] },
    ],
    "rescisao.imotivada": [{ key: "permitida_para", values: ["ambas", "somente_avenia", "somente_contraparte", "nenhuma"] }],
    "alteracao_parte.cessao": [
        { key: "regime", values: ["livre", "notificacao", "consentimento_previo", "vedada", "nao_regulada"] },
        { key: "aplica_a", values: ["avenia", "contraparte", "ambas"] },
    ],
    "alteracao_parte.mudanca_controle": [
        { key: "regime", values: ["livre", "notificacao", "consentimento_previo", "vedada", "nao_regulada"] },
        { key: "aplica_a", values: ["avenia", "contraparte", "ambas"] },
    ],
    "dados_pessoais.papel_avenia": [
        { values: ["controlador", "operador", "controlador_conjunto", "suboperador", "nao_definido"] },
    ],
    "dados_pessoais.dpa": [{ values: ["no_corpo", "anexo", "por_referencia", "ausente"] }],
};
const BOOLEAN_FIELDS = new Set<FichaPath>(["dados_pessoais.compartilhamento"]);

/**
 * A corrected value in the shape the rules read, or null when it is not. A
 * correction the rules cannot read would switch them off while the field
 * shows as validated, so it is refused instead.
 */
export function validCorrection(path: FichaPath, value: unknown): boolean {
    if (value === null) return true;
    if (BOOLEAN_FIELDS.has(path)) return typeof value === "boolean";
    const enums = ENUMS[path];
    if (!enums) return value !== undefined && (typeof value !== "object" || !Array.isArray(value));
    for (const { key, values } of enums) {
        const v = key ? (value as Record<string, unknown> | null)?.[key] : value;
        if (key && (typeof value !== "object" || Array.isArray(value))) return false;
        if (!(key && v === undefined) && !values.includes(v as string)) return false;
    }
    return true;
}

/** The field's choices, for the correction form: [key or "", options]. */
export function correctionChoices(path: FichaPath): { key: string; values: string[] }[] | "boolean" | null {
    if (BOOLEAN_FIELDS.has(path)) return "boolean";
    return ENUMS[path]?.map(({ key, values }) => ({ key: key ?? "", values })) ?? null;
}

