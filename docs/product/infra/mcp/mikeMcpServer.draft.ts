// RASCUNHO — backend/src/mcp-server/index.ts. Não compilado.
//
// MCP server do Mike (streamable HTTP, stateless) em POST /mcp (público:
// https://clm.avenia.tech/api/mcp). Consumido pelo Hermes (docbot) com um token
// de serviço por bot (tabela mcp_service_tokens, só hash). Contrato: doc 04 §3.3.
//
// Registro em app.ts (ANTES do express.json global ou com body próprio):
//   app.post("/mcp", mcpRateLimit, mcpAuth, handleMcp);
//   app.get("/mcp", (_req, res) => res.status(405).end());   // stateless: sem SSE GET
import type { Request, Response, NextFunction } from "express";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createServerSupabase } from "../lib/supabase";

type Scope = "intake:write" | "requests:read:own" | "deadlines:read" | "kb:ask";
type BotPrincipal = { bot: string; orgId: string; scopes: Scope[] };

// Time Legal (leitura ampla via MCP). Vem de env; nunca hard-coded em prod.
const LEGAL_TEAM = new Set(
    (process.env.MIKE_LEGAL_TEAM_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
);
const ALLOWED_DOMAIN = process.env.MIKE_ALLOWED_EMAIL_DOMAIN ?? "avenia.io";

// --- auth: Bearer <token> → principal do bot -------------------------------
export async function mcpAuth(req: Request, res: Response, next: NextFunction) {
    const raw = req.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!raw) return void res.status(401).json({ error: "missing token" });
    const sha = createHash("sha256").update(raw).digest("hex");
    const db = createServerSupabase();
    const { data } = await db
        .from("mcp_service_tokens")
        .select("id, bot, org_id, scopes, expires_at, revoked_at")
        .eq("token_sha256", sha)
        .maybeSingle();
    if (!data || data.revoked_at || new Date(data.expires_at) < new Date()) {
        return void res.status(401).json({ error: "invalid token" });
    }
    void db.from("mcp_service_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
    res.locals.bot = { bot: data.bot, orgId: data.org_id, scopes: data.scopes } satisfies BotPrincipal;
    next();
}

// --- helpers -----------------------------------------------------------------
class ToolError extends Error {
    constructor(
        public code: "forbidden" | "not_found" | "invalid_input" | "too_large" | "rate_limited" | "internal",
        message: string,
    ) {
        super(message);
    }
}

function requireScope(p: BotPrincipal, s: Scope) {
    if (!p.scopes.includes(s)) throw new ToolError("forbidden", `bot ${p.bot} sem escopo ${s}`);
}

function normalizeRequester(email: string): string {
    const e = email.trim().toLowerCase();
    if (!e.endsWith(`@${ALLOWED_DOMAIN}`)) throw new ToolError("forbidden", "solicitante fora do domínio permitido");
    return e;
}

const ok = (summary: string, data: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: summary }],
    structuredContent: data,
});

const fail = (err: unknown) => {
    const e = err instanceof ToolError ? err : new ToolError("internal", "erro interno");
    if (!(err instanceof ToolError)) console.error("[mcp] tool failed", (err as Error)?.message);
    return {
        isError: true,
        content: [{ type: "text" as const, text: e.message }],
        structuredContent: { error: { code: e.code, message: e.message } },
    };
};

const LANE_LABEL: Record<string, string> = {
    entrada: "Entrada", triagem: "Triagem", revisao: "Revisão",
    negociacao: "Negociação", assinatura: "Assinatura", arquivado: "Arquivado",
};

// --- schemas (contrato §3.3) -------------------------------------------------
const FileInput = z
    .object({
        filename: z.string().min(1).max(200),
        mime: z.string().max(100),
        content_base64: z.string().max(20_000_000).optional(), // ~15 MB decodificado
        drive_file_id: z.string().max(200).optional(),
    })
    .refine((f) => !!f.content_base64 !== !!f.drive_file_id, "envie content_base64 OU drive_file_id");

const Source = z.object({
    channel: z.enum(["slack", "whatsapp"]),
    channel_id: z.string().max(100),
    thread_ts: z.string().max(50).optional(),
    permalink: z.string().url().max(500).optional(),
});

// --- server --------------------------------------------------------------------
function buildServer(p: BotPrincipal) {
    const server = new McpServer({ name: "mike-clm", version: "1.0.0" });

    server.registerTool(
        "mike_request_analysis",
        {
            title: "Pedir análise de contrato ao Legal",
            description:
                "Abre um pedido de análise de contrato na esteira do Legal (card em Entrada). " +
                "Use quando alguém pedir revisão/análise de um contrato. Idempotente por idempotency_key.",
            inputSchema: {
                title: z.string().min(3).max(200),
                description: z.string().min(3).max(4000),
                requester_email: z.string().email(),
                counterparty: z.string().max(200).optional(),
                contract_type_hint: z.string().max(80).optional(),
                urgency: z.enum(["baixa", "media", "alta"]).default("media"),
                needed_by: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
                files: z.array(FileInput).max(3).optional(),
                source: Source,
                idempotency_key: z.string().min(8).max(200),
            },
        },
        async (args) => {
            try {
                requireScope(p, "intake:write");
                const requester = normalizeRequester(args.requester_email);
                // TODO(impl): createIntakeCard() — numa transação:
                //   1. select por intake_idempotency_key → se existe, devolve deduplicated
                //   2. insert projects (lane='entrada', status='a_fazer', requester_email,
                //      intake_source, priority = sugestão a partir de urgency? NÃO: só sugere
                //      no card; priority é campo de gestão do Legal)
                //   3. upload dos arquivos (storage) → documents/document_versions
                //   4. card_events request.created (actor 'hermes:<bot>', on_behalf_of)
                //   → TRIGGERS enfileira o Intake
                const card = await createIntakeCard({ ...args, requester_email: requester }, p);
                return ok(
                    card.deduplicated
                        ? `Esse pedido já existe: ${card.card_url}`
                        : `Pedido recebido e registrado em Entrada: ${card.card_url}`,
                    card,
                );
            } catch (err) {
                return fail(err);
            }
        },
    );

    server.registerTool(
        "mike_get_request_status",
        {
            title: "Status de um pedido ao Legal",
            description: "Mostra em que etapa da esteira está um pedido e qual o próximo passo.",
            inputSchema: {
                requester_email: z.string().email(),
                request_id: z.string().uuid().optional(),
                source_permalink: z.string().url().optional(),
                idempotency_key: z.string().optional(),
            },
        },
        async (args) => {
            try {
                requireScope(p, "requests:read:own");
                const requester = normalizeRequester(args.requester_email);
                const card = await findCardForRequester(args, requester, p);
                if (!card) throw new ToolError("not_found", "não encontrei esse pedido para esse solicitante");
                return ok(
                    `${card.title}: ${LANE_LABEL[card.lane] ?? card.lane} · ${card.progresso}. Próximo passo: ${card.next_step}`,
                    { ...card, lane_label: LANE_LABEL[card.lane] ?? card.lane },
                );
            } catch (err) {
                return fail(err);
            }
        },
    );

    server.registerTool(
        "mike_list_my_requests",
        {
            title: "Meus pedidos ao Legal",
            description: "Lista os pedidos de análise abertos por esta pessoa.",
            inputSchema: {
                requester_email: z.string().email(),
                include_archived: z.boolean().default(false),
                limit: z.number().int().min(1).max(20).default(10),
            },
        },
        async (args) => {
            try {
                requireScope(p, "requests:read:own");
                const items = await listCardsForRequester(normalizeRequester(args.requester_email), args, p);
                return ok(`${items.length} pedido(s).`, { items });
            } catch (err) {
                return fail(err);
            }
        },
    );

    server.registerTool(
        "mike_add_request_info",
        {
            title: "Complementar um pedido",
            description: "Adiciona mensagem e/ou arquivos a um pedido existente (ex.: anexo que faltava).",
            inputSchema: {
                requester_email: z.string().email(),
                request_id: z.string().uuid(),
                message: z.string().min(1).max(4000),
                files: z.array(FileInput).max(3).optional(),
            },
        },
        async (args) => {
            try {
                requireScope(p, "intake:write");
                const r = await addRequestInfo(normalizeRequester(args.requester_email), args, p);
                return ok("Informação adicionada ao pedido.", r);
            } catch (err) {
                return fail(err);
            }
        },
    );

    server.registerTool(
        "mike_ask_knowledge_base",
        {
            title: "Perguntar à base de contratos",
            description:
                "Responde perguntas sobre os contratos da empresa, sempre com citação da cláusula. " +
                "Não substitui parecer do Legal.",
            inputSchema: {
                question: z.string().min(5).max(1000),
                requester_email: z.string().email(),
                filters: z
                    .object({
                        counterparty: z.string().max(200).optional(),
                        contract_type: z.string().max(80).optional(),
                        active_only: z.boolean().default(true),
                        signed_after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
                    })
                    .optional(),
            },
        },
        async (args) => {
            try {
                requireScope(p, "kb:ask");
                const requester = normalizeRequester(args.requester_email);
                // Filtro de acesso ANTES do ranking: só contratos que esse e-mail pode ver
                // (time Legal vê tudo da org; demais, só os seus/compartilhados).
                const r = await askKnowledgeBase(args.question, requester, LEGAL_TEAM.has(requester), args.filters, p);
                return ok(`${r.answer}\n\n(Não substitui parecer do Legal.)`, r);
            } catch (err) {
                return fail(err);
            }
        },
    );

    server.registerTool(
        "mike_upcoming_deadlines",
        {
            title: "Próximos prazos contratuais",
            description: "Lista prazos (renovação, aviso prévio, obrigações) dos próximos N dias.",
            inputSchema: {
                requester_email: z.string().email(),
                days_ahead: z.number().int().min(1).max(180).default(30),
                counterparty: z.string().max(200).optional(),
                mark: z.enum(["recorrente", "critico", "tarefa"]).optional(),
            },
        },
        async (args) => {
            try {
                requireScope(p, "deadlines:read");
                const requester = normalizeRequester(args.requester_email);
                if (!LEGAL_TEAM.has(requester)) throw new ToolError("forbidden", "prazos da base são só para o time Legal");
                const items = await upcomingDeadlines(args, p);
                return ok(`${items.length} prazo(s) nos próximos ${args.days_ahead} dias.`, { items });
            } catch (err) {
                return fail(err);
            }
        },
    );

    return server;
}

// Stateless: um server + transport por request (barato; sem sessão para vazar).
export async function handleMcp(req: Request, res: Response) {
    const principal = res.locals.bot as BotPrincipal;
    const server = buildServer(principal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
        void transport.close();
        void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
}

// --- implementações (fora do rascunho; ver doc 04 §3.3) -------------------------
declare function createIntakeCard(a: unknown, p: BotPrincipal): Promise<{
    request_id: string; card_url: string; lane: "entrada"; status: "a_fazer"; deduplicated: boolean; missing: string[];
}>;
declare function findCardForRequester(a: unknown, requester: string, p: BotPrincipal): Promise<{
    request_id: string; title: string; lane: string; progresso: string; next_step: string; card_url: string;
} | null>;
declare function listCardsForRequester(requester: string, a: unknown, p: BotPrincipal): Promise<unknown[]>;
declare function addRequestInfo(requester: string, a: unknown, p: BotPrincipal): Promise<{ ok: true; event_id: number }>;
declare function askKnowledgeBase(q: string, requester: string, isLegal: boolean, f: unknown, p: BotPrincipal): Promise<{
    answer: string; citations: unknown[]; confidence: "alta" | "media" | "baixa"; not_found: boolean;
}>;
declare function upcomingDeadlines(a: unknown, p: BotPrincipal): Promise<unknown[]>;
