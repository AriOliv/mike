// How an organization's Notion board maps onto Mike's cards: which property
// holds which field, and which Notion stage is which lane. Pure functions:
// suggest a map from the board's schema, check one a person edited, and read
// a Notion page into card fields (and back).
//
// Who owns each field when both sides changed (sync rule, doc in the PR):
//   legal  edited by the legal team on Notion: the latest edit wins, either side
//   mike   derived by Mike's agents (risk, renewal, extracted counterparty,
//          type): Mike always wins and writes it back
//   key    identity, never synced as a value (the Mike id and the app link)

export const LANES = ["entrada", "triagem", "revisao", "negociacao", "assinatura", "arquivado"] as const;
export type Lane = (typeof LANES)[number];

export const MIKE_FIELDS = {
    name: { label: "Nome do contrato", types: ["title"], owner: "legal" },
    lane: { label: "Etapa", types: ["select", "status"], owner: "legal" },
    status: { label: "Progresso", types: ["select", "status"], owner: "legal" },
    priority: { label: "Prioridade", types: ["select"], owner: "legal" },
    assignee: { label: "Responsável", types: ["people"], owner: "legal" },
    deadline: { label: "Prazo", types: ["date"], owner: "legal" },
    completed_at: { label: "Data de conclusão", types: ["date"], owner: "legal" },
    requester_name: { label: "Solicitante", types: ["rich_text"], owner: "legal" },
    counterparty: { label: "Contraparte", types: ["rich_text"], owner: "mike" },
    risk_level: { label: "Risco", types: ["select"], owner: "mike" },
    renewal: { label: "Renovação (aviso prévio)", types: ["date"], owner: "mike" },
    contract_type: { label: "Tipo de contrato", types: ["select"], owner: "mike" },
    project_id: { label: "ID no Mike", types: ["rich_text"], owner: "key" },
    app_link: { label: "Abrir no Mike", types: ["url"], owner: "key" },
} as const;
export type MikeField = keyof typeof MIKE_FIELDS;
export type FieldOwner = (typeof MIKE_FIELDS)[MikeField]["owner"];

/** Names a board might use for each field, normalized (no accents, lower case). */
const SYNONYMS: Record<MikeField, string[]> = {
    name: ["contrato", "nome", "name", "titulo"],
    lane: ["etapa", "fase", "stage", "lane"],
    status: ["progresso", "progress", "andamento"],
    priority: ["prioridade", "priority"],
    // "responsavel" before "pessoa": a board that has both keeps the owner in the first.
    assignee: ["responsavel", "dono", "owner", "assignee", "pessoa"],
    deadline: ["prazo", "deadline", "vencimento"],
    completed_at: ["data de conclusao", "conclusao", "concluido em", "completed"],
    requester_name: ["solicitante", "requester", "quem pediu"],
    counterparty: ["contraparte", "counterparty", "parte"],
    risk_level: ["risco", "risk"],
    renewal: ["renovacao", "aviso previo", "renewal"],
    contract_type: ["tipo", "tipo de contrato", "type"],
    project_id: ["projectid", "project id", "id mike", "id no mike"],
    app_link: ["abrir no app", "abrir no mike", "link", "app"],
};

export function normalize(text: string): string {
    return text
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export type BoardProperty = { name: string; type: string; options?: string[] };
export type FieldMap = Partial<Record<string, MikeField>>;
export type StageTarget = { lane: Lane; tag: string | null };
export type StageMap = Record<string, StageTarget>;

/**
 * A field map from the board's properties: each Mike field takes the first
 * property, by synonym order, whose name matches and whose type fits. A
 * property is used once.
 */
export function suggestFieldMap(properties: BoardProperty[]): FieldMap {
    const map: FieldMap = {};
    const used = new Set<string>();
    for (const [field, spec] of Object.entries(MIKE_FIELDS) as [MikeField, (typeof MIKE_FIELDS)[MikeField]][]) {
        for (const synonym of SYNONYMS[field]) {
            const hit = properties.find(
                (p) => !used.has(p.name) && normalize(p.name) === synonym && (spec.types as readonly string[]).includes(p.type),
            );
            if (hit) {
                map[hit.name] = field;
                used.add(hit.name);
                break;
            }
        }
    }
    return map;
}

/** Lanes by what boards call them; anything else lands near and keeps its name as a tag. */
const STAGE_SYNONYMS: Record<string, StageTarget> = {
    entrada: { lane: "entrada", tag: null },
    "not started": { lane: "entrada", tag: null },
    "nao iniciado": { lane: "entrada", tag: null },
    "a fazer": { lane: "entrada", tag: null },
    triagem: { lane: "triagem", tag: null },
    revisao: { lane: "revisao", tag: null },
    "em revisao": { lane: "revisao", tag: null },
    negociacao: { lane: "negociacao", tag: null },
    assinatura: { lane: "assinatura", tag: null },
    arquivado: { lane: "arquivado", tag: null },
    done: { lane: "arquivado", tag: null },
    concluido: { lane: "arquivado", tag: null },
};

/**
 * A stage map from the board's stage options. Known names go to their lane;
 * a stage Mike has no lane for ("Legal Estratégico", "Processos", a backlog)
 * goes to Triagem with its own name as a tag, so nothing is lost and a person
 * can move it later.
 */
export function suggestStageMap(options: string[]): StageMap {
    const map: StageMap = {};
    for (const option of options) {
        const known = STAGE_SYNONYMS[normalize(option)];
        map[option] = known ?? { lane: "triagem", tag: option.trim().slice(0, 60) };
    }
    return map;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; detail: string };

/** A field map a person edited, checked against the board's properties. */
export function parseFieldMap(input: unknown, properties: BoardProperty[]): Parsed<FieldMap> {
    if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, detail: "Envie o mapeamento de campos." };
    const map: FieldMap = {};
    const seen = new Set<MikeField>();
    for (const [property, field] of Object.entries(input as Record<string, unknown>)) {
        if (field === null || field === "") continue;
        const prop = properties.find((p) => p.name === property);
        if (!prop) return { ok: false, detail: `A base não tem a propriedade ${property}.` };
        if (typeof field !== "string" || !(field in MIKE_FIELDS)) return { ok: false, detail: `Campo do Mike desconhecido em ${property}.` };
        const spec = MIKE_FIELDS[field as MikeField];
        if (!(spec.types as readonly string[]).includes(prop.type))
            return { ok: false, detail: `${property} é do tipo ${prop.type} e não serve para ${spec.label}.` };
        if (seen.has(field as MikeField)) return { ok: false, detail: `${spec.label} está ligado a duas propriedades.` };
        seen.add(field as MikeField);
        map[property] = field as MikeField;
    }
    if (!seen.has("name")) return { ok: false, detail: "Escolha a propriedade com o nome do contrato." };
    if (!seen.has("lane")) return { ok: false, detail: "Escolha a propriedade com a etapa." };
    return { ok: true, value: map };
}

/** A stage map a person edited: every option of the stage property, each to a lane. */
export function parseStageMap(input: unknown, options: string[]): Parsed<StageMap> {
    if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, detail: "Envie o mapeamento de etapas." };
    const raw = input as Record<string, unknown>;
    const map: StageMap = {};
    for (const option of options) {
        const target = raw[option] as { lane?: unknown; tag?: unknown } | undefined;
        if (!target || !LANES.includes(target.lane as Lane)) return { ok: false, detail: `Escolha a etapa do Mike para ${option}.` };
        const tag = typeof target.tag === "string" && target.tag.trim() ? target.tag.trim().slice(0, 60) : null;
        map[option] = { lane: target.lane as Lane, tag };
    }
    return { ok: true, value: map };
}

// ── Notion page ⇄ card fields ────────────────────────────────────────────────

export type CardFields = Partial<{
    name: string;
    lane: Lane;
    notion_stage: string | null;
    status: "a_fazer" | "em_andamento" | "bloqueado" | "concluido" | null;
    priority: "baixa" | "media" | "alta" | null;
    /** Notion user ids; resolved to e-mails by the caller. */
    assignee_ids: string[];
    deadline: string | null;
    completed_at: string | null;
    requester_name: string | null;
    counterparty: string | null;
    risk_level: "baixo" | "medio" | "alto" | "critico" | null;
    renewal: string | null;
    contract_type: string | null;
    project_id: string | null;
    app_link: string | null;
}>;

const STATUS_OF: Record<string, CardFields["status"]> = {
    "a fazer": "a_fazer",
    "nao iniciada": "a_fazer",
    "nao iniciado": "a_fazer",
    "em andamento": "em_andamento",
    bloqueado: "bloqueado",
    concluido: "concluido",
    done: "concluido",
};
const PRIORITY_OF: Record<string, CardFields["priority"]> = { baixa: "baixa", media: "media", alta: "alta", low: "baixa", medium: "media", high: "alta" };
const RISK_OF: Record<string, CardFields["risk_level"]> = {
    "risco critico": "critico",
    critico: "critico",
    atencao: "medio",
    ok: "baixo",
    alto: "alto",
    medio: "medio",
    baixo: "baixo",
};

type Prop = { type?: string; [key: string]: unknown };

function plain(rich: unknown): string {
    return Array.isArray(rich) ? rich.map((r) => (r as { plain_text?: string }).plain_text ?? "").join("").trim() : "";
}

function selectName(prop: Prop): string | null {
    const value = (prop.select ?? prop.status) as { name?: string } | null | undefined;
    return value?.name ?? null;
}

function dateStart(prop: Prop): string | null {
    const value = prop.date as { start?: string } | null | undefined;
    return value?.start ? value.start.slice(0, 10) : null;
}

/** The card fields a Notion page carries, by the organization's maps. */
export function readPage(properties: Record<string, Prop>, fieldMap: FieldMap, stageMap: StageMap): CardFields {
    const out: CardFields = {};
    for (const [property, field] of Object.entries(fieldMap)) {
        const prop = properties[property];
        if (!prop || !field) continue;
        switch (field) {
            case "name": {
                const text = plain(prop.title);
                if (text) out.name = text.slice(0, 300);
                break;
            }
            case "lane": {
                const stage = selectName(prop);
                const target = stage ? stageMap[stage] : undefined;
                if (target) {
                    out.lane = target.lane;
                    out.notion_stage = target.tag;
                }
                break;
            }
            case "status": {
                const name = selectName(prop);
                out.status = name ? (STATUS_OF[normalize(name)] ?? null) : null;
                break;
            }
            case "priority": {
                const name = selectName(prop);
                out.priority = name ? (PRIORITY_OF[normalize(name)] ?? null) : null;
                break;
            }
            case "risk_level": {
                const name = selectName(prop);
                out.risk_level = name ? (RISK_OF[normalize(name)] ?? null) : null;
                break;
            }
            case "contract_type":
                out.contract_type = selectName(prop);
                break;
            case "assignee":
                out.assignee_ids = Array.isArray(prop.people) ? (prop.people as { id: string }[]).map((p) => p.id) : [];
                break;
            case "deadline":
            case "completed_at":
            case "renewal":
                out[field] = dateStart(prop);
                break;
            case "requester_name":
            case "counterparty":
            case "project_id":
                out[field] = plain(prop.rich_text) || null;
                break;
            case "app_link":
                out.app_link = typeof prop.url === "string" ? prop.url : null;
                break;
        }
    }
    return out;
}

const STATUS_LABEL: Record<string, string> = { a_fazer: "A fazer", em_andamento: "Em andamento", bloqueado: "Bloqueado", concluido: "Concluído" };
const PRIORITY_LABEL: Record<string, string> = { baixa: "Baixa", media: "Média", alta: "Alta" };
const RISK_LABEL: Record<string, string> = { critico: "Risco crítico", alto: "Risco crítico", medio: "Atenção", baixo: "OK" };

/**
 * Notion properties for a card, by the organization's maps. Only fields in
 * `only` are written (the sync decides which side owns each); the stage is
 * written back as the Notion option it came from when the card still sits in
 * the lane that option maps to, so a "Processos" card stays "Processos".
 */
export function writePage(
    card: CardFields & { assignee_notion_ids?: string[] },
    fieldMap: FieldMap,
    stageMap: StageMap,
    only: ReadonlySet<MikeField>,
    /** Each property's Notion type; a "status" property is written as status, not select. */
    types: Record<string, string> = {},
): Record<string, unknown> {
    const props: Record<string, unknown> = {};
    const date = (value: string | null | undefined) => ({ date: value ? { start: value } : null });
    let current = "";
    const select = (value: string | null | undefined) =>
        types[current] === "status" ? { status: value ? { name: value } : null } : { select: value ? { name: value } : null };
    const text = (value: string | null | undefined) => ({ rich_text: value ? [{ text: { content: value.slice(0, 2000) } }] : [] });
    for (const [property, field] of Object.entries(fieldMap)) {
        if (!field || !only.has(field)) continue;
        current = property;
        switch (field) {
            case "name":
                if (card.name) props[property] = { title: [{ text: { content: card.name.slice(0, 2000) } }] };
                break;
            case "lane": {
                if (!card.lane) break;
                const options = Object.entries(stageMap);
                const sameTag = options.find(([, t]) => t.lane === card.lane && (t.tag ?? null) === (card.notion_stage ?? null));
                const plainLane = options.find(([, t]) => t.lane === card.lane && !t.tag);
                const option = (sameTag ?? plainLane)?.[0];
                if (option) props[property] = select(option);
                break;
            }
            case "status":
                props[property] = select(card.status ? STATUS_LABEL[card.status] : null);
                break;
            case "priority":
                props[property] = select(card.priority ? PRIORITY_LABEL[card.priority] : null);
                break;
            case "risk_level":
                props[property] = select(card.risk_level ? RISK_LABEL[card.risk_level] : null);
                break;
            case "contract_type":
                props[property] = select(card.contract_type);
                break;
            case "assignee":
                props[property] = { people: (card.assignee_notion_ids ?? []).map((id) => ({ id })) };
                break;
            case "deadline":
            case "completed_at":
            case "renewal":
                props[property] = date(card[field]);
                break;
            case "requester_name":
            case "counterparty":
            case "project_id":
                props[property] = text(card[field]);
                break;
            case "app_link":
                props[property] = { url: card.app_link ?? null };
                break;
        }
    }
    return props;
}
