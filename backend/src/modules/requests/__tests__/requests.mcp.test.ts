// The MCP tools for requests (doc 09 §4.3), called the way the mcp module
// will: input parsed by its zod shape, preview first for writes, then the
// handler, then summary for the text. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { memoryDb, uuid } from "./memoryDb";

const llm = vi.hoisted(() => ({ completeText: vi.fn() }));
vi.mock("../../../lib/llm", () => llm);
vi.mock("../../user/user.service", () => ({
    getUserModelSettings: vi.fn(async () => ({ tabular_model: "test-model", last_selected_chat_model: null, api_keys: {} })),
}));
vi.mock("../../../lib/dbq/enqueue", () => ({ enqueueDbJob: vi.fn(async () => ({ id: "job", deduped: false })) }));
vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn(async () => undefined) }));

import {
    handleRequestTriage,
    postMessage,
    REQUEST_READ_TOOLS,
    REQUEST_TOOLS,
    REQUEST_WRITE_TOOLS,
} from "../requests.service";
import type { AnyMcpTool, McpContext } from "../../mcp/mcp.service";
import { allowed, runTool } from "../../mcp/mcp.server";
import { readTools } from "../../mcp/mcp.catalog";

const ORG = "11111111-1111-4111-8111-111111111111";
const HEAD = { userId: "aaaaaaaa-0000-4000-8000-000000000001", userEmail: "head@avenia.io" };
const ANALYST = { userId: "aaaaaaaa-0000-4000-8000-000000000002", userEmail: "duda@avenia.io" };
const REQUESTER = { userId: "bbbbbbbb-0000-4000-8000-000000000001", userEmail: "ana@avenia.io" };
const OTHER = { userId: "bbbbbbbb-0000-4000-8000-000000000002", userEmail: "beto@avenia.io" };

function world() {
    let number = 0;
    return memoryDb(
        {
            legal_teams: [{ org_id: ORG, sla_days: {}, auto_assign: false, intake_template: [], created_at: "2026-01-01" }],
            org_members: [
                { org_id: ORG, user_id: HEAD.userId, role: "owner", created_at: "2026-01-01" },
                { org_id: ORG, user_id: ANALYST.userId, role: "member", created_at: "2026-01-02" },
            ],
            user_profiles: [
                { user_id: HEAD.userId, email: "head@avenia.io", display_name: "Marina" },
                { user_id: ANALYST.userId, email: "duda@avenia.io", display_name: "Duda" },
                { user_id: REQUESTER.userId, email: "ana@avenia.io", display_name: "Ana" },
            ],
        },
        {
            defaults: {
                legal_requests: () => {
                    number += 1;
                    const now = new Date().toISOString();
                    return {
                        number,
                        status: "novo",
                        paused_at: null,
                        paused_seconds: 0,
                        assignee_id: null,
                        assigned_at: null,
                        summary: null,
                        triage: null,
                        delivery: null,
                        delivered_at: null,
                        source: { channel: "form" },
                        intake: {},
                        intake_completed_at: null,
                        critical_alert_at: null,
                        idempotency_key: null,
                        created_at: now,
                        updated_at: now,
                    };
                },
                card_events: () => ({ at: new Date().toISOString() }),
                legal_request_notifications: () => ({ status: "pending", attempts: 0, created_at: new Date().toISOString() }),
                legal_request_messages: () => ({ created_at: new Date().toISOString() }),
                legal_request_participants: () => ({ revoked_at: null, created_at: new Date().toISOString() }),
            },
            rpc: {
                create_project_with_memory: (args, tables) => {
                    const row = { id: uuid(), user_id: args.p_user_id, name: args.p_name, org_id: args.p_org_id };
                    (tables.projects ??= []).push(row);
                    return row;
                },
            },
        },
    );
}


const ALL = [...REQUEST_READ_TOOLS, ...REQUEST_WRITE_TOOLS];
const tool = (name: string) => ALL.find((t) => t.name === `mike_pedidos_${name}`) as AnyMcpTool;

function ctxOf(w: ReturnType<typeof world>, who: { userId: string; userEmail: string }, name: string, role: "head" | "team" | "requester"): McpContext {
    return {
        db: w.db,
        caller: who,
        displayName: name,
        role,
        workspace: null,
        scopes: ["pedidos:read", "pedidos:write"],
        clientName: "claude-code",
        tokenId: "token-1",
        actor: {
            actorType: "agent",
            actorId: "mcp:claude-code",
            actorName: `claude-code em nome de ${name}`,
            onBehalfOf: who.userEmail,
            source: "mcp",
        },
    };
}

/** Parse like the server, then run. */
async function call(t: AnyMcpTool, ctx: McpContext, args: Record<string, unknown>) {
    const input = z.object(t.input).parse(args);
    const result = await t.handler(ctx, input);
    return { result, text: result.ok ? t.summary(result.data) : null };
}
async function preview(t: AnyMcpTool, ctx: McpContext, args: Record<string, unknown>) {
    return t.confirm!.preview(ctx, z.object(t.input).parse(args));
}

async function pedido(w: ReturnType<typeof world>, who = REQUESTER, name = "Ana") {
    const { result } = await call(tool("criar"), ctxOf(w, who, name, "requester"), {
        tipo: "nda",
        descricao: "Vamos trocar dados de clientes num piloto.",
        contraparte: "Polaris Tecnologia",
        area: "Comercial",
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    return (result.data as { pedido: { codigo: string } }).pedido.codigo;
}

beforeEach(() => {
    llm.completeText.mockReset();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("the catalog", () => {
    it("hands the catalog reads and writes; only the reads are Phase 1, and every write has a preview", () => {
        expect(REQUEST_TOOLS.filter((t) => t.access === "read").map((t) => t.name)).toEqual([
            "mike_pedidos_listar_meus",
            "mike_pedidos_ler",
            "mike_pedidos_status_e_plano",
            "mike_pedidos_fila",
            "mike_pedidos_checklist",
        ]);
        expect(REQUEST_TOOLS).toHaveLength(11);
        for (const t of REQUEST_READ_TOOLS) {
            expect(t).toMatchObject({ scope: "pedidos:read", access: "read", annotations: { readOnlyHint: true, openWorldHint: false } });
            expect(t.confirm).toBeUndefined();
        }
        expect(REQUEST_WRITE_TOOLS.map((t) => t.name)).toEqual([
            "mike_pedidos_criar",
            "mike_pedidos_responder_checklist",
            "mike_pedidos_responder_duvida",
            "mike_pedidos_assumir",
            "mike_pedidos_mudar_etapa",
            "mike_pedidos_decidir_triagem",
        ]);
        for (const t of REQUEST_WRITE_TOOLS) {
            expect(t).toMatchObject({ scope: "pedidos:write", access: "write", annotations: { readOnlyHint: false } });
            expect(typeof t.confirm?.preview).toBe("function");
        }
        expect(tool("fila").roles).toEqual(["head", "team"]);
        expect(tool("decidir_triagem").roles).toEqual(["head"]);
        expect(tool("listar_meus").roles).toEqual(["head", "team", "requester"]);
    });

    it("takes the seed's fixed ids as attachments (Postgres accepts them; zod's uuid() does not)", () => {
        const input = z.object(tool("criar").input);
        expect(() => input.parse({ tipo: "nda", descricao: "x", anexos: ["00000000-0000-4000-e000-000000000001"] })).not.toThrow();
        expect(() => input.parse({ tipo: "nda", descricao: "x", anexos: ["nao-e-id"] })).toThrow();
    });

    it("never takes who acts as an argument", () => {
        for (const t of ALL) {
            const keys = Object.keys(t.input);
            expect(keys.filter((k) => /user|email|org/i.test(k) && k !== "responsavel_email")).toEqual([]);
        }
    });
});

describe("a requester through an assistant", () => {
    it("asks the Legal in two steps: the preview creates nothing, then the request carries mcp:<client>", async () => {
        const w = world();
        const ctx = ctxOf(w, REQUESTER, "Ana", "requester");
        const args = { tipo: "nda", descricao: "Piloto com dados de clientes.", contraparte: "Polaris Tecnologia", area: "Comercial" };
        const p = await preview(tool("criar"), ctx, args);
        expect(p).toMatchObject({
            ok: true,
            data: { resumo: "Criar o pedido “NDA · Polaris Tecnologia” (NDA) para o Legal, prazo 21/10/2026, área Comercial. Você recebe um e-mail de confirmação." },
        });
        expect(w.table("legal_requests")).toHaveLength(0);

        const { result, text } = await call(tool("criar"), ctx, args);
        expect(result.ok).toBe(true);
        expect(text).toMatch(/^Pedido LEG-0001 criado: NDA · Polaris Tecnologia, prazo 21\/10\/2026\. Acompanhe em .*\/pedidos\//);
        expect(w.table("legal_requests")[0]).toMatchObject({ source: { channel: "mcp", client: "claude-code" }, requester_area: "Comercial" });
        expect(w.table("card_events")[0]).toMatchObject({
            actor_id: "mcp:claude-code",
            actor_name: "claude-code em nome de Ana",
            on_behalf_of: "ana@avenia.io",
            source: "mcp",
            after: { channel: "mcp:claude-code" },
        });
    });

    it("lists, reads and follows only their own requests", async () => {
        const w = world();
        const code = await pedido(w);
        await pedido(w, OTHER, "Beto");
        const ana = ctxOf(w, REQUESTER, "Ana", "requester");

        const mine = await call(tool("listar_meus"), ana, {});
        expect(mine.result).toMatchObject({ ok: true, data: { total: 1, pedidos: [{ codigo: code, etapa: "Novo" }] } });
        expect(mine.text).toBe("1 pedido ao Legal.");

        const read = await call(tool("ler"), ana, { pedido: code });
        expect(read.result).toMatchObject({ ok: true, data: { pedido: { codigo: code, etapa: "Recebido", area: "Comercial" } } });
        expect(read.result.ok && (read.result.data as { pedido: object }).pedido).not.toHaveProperty("triagem");
        expect(read.text).toBe("LEG-0001 · NDA · Polaris Tecnologia: Recebido, prazo 21/10/2026 (no prazo).");

        // Someone else's request reads as not found, by code or by number.
        expect((await call(tool("ler"), ana, { pedido: "LEG-0002" })).result).toMatchObject({ ok: false, kind: "not_found" });
        expect((await call(tool("ler"), ana, { pedido: "2" })).result).toMatchObject({ ok: false, kind: "not_found" });
        expect((await call(tool("ler"), ana, { pedido: "xyz" })).result).toMatchObject({
            ok: false,
            kind: "validation",
            detail: "Informe o código do pedido, como LEG-0042.",
        });
        // And the team's queue is not theirs.
        expect((await call(tool("fila"), ana, {})).result).toMatchObject({ ok: false, kind: "forbidden" });
    });

    it("sees the plan and the Legal's question, and answers it in two steps", async () => {
        const w = world();
        const code = await pedido(w);
        const ana = ctxOf(w, REQUESTER, "Ana", "requester");
        const duda = ctxOf(w, ANALYST, "Duda", "team");
        llm.completeText.mockResolvedValue('{"kind":"nda","counterparty":"Polaris","summary":"x","missing":["CNPJ da contraparte"]}');
        await handleRequestTriage(w.db, { payload: { request_id: w.table("legal_requests")[0].id } });

        // The team asks (through the screen's service, here as Duda).
        await postMessage(w.db, ANALYST, String(w.table("legal_requests")[0].id), { body: "Qual o CNPJ da Polaris?", kind: "question" });

        const status = await call(tool("status_e_plano"), ana, { pedido: code });
        expect(status.result).toMatchObject({
            ok: true,
            data: { aguardando_voce: true, ultima_pergunta: "Qual o CNPJ da Polaris?", situacao_prazo: "pausado até quem pediu responder" },
        });
        expect(status.text).toContain("O Legal perguntou: “Qual o CNPJ da Polaris?”");
        const plano = status.result.ok ? (status.result.data as { plano: { tarefa: string; estado: string }[] }).plano : [];
        expect(plano.find((s) => s.tarefa.startsWith("enviar:"))).toMatchObject({ estado: "aguardando" });

        expect(await preview(tool("responder_duvida"), duda, { pedido: code, resposta: "x" })).toMatchObject({ ok: false, kind: "forbidden" });
        expect(await preview(tool("responder_duvida"), ana, { pedido: code, resposta: "12.345.678/0001-90" })).toMatchObject({
            ok: true,
            data: { resumo: "Responder no LEG-0001: “12.345.678/0001-90”. O prazo do Legal volta a correr." },
        });
        const answered = await call(tool("responder_duvida"), ana, { pedido: code, resposta: "12.345.678/0001-90" });
        expect(answered.result).toMatchObject({ ok: true, data: { pedido: { status: "em_andamento" } } });
        expect(w.table("legal_request_messages").at(-1)).toMatchObject({ kind: "answer", author_id: REQUESTER.userId });
    });
});

describe("the team through an assistant", () => {
    it("reads the queue with filters and counts", async () => {
        const w = world();
        await pedido(w);
        await pedido(w, OTHER, "Beto");
        const duda = ctxOf(w, ANALYST, "Duda", "team");
        const q = await call(tool("fila"), duda, { filtro: "sem_dono" });
        expect(q.result).toMatchObject({ ok: true, data: { total: 2, contagens: { sem_dono: 2, meus: 0 } } });
        expect(q.text).toBe("2 pedidos (sem dono). Sem dono: 2 · prazo estourando: 0 · aguardando quem pediu: 0 · meus: 0.");
        const search = await call(tool("fila"), duda, { busca: "beto" });
        expect(search.result).toMatchObject({ ok: true, data: { total: 1, pedidos: [{ codigo: "LEG-0002", canal: "mcp" }] } });
        expect(() => z.object(tool("fila").input).parse({ limite: 500 })).toThrow();
    });

    it("takes a request, moves its stage and decides the triage, each after a preview", async () => {
        const w = world();
        const code = await pedido(w);
        llm.completeText.mockResolvedValue('{"kind":"revisao","counterparty":"Polaris","summary":"x","missing":[]}');
        await handleRequestTriage(w.db, { payload: { request_id: w.table("legal_requests")[0].id } });
        const duda = ctxOf(w, ANALYST, "Duda", "team");
        const marina = ctxOf(w, HEAD, "Marina", "head");

        expect(await preview(tool("assumir"), duda, { pedido: code })).toMatchObject({
            ok: true,
            data: { resumo: "Assumir o LEG-0001 (“NDA · Polaris Tecnologia”), hoje sem responsável. ana@avenia.io recebe um e-mail." },
        });
        const took = await call(tool("assumir"), duda, { pedido: code });
        expect(took.text).toBe("Agora Duda cuida do LEG-0001.");
        expect(await preview(tool("assumir"), duda, { pedido: code })).toMatchObject({ ok: false, kind: "conflict" });

        expect(await preview(tool("mudar_etapa"), duda, { pedido: code, etapa: "assinatura" })).toMatchObject({
            ok: true,
            data: { resumo: "Mover o LEG-0001 de Triagem para Assinatura." },
        });
        const moved = await call(tool("mudar_etapa"), duda, { pedido: code, etapa: "assinatura" });
        expect(moved.text).toBe("LEG-0001 agora está em Assinatura.");
        expect(() => z.object(tool("mudar_etapa").input).parse({ pedido: code, etapa: "lixo" })).toThrow();

        // Only the Head decides the triage.
        expect(await preview(tool("decidir_triagem"), duda, { pedido: code, decisao: "aceitar" })).toMatchObject({
            ok: false,
            kind: "forbidden",
        });
        expect(await preview(tool("decidir_triagem"), marina, { pedido: code, decisao: "aceitar" })).toMatchObject({
            ok: true,
            data: { resumo: "Aceitar a triagem do LEG-0001: Revisão de contrato, contraparte Polaris, Duda cuida." },
        });
        expect(
            await preview(tool("decidir_triagem"), marina, { pedido: code, decisao: "editar", responsavel_email: "x@fora.com" }),
        ).toMatchObject({ ok: false, kind: "validation", detail: "Essa pessoa não é do time do Legal." });
        const decided = await call(tool("decidir_triagem"), marina, { pedido: code, decisao: "aceitar" });
        expect(decided.result).toMatchObject({ ok: true, data: { pedido: { tipo: "Revisão de contrato" } } });
        expect(await preview(tool("decidir_triagem"), marina, { pedido: code, decisao: "rejeitar" })).toMatchObject({
            ok: false,
            kind: "conflict",
        });

        const events = w.table("card_events").filter((e) => e.actor_id === "mcp:claude-code").map((e) => [e.action, e.on_behalf_of]);
        expect(events).toEqual([
            ["request.created", "ana@avenia.io"],
            ["assignee.changed", "duda@avenia.io"],
            ["lane.changed", "duda@avenia.io"],
            ["triage.accepted", "head@avenia.io"],
        ]);
    });

    it("answers every refusal in Portuguese, without internal ids", async () => {
        const w = world();
        const code = await pedido(w);
        const ana = ctxOf(w, REQUESTER, "Ana", "requester");
        const results = [
            await preview(tool("assumir"), ana, { pedido: code }),
            await preview(tool("mudar_etapa"), ana, { pedido: code, etapa: "revisao" }),
            await preview(tool("decidir_triagem"), ana, { pedido: code, decisao: "aceitar" }),
            await preview(tool("criar"), ana, { tipo: "nda", descricao: " " }),
            (await call(tool("fila"), ana, {})).result,
        ];
        for (const r of results) {
            expect(r.ok).toBe(false);
            const detail = (r as { detail?: string }).detail ?? "";
            expect(detail).toMatch(/[ãçéêíóúõ]|Só|Conte/);
            expect(detail).not.toMatch(/[0-9a-f]{8}-|_id|assignee|lane|request/i);
        }
    });
});

describe("the checklist through an assistant", () => {
    it("shows what is confirmed, inferred and open, and asks only that", async () => {
        const w = world();
        const code = await pedido(w);
        const ana = ctxOf(w, REQUESTER, "Ana", "requester");
        const row = w.table("legal_requests")[0];
        row.intake = {
            contraparte: { value: "Polaris Tecnologia", source: "requester", confirmed: true, updated_at: "x" },
            valor_recorrencia: { value: "R$ 5 mil por mês", source: "inferred", confirmed: false, quote: "R$ 5.000,00 mensais", updated_at: "x" },
        };
        const r = await call(tool("checklist"), ana, { pedido: code });
        expect(r.result).toMatchObject({ ok: true, data: { codigo: code, completo: false, respondidas: 1, total: 9 } });
        if (!r.result.ok) return;
        const out = r.result.data as { itens: { chave: string; estado: string; trecho_do_contrato: string | null; pergunta: string }[] };
        expect(out.itens.find((i) => i.chave === "valor_recorrencia")).toMatchObject({
            estado: "inferido, confirme",
            trecho_do_contrato: "R$ 5.000,00 mensais",
        });
        expect(out.itens.find((i) => i.chave === "confidencial")?.pergunta).toBe(
            "Há compartilhamento de informação confidencial? (sim/não; se sim: Quem compartilha?)",
        );
        expect(r.text).toMatch(/^Checklist do LEG-0001: 1 de 9 confirmadas\. Para confirmar: Valor e recorrência de pagamento\. Falta: Quem aprovou/);
        expect(r.text).not.toMatch(/Falta: .*Valor e recorrência/);
        // A stranger reads "not found", like the request itself.
        expect((await call(tool("checklist"), ctxOf(w, OTHER, "Beto", "requester"), { pedido: code })).result).toMatchObject({
            ok: false,
            kind: "not_found",
        });
    });

    it("answers and confirms in two steps, and closing it is the requester's on the card", async () => {
        const w = world();
        const code = await pedido(w);
        const ana = ctxOf(w, REQUESTER, "Ana", "requester");
        w.table("legal_requests")[0].intake = {
            valor_recorrencia: { value: "R$ 5 mil", source: "inferred", confirmed: false, quote: "R$ 5.000,00", updated_at: "x" },
        };
        expect(await preview(tool("responder_checklist"), ana, { pedido: code })).toMatchObject({ ok: false, kind: "validation" });
        expect(await preview(tool("responder_checklist"), ana, { pedido: code, respostas: { bogus: "x" } })).toMatchObject({
            ok: false,
            detail: "Uma das respostas não corresponde a nenhuma pergunta do checklist.",
        });
        const answers = {
            contraparte: "Polaris Tecnologia",
            aprovacao: "Diretoria",
            empresa_signataria: "Exemplo Pagamentos Ltda.",
            motivo_condicoes: "Piloto de dados.",
            de_acordo: "sim",
            inicio: "01/11/2026",
            confidencial: "sim. As duas partes",
            dados_pessoais: "não",
        };
        const p = await preview(tool("responder_checklist"), ana, { pedido: code, respostas: answers, confirmar: ["valor_recorrencia"] });
        expect(p).toMatchObject({ ok: true });
        expect(p.ok && p.data.resumo).toMatch(/^Gravar no checklist do LEG-0001: Nome da contraparte: Polaris Tecnologia · Quem aprovou/);
        expect(p.ok && p.data.resumo).toContain("Valor e recorrência de pagamento: confirmar como está");
        expect(w.table("legal_requests")[0].intake_completed_at).toBeNull();

        const r = await call(tool("responder_checklist"), ana, { pedido: code, respostas: answers, confirmar: ["valor_recorrencia"] });
        expect(r.text).toBe("Checklist do LEG-0001 completo. O Legal vai analisar o contrato.");
        const saved = w.table("legal_requests")[0].intake as Record<string, { detail?: string; confirmed: boolean }>;
        expect(saved.confidencial).toMatchObject({ detail: "As duas partes", confirmed: true });
        expect(saved.valor_recorrencia.confirmed).toBe(true);
    });

    it("takes checklist answers with a new request", async () => {
        const w = world();
        const { result } = await call(tool("criar"), ctxOf(w, REQUESTER, "Ana", "requester"), {
            tipo: "nda",
            descricao: "Piloto.",
            checklist: { contraparte: "Polaris", confidencial: "sim — só nós" },
        });
        expect(result.ok).toBe(true);
        expect(w.table("legal_requests")[0].intake).toMatchObject({
            contraparte: { value: "Polaris", confirmed: true },
            confidencial: { choice: "sim", detail: "só nós" },
        });
    });
});

describe("through the mcp server", () => {
    it("publishes the four reads next to mike_quem_sou, each to the roles the screen allows", () => {
        const names = readTools().map((t) => t.name);
        expect(names).toEqual(expect.arrayContaining(["mike_quem_sou", ...REQUEST_READ_TOOLS.map((t) => t.name)]));
        expect(names.filter((n) => n.startsWith("mike_pedidos_"))).toHaveLength(5);
        const scopes = ["pedidos:read"] as McpContext["scopes"];
        expect(allowed(tool("fila"), { role: "requester", scopes })).toBe(false);
        expect(allowed(tool("fila"), { role: "team", scopes })).toBe(true);
        expect(allowed(tool("listar_meus"), { role: "requester", scopes: [] })).toBe(false);
    });

    it("runs a read into a Portuguese result and refuses a write until Phase 2", async () => {
        const w = world();
        const code = await pedido(w);
        const ana = ctxOf(w, REQUESTER, "Ana", "requester");
        const read = await runTool(tool("status_e_plano"), ana, { pedido: code });
        expect(read.isError).toBeFalsy();
        expect(read.structuredContent).toMatchObject({ codigo: code, etapa: "Recebido" });
        expect((read.content as { text: string }[])[0].text).toMatch(/^LEG-0001: Recebido/);

        const write = await runTool(tool("criar"), ana, { tipo: "nda", descricao: "Outro piloto." });
        expect(write.isError).toBe(true);
        expect(w.table("legal_requests")).toHaveLength(1);

        const other = await runTool(tool("ler"), ctxOf(w, OTHER, "Beto", "requester"), { pedido: code });
        expect(other.isError).toBe(true);
        expect(other.structuredContent).toMatchObject({ error: { code: "not_found", message: "Pedido não encontrado." } });
    });
});
