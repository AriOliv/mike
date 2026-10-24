// The requests module's MCP tools (doc 09 §4.3): an assistant asks the
// legal team and follows up for a person, and the team works its queue,
// through the same service functions and role checks as the screens.
//
// Reads (Phase 1): mike_pedidos_listar_meus, _ler, _status_e_plano, _fila,
// _checklist.
// Writes (Phase 2, two steps: `confirm.preview` changes nothing and the mcp
// module asks for the person's ok before `handler` runs): _criar,
// _responder_checklist, _responder_duvida, _assumir, _mudar_etapa,
// _decidir_triagem.
//
// Every write goes out with `ctx.actor` on the caller, so the card's
// activity reads "<cliente> em nome de <Nome>", and a request created here
// records its channel as mcp:<client>.

import { z } from "zod";
import { failure, ok, type ServiceResult } from "../../lib/serviceResult";
import { defineTool, uuidId, type AnyMcpTool, type McpContext, type McpToolAnnotations } from "../mcp/mcp.service";
import type { Caller } from "./requests.access";
import {
    assignRequest,
    createRequest,
    decideTriage,
    getRequest,
    getRequestPlan,
    listRequests,
    moveRequestStage,
    postMessage,
    previewCreateRequest,
    resolveRequestRef,
    type RequestListItem,
    type RequestPublicView,
    type RequestTeamView,
} from "./requests.core";
import { requestLink } from "./requests.notifications";
import { answerIntake, getIntake, type RequestIntake } from "./requests.checklist";
import {
    KIND_LABELS,
    LANE_LABELS,
    PIPELINE_LANES,
    REQUEST_KINDS,
    REQUESTER_AREAS,
    URGENCIES,
    type PlanStep,
} from "./requests.shared";


const EVERYONE = ["head", "team", "requester"] as const;
const TEAM = ["head", "team"] as const;

const READ: McpToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE: McpToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const STATUS_LABELS: Record<string, string> = {
    novo: "Novo",
    em_triagem: "Em triagem",
    em_andamento: "Em andamento",
    aguardando_solicitante: "Aguardando quem pediu",
    entregue: "Entregue",
    cancelado: "Cancelado",
};
const STEP_LABELS: Record<string, string> = {
    recebido: "Recebido",
    em_analise: "Em análise",
    assinatura: "Assinatura",
    concluido: "Concluído",
};
const SLA_LABELS: Record<string, string> = {
    no_prazo: "no prazo",
    estourando: "vence em menos de 1 dia",
    estourado: "atrasado",
    pausado: "pausado até quem pediu responder",
    encerrado: "encerrado",
};

const pedidoRef = z
    .string()
    .min(1)
    .max(64)
    .describe('O código do pedido, como "LEG-0042" (ou só 42).');

/** The person, with the client acting for them on every event. */
function callerOf(ctx: McpContext): Caller {
    return { userId: ctx.caller.userId, userEmail: ctx.caller.userEmail, actor: ctx.actor };
}

function date(iso: string | null | undefined): string | null {
    return iso ? new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : null;
}

async function idOf(ctx: McpContext, ref: string): Promise<ServiceResult<string>> {
    return resolveRequestRef(ctx.db, ref);
}

type PedidoResumo = {
    codigo: string;
    titulo: string;
    tipo: string;
    contraparte: string | null;
    etapa: string;
    status: string;
    prazo: string;
    situacao_prazo: string;
    quem_cuida: string | null;
    aguardando_voce: boolean;
    link: string;
};

function resumoDaLista(item: RequestListItem): PedidoResumo {
    return {
        codigo: item.code,
        titulo: item.title,
        tipo: item.kind_label,
        contraparte: item.counterparty,
        etapa: STATUS_LABELS[item.status] ?? item.status,
        status: item.status,
        prazo: date(item.due_at) ?? "",
        situacao_prazo: SLA_LABELS[item.sla] ?? item.sla,
        quem_cuida: item.assignee_name,
        aguardando_voce: item.status === "aguardando_solicitante",
        link: requestLink(item.id),
    };
}

type PedidoCompleto = {
    codigo: string;
    titulo: string;
    tipo: string;
    contraparte: string | null;
    etapa: string;
    status: string;
    prazo: string | null;
    situacao_prazo: string;
    quem_cuida: string | null;
    quem_pediu: string;
    area: string | null;
    pedido_original: string;
    como_o_legal_entendeu: string | null;
    aguardando_voce: boolean;
    conversa: { de: string; tipo: "pergunta" | "resposta" | "recado"; texto: string; em: string }[];
    entrega: { mensagem: string | null; em: string | null; documentos: string[] } | null;
    link: string;
    /** Only for the team. */
    etapa_na_esteira?: string | null;
    triagem?: Record<string, unknown> | null;
};

function completo(view: RequestPublicView | RequestTeamView): PedidoCompleto {
    const team = view.audience === "team" ? (view as RequestTeamView) : null;
    return {
        codigo: view.code,
        titulo: view.title,
        tipo: view.kind_label,
        contraparte: view.counterparty,
        etapa: team ? (STATUS_LABELS[view.status] ?? view.status) : (STEP_LABELS[view.step] ?? view.step),
        status: view.status,
        prazo: view.status === "entregue" || view.status === "cancelado" ? null : date(view.due_at),
        situacao_prazo: SLA_LABELS[view.sla] ?? view.sla,
        quem_cuida: view.assignee_name,
        quem_pediu: view.requester_name ?? view.requester_email,
        area: view.requester_area,
        pedido_original: view.context,
        como_o_legal_entendeu: view.summary,
        aguardando_voce: view.audience !== "team" && view.status === "aguardando_solicitante",
        conversa: view.messages.map((m) => ({
            de: m.author_name || m.author_email,
            tipo: m.kind === "question" ? "pergunta" : m.kind === "answer" ? "resposta" : "recado",
            texto: m.body,
            em: m.created_at,
        })),
        entrega: view.delivery
            ? {
                  mensagem: view.delivery.message,
                  em: date(view.delivery.delivered_at),
                  documentos: view.delivery.documents.map((d) => d.filename),
              }
            : null,
        link: requestLink(view.id),
        ...(team
            ? { etapa_na_esteira: team.lane ? (LANE_LABELS[team.lane] ?? team.lane) : null, triagem: team.triage }
            : {}),
    };
}

const PLAN_STATE: Record<PlanStep["state"], string> = {
    feito: "feito",
    rodando: "em andamento",
    a_fazer: "a fazer",
    aguardando: "aguardando",
};

function planoPt(plan: PlanStep[]) {
    return plan.map((s, i) => ({
        passo: i + 1,
        quem: s.owner.kind === "agent" ? `${s.owner.name} (agente)` : s.owner.name,
        tarefa: s.task,
        estado: PLAN_STATE[s.state],
        ...(s.asksFirst ? { pede_ok_antes: true } : {}),
    }));
}

// --- Reads ------------------------------------------------------------------

const listarMeus = defineTool({
    name: "mike_pedidos_listar_meus",
    title: "Meus pedidos ao Legal",
    description:
        "Lista os pedidos que a pessoa fez ao Legal (ou para os quais foi convidada), com etapa, prazo e quem cuida. " +
        "Use para responder 'como está meu pedido?'.",
    input: { abertos: z.boolean().optional().describe("Só os que ainda não foram entregues ou cancelados.") },
    scope: "pedidos:read",
    roles: EVERYONE,
    access: "read",
    annotations: READ,
    async handler(ctx, input) {
        const list = await listRequests(ctx.db, callerOf(ctx), { mine: true });
        if (!list.ok) return list;
        const items = list.data.items.filter(
            (i) => !input.abertos || (i.status !== "entregue" && i.status !== "cancelado"),
        );
        return ok({ pedidos: items.map(resumoDaLista), total: items.length });
    },
    summary(out) {
        if (out.total === 0) return "Nenhum pedido ao Legal.";
        const waiting = out.pedidos.filter((p) => p.aguardando_voce).length;
        return (
            `${out.total} pedido${out.total === 1 ? "" : "s"} ao Legal` +
            (waiting ? `; ${waiting} esperando resposta sua.` : ".")
        );
    },
});

const ler = defineTool({
    name: "mike_pedidos_ler",
    title: "Ler um pedido",
    description:
        "Um pedido ao Legal por inteiro: o que foi pedido, como o Legal entendeu, quem cuida, prazo, a conversa e a entrega. " +
        "Quem pediu vê o recorte dele; o time vê também a triagem.",
    input: { pedido: pedidoRef },
    scope: "pedidos:read",
    roles: EVERYONE,
    access: "read",
    annotations: READ,
    async handler(ctx, input) {
        const id = await idOf(ctx, input.pedido);
        if (!id.ok) return id;
        const view = await getRequest(ctx.db, callerOf(ctx), id.data);
        if (!view.ok) return view;
        return ok({ pedido: completo(view.data) });
    },
    summary({ pedido: p }) {
        return (
            `${p.codigo} · ${p.titulo}: ${p.etapa}` +
            (p.quem_cuida ? `, com ${p.quem_cuida}` : "") +
            (p.prazo ? `, prazo ${p.prazo} (${p.situacao_prazo})` : "") +
            (p.aguardando_voce ? ". O Legal espera uma resposta sua." : ".")
        );
    },
});

type StatusEPlano = {
    codigo: string;
    titulo: string;
    etapa: string;
    prazo: string | null;
    situacao_prazo: string;
    quem_cuida: string | null;
    aguardando_voce: boolean;
    ultima_pergunta: string | null;
    plano: ReturnType<typeof planoPt>;
    link: string;
};

const statusEPlano = defineTool({
    name: "mike_pedidos_status_e_plano",
    title: "Status e plano de um pedido",
    description:
        "Onde o pedido está e o que vem a seguir: cada passo, de agente ou de pessoa, com o estado (feito, em andamento, a fazer, aguardando). " +
        "Diz também se o Legal está esperando uma resposta de quem pediu.",
    input: { pedido: pedidoRef },
    scope: "pedidos:read",
    roles: EVERYONE,
    access: "read",
    annotations: READ,
    async handler(ctx, input): Promise<ServiceResult<StatusEPlano>> {
        const id = await idOf(ctx, input.pedido);
        if (!id.ok) return id;
        const result = await getRequestPlan(ctx.db, callerOf(ctx), id.data);
        if (!result.ok) return result;
        const p = completo(result.data.request);
        const lastQuestion = [...result.data.request.messages].reverse().find((m) => m.kind === "question");
        return ok({
            codigo: p.codigo,
            titulo: p.titulo,
            etapa: p.etapa,
            prazo: p.prazo,
            situacao_prazo: p.situacao_prazo,
            quem_cuida: p.quem_cuida,
            aguardando_voce: p.aguardando_voce,
            ultima_pergunta: result.data.request.status === "aguardando_solicitante" ? (lastQuestion?.body ?? null) : null,
            plano: planoPt(result.data.plan),
            link: p.link,
        });
    },
    summary(out) {
        const next = out.plano.find((s) => s.estado !== "feito");
        return (
            `${out.codigo}: ${out.etapa}` +
            (out.prazo ? `, prazo ${out.prazo} (${out.situacao_prazo})` : "") +
            (next ? `. Próximo passo: ${next.quem}, ${next.tarefa}.` : ". Todos os passos feitos.") +
            (out.ultima_pergunta ? ` O Legal perguntou: “${out.ultima_pergunta}”` : "")
        );
    },
});

const FILTROS = ["abertos", "sem_dono", "prazo_estourando", "aguardando_solicitante", "meus", "triagem_pendente", "todos"] as const;

type Fila = {
    filtro: (typeof FILTROS)[number];
    pedidos: (PedidoResumo & {
        quem_pediu: string;
        area: string | null;
        canal: string;
        sugestao_do_agente: string | null;
        triagem_pendente: boolean;
    })[];
    total: number;
    contagens: { sem_dono: number; prazo_estourando: number; aguardando_solicitante: number; meus: number };
};

const fila = defineTool({
    name: "mike_pedidos_fila",
    title: "Fila de pedidos do Legal",
    description:
        "A fila do time do Legal, como na tela Pedidos: abertos primeiro, pelo prazo. Filtros: sem dono, prazo estourando, " +
        "aguardando quem pediu, meus, triagem pendente. Só para o time.",
    input: {
        filtro: z.enum(FILTROS).optional().describe("Padrão: abertos."),
        busca: z.string().max(200).optional().describe("Procura no código, título, contraparte, quem pediu e área."),
        limite: z.number().int().min(1).max(50).optional().describe("Até 50; padrão 20."),
    },
    scope: "pedidos:read",
    roles: TEAM,
    access: "read",
    annotations: READ,
    async handler(ctx, input): Promise<ServiceResult<Fila>> {
        const list = await listRequests(ctx.db, callerOf(ctx));
        if (!list.ok) return list;
        if (list.data.scope !== "team") return failure("forbidden", "A fila é só do time do Legal.");
        const filtro = input.filtro ?? "abertos";
        const open = (i: RequestListItem) => i.status !== "entregue" && i.status !== "cancelado";
        const keep: Record<(typeof FILTROS)[number], (i: RequestListItem) => boolean> = {
            abertos: open,
            sem_dono: (i) => open(i) && !i.assignee_id,
            prazo_estourando: (i) => open(i) && (i.sla === "estourando" || i.sla === "estourado"),
            aguardando_solicitante: (i) => i.status === "aguardando_solicitante",
            meus: (i) => open(i) && i.assignee_id === ctx.caller.userId,
            triagem_pendente: (i) => i.triage_pending,
            todos: () => true,
        };
        const q = input.busca?.trim().toLowerCase();
        const rows = list.data.items
            .filter(keep[filtro])
            .filter(
                (i) =>
                    !q ||
                    [i.code, i.title, i.counterparty, i.requester_name, i.requester_email, i.requester_area]
                        .filter(Boolean)
                        .some((v) => String(v).toLowerCase().includes(q)),
            )
            .sort((a, b) => {
                const ao = open(a) ? 0 : 1;
                const bo = open(b) ? 0 : 1;
                if (ao !== bo) return ao - bo;
                return Date.parse(a.due_at) - Date.parse(b.due_at);
            });
        const c = list.data.counts;
        return ok({
            filtro,
            pedidos: rows.slice(0, input.limite ?? 20).map((i) => ({
                ...resumoDaLista(i),
                aguardando_voce: false,
                quem_pediu: i.requester_name ?? i.requester_email,
                area: i.requester_area,
                canal: i.channel,
                sugestao_do_agente: i.suggested_assignee_name,
                triagem_pendente: i.triage_pending,
            })),
            total: rows.length,
            contagens: {
                sem_dono: c.sem_dono,
                prazo_estourando: c.sla_estourando,
                aguardando_solicitante: c.aguardando_solicitante,
                meus: c.meus,
            },
        });
    },
    summary(out) {
        const c = out.contagens;
        return (
            `${out.total} pedido${out.total === 1 ? "" : "s"} (${out.filtro.replace(/_/g, " ")}). ` +
            `Sem dono: ${c.sem_dono} · prazo estourando: ${c.prazo_estourando} · ` +
            `aguardando quem pediu: ${c.aguardando_solicitante} · meus: ${c.meus}.`
        );
    },
});

// --- Writes (Phase 2) ---------------------------------------------------------

const criarInput = {
    tipo: z.enum(REQUEST_KINDS).describe("nda, contrato_novo, revisao, aditivo, parecer ou outro."),
    descricao: z.string().min(1).max(8000).describe("O que a pessoa precisa, nas palavras dela."),
    contraparte: z.string().max(200).optional(),
    titulo: z.string().max(200).optional().describe("Opcional: sem título, vira '<tipo> · <contraparte>'."),
    area: z.enum(REQUESTER_AREAS).optional().describe("A área de quem pede. Sem ela, vale a última que a pessoa usou."),
    urgencia: z.enum(URGENCIES).optional(),
    precisa_ate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("AAAA-MM-DD, se a pessoa precisa antes do prazo do Legal."),
    anexos: z
        .array(uuidId())
        .max(5)
        .optional()
        .describe("Ids de documentos que a própria pessoa já subiu no Mike."),
    chave_idempotencia: z
        .string()
        .max(200)
        .optional()
        .describe("Repetir a mesma chave devolve o pedido já criado, sem duplicar."),
    checklist: z
        .record(z.string(), z.string().max(2000))
        .optional()
        .describe(
            "Respostas do checklist que a pessoa já deu, por chave (veja mike_pedidos_checklist). Sim/não: \"sim\" ou \"não\", com o detalhe depois de um ponto.",
        ),
};

function createInput(ctx: McpContext, input: z.infer<z.ZodObject<typeof criarInput>>) {
    return {
        kind: input.tipo,
        context: input.descricao,
        counterparty: input.contraparte,
        title: input.titulo,
        requester_area: input.area,
        urgency: input.urgencia,
        needed_by: input.precisa_ate,
        document_ids: input.anexos,
        idempotency_key: input.chave_idempotencia,
        intake: input.checklist ? checklistAnswers(input.checklist) : undefined,
        source: { channel: "mcp", client: ctx.clientName },
    };
}

/** "sim. As duas partes" → the choice "sim" with the detail after it; anything else as given. */
function checklistAnswers(given: Record<string, string>): Record<string, { value: string; detail?: string }> {
    const out: Record<string, { value: string; detail?: string }> = {};
    for (const [key, raw] of Object.entries(given)) {
        const m = /^\s*(sim|n[aã]o)\s*[.,;:—-]\s*(.+)$/i.exec(raw);
        out[key] = m ? { value: m[1], detail: m[2].trim() } : { value: raw };
    }
    return out;
}

type ChecklistPt = {
    codigo: string;
    completo: boolean;
    respondidas: number;
    total: number;
    itens: {
        chave: string;
        pergunta: string;
        obrigatoria: boolean;
        estado: "confirmado" | "inferido, confirme" | "pendente";
        resposta: string | null;
        trecho_do_contrato: string | null;
        dica?: string;
    }[];
    pendentes: string[];
    para_confirmar: string[];
};

function checklistPt(code: string, c: RequestIntake): ChecklistPt {
    const label = new Map(c.items.map((i) => [i.key, i.label]));
    return {
        codigo: code,
        completo: c.complete,
        respondidas: c.answered,
        total: c.total,
        itens: c.items.map((i) => ({
            chave: i.key,
            pergunta: i.label + (i.kind === "yes_no" && i.detail_label ? ` (sim/não; se sim: ${i.detail_label})` : ""),
            obrigatoria: i.required,
            estado: i.state === "inferido" ? "inferido, confirme" : i.state,
            resposta: i.answer?.value ?? null,
            trecho_do_contrato: i.answer?.quote ?? null,
            ...(i.hint ? { dica: i.hint } : {}),
        })),
        pendentes: c.pending.map((k) => label.get(k) ?? k),
        para_confirmar: c.to_confirm.map((k) => label.get(k) ?? k),
    };
}

async function codeOf(ctx: McpContext, id: string): Promise<string> {
    const view = await getRequest(ctx.db, callerOf(ctx), id);
    return view.ok ? view.data.code : "";
}

const criar = defineTool({
    name: "mike_pedidos_criar",
    title: "Pedir ao Legal",
    description:
        "Abre um pedido ao Legal em nome da pessoa (como o formulário 'Pedir ao Legal'): ganha código LEG, prazo e uma triagem do agente. " +
        "Pede confirmação antes de criar.",
    input: criarInput,
    scope: "pedidos:write",
    roles: EVERYONE,
    access: "write",
    annotations: WRITE,
    confirm: {
        async preview(ctx, input) {
            const p = await previewCreateRequest(ctx.db, callerOf(ctx), createInput(ctx, input));
            if (!p.ok) return p;
            const d = p.data;
            return ok({
                resumo:
                    `Criar o pedido “${d.title}” (${d.kind_label}) para o Legal, prazo ${date(d.due_at)}` +
                    (d.area ? `, área ${d.area}` : ", sem área") +
                    (d.attachments ? `, ${d.attachments} anexo${d.attachments === 1 ? "" : "s"}` : "") +
                    ". Você recebe um e-mail de confirmação.",
                detalhes: d,
            });
        },
    },
    async handler(ctx, input) {
        const created = await createRequest(ctx.db, callerOf(ctx), createInput(ctx, input));
        if (!created.ok) return created;
        return ok({ pedido: completo(created.data.request), ja_existia: created.data.deduplicated });
    },
    summary({ pedido: p, ja_existia }) {
        return ja_existia
            ? `Esse pedido já existia: ${p.codigo} · ${p.titulo}.`
            : `Pedido ${p.codigo} criado: ${p.titulo}, prazo ${p.prazo}. Acompanhe em ${p.link}`;
    },
});

const checklist = defineTool({
    name: "mike_pedidos_checklist",
    title: "Checklist de um pedido",
    description:
        "O que o Legal precisa saber antes de analisar o contrato: cada pergunta, a resposta, e o estado — confirmada, " +
        "lida no contrato pelo agente (\"inferido, confirme\", com o trecho) ou pendente. Pergunte à pessoa só o que está pendente " +
        "ou para confirmar, nunca o que já está confirmado.",
    input: { pedido: pedidoRef },
    scope: "pedidos:read",
    roles: EVERYONE,
    access: "read",
    annotations: READ,
    async handler(ctx, input): Promise<ServiceResult<ChecklistPt>> {
        const id = await idOf(ctx, input.pedido);
        if (!id.ok) return id;
        const c = await getIntake(ctx.db, callerOf(ctx), id.data);
        if (!c.ok) return c;
        return ok(checklistPt(await codeOf(ctx, id.data), c.data));
    },
    summary(out: ChecklistPt) {
        if (out.completo) return `Checklist do ${out.codigo} completo (${out.respondidas} de ${out.total}).`;
        const missing = out.pendentes.filter((p) => !out.para_confirmar.includes(p));
        return (
            `Checklist do ${out.codigo}: ${out.respondidas} de ${out.total} confirmadas.` +
            (out.para_confirmar.length ? ` Para confirmar: ${out.para_confirmar.join("; ")}.` : "") +
            (missing.length ? ` Falta: ${missing.join("; ")}.` : "")
        );
    },
});

const responderChecklistInput = {
    pedido: pedidoRef,
    respostas: z
        .record(z.string(), z.string().min(1).max(2000))
        .optional()
        .describe("Respostas por chave. Sim/não: \"sim\" ou \"não\", com o detalhe depois de um ponto (\"sim. As duas partes\")."),
    confirmar: z
        .array(z.string().max(40))
        .max(20)
        .optional()
        .describe("Chaves de respostas lidas no contrato que a pessoa confirma como estão."),
};

const responderChecklist = defineTool({
    name: "mike_pedidos_responder_checklist",
    title: "Responder o checklist de um pedido",
    description:
        "Grava as respostas da pessoa no checklist e confirma as que o agente leu no contrato. Quando a última pendência fecha, " +
        "o Legal começa a análise do contrato. Pede confirmação antes de gravar.",
    input: responderChecklistInput,
    scope: "pedidos:write",
    roles: EVERYONE,
    access: "write",
    annotations: { ...WRITE, idempotentHint: true },
    confirm: {
        async preview(ctx, input) {
            const id = await idOf(ctx, input.pedido);
            if (!id.ok) return id;
            const c = await getIntake(ctx.db, callerOf(ctx), id.data);
            if (!c.ok) return c;
            if (!c.data.can_answer) return failure("forbidden", "O checklist do pedido é de quem pediu e do time do Legal.");
            const byKey = new Map(c.data.items.map((i) => [i.key, i.label]));
            const keys = [...Object.keys(input.respostas ?? {}), ...(input.confirmar ?? [])];
            if (keys.length === 0) return failure("validation", "Envie ao menos uma resposta ou confirmação.");
            const unknown = keys.find((k) => !byKey.has(k));
            if (unknown) return failure("validation", "Uma das respostas não corresponde a nenhuma pergunta do checklist.");
            const lines = [
                ...Object.entries(input.respostas ?? {}).map(([k, v]) => `${byKey.get(k)}: ${v}`),
                ...(input.confirmar ?? []).map((k) => `${byKey.get(k)}: confirmar como está`),
            ];
            return ok({ resumo: `Gravar no checklist do ${await codeOf(ctx, id.data)}: ${lines.join(" · ")}.` });
        },
    },
    async handler(ctx, input): Promise<ServiceResult<ChecklistPt>> {
        const id = await idOf(ctx, input.pedido);
        if (!id.ok) return id;
        const saved = await answerIntake(ctx.db, callerOf(ctx), id.data, {
            answers: input.respostas ? checklistAnswers(input.respostas) : undefined,
            confirm: input.confirmar,
        });
        if (!saved.ok) return saved;
        return ok(checklistPt(await codeOf(ctx, id.data), saved.data));
    },
    summary(out: ChecklistPt) {
        return out.completo
            ? `Checklist do ${out.codigo} completo. O Legal vai analisar o contrato.`
            : `Respostas gravadas no ${out.codigo}. Falta: ${out.pendentes.join("; ")}.`;
    },
});

const responderInput = { pedido: pedidoRef, resposta: z.string().min(1).max(4000) };

const responderDuvida = defineTool({
    name: "mike_pedidos_responder_duvida",
    title: "Responder ao Legal",
    description:
        "Quem fez o pedido responde a uma pergunta do Legal. Se o prazo estava pausado esperando a resposta, ele volta a correr. " +
        "Pede confirmação antes de enviar.",
    input: responderInput,
    scope: "pedidos:write",
    roles: EVERYONE,
    access: "write",
    annotations: WRITE,
    confirm: {
        async preview(ctx, input) {
            const id = await idOf(ctx, input.pedido);
            if (!id.ok) return id;
            const view = await getRequest(ctx.db, callerOf(ctx), id.data);
            if (!view.ok) return view;
            if (view.data.audience === "team") {
                return failure("forbidden", "Esta resposta é de quem fez o pedido. Para o time, use a tela do pedido.");
            }
            if (view.data.status === "entregue" || view.data.status === "cancelado") {
                return failure("conflict", "Este pedido já foi encerrado.");
            }
            const waiting = view.data.status === "aguardando_solicitante";
            return ok({
                resumo:
                    `Responder no ${view.data.code}: “${input.resposta.slice(0, 280)}”.` +
                    (waiting ? " O prazo do Legal volta a correr." : ""),
            });
        },
    },
    async handler(ctx, input) {
        const id = await idOf(ctx, input.pedido);
        if (!id.ok) return id;
        const current = await getRequest(ctx.db, callerOf(ctx), id.data);
        if (!current.ok) return current;
        if (current.data.audience === "team") {
            return failure("forbidden", "Esta resposta é de quem fez o pedido. Para o time, use a tela do pedido.");
        }
        const posted = await postMessage(ctx.db, callerOf(ctx), id.data, { body: input.resposta });
        if (!posted.ok) return posted;
        return ok({ pedido: completo(posted.data) });
    },
    summary({ pedido: p }) {
        return `Resposta enviada no ${p.codigo}. ${p.quem_cuida ? `${p.quem_cuida} recebe` : "O Legal recebe"} pela tela do pedido.`;
    },
});

const assumirInput = { pedido: pedidoRef };

const assumir = defineTool({
    name: "mike_pedidos_assumir",
    title: "Assumir um pedido",
    description:
        "A pessoa do time passa a cuidar do pedido. Quem pediu é avisado por e-mail. Pede confirmação antes.",
    input: assumirInput,
    scope: "pedidos:write",
    roles: TEAM,
    access: "write",
    annotations: { ...WRITE, idempotentHint: true },
    confirm: {
        async preview(ctx, input) {
            const id = await idOf(ctx, input.pedido);
            if (!id.ok) return id;
            const view = await getRequest(ctx.db, callerOf(ctx), id.data);
            if (!view.ok) return view;
            if (view.data.audience !== "team") return failure("forbidden", "Só o time do Legal assume pedidos.");
            const t = view.data as RequestTeamView;
            if (t.assignee_id === ctx.caller.userId) return failure("conflict", `Você já cuida do ${t.code}.`);
            return ok({
                resumo:
                    `Assumir o ${t.code} (“${t.title}”)` +
                    (t.assignee_name ? `, hoje com ${t.assignee_name}` : ", hoje sem responsável") +
                    `. ${t.requester_name ?? t.requester_email} recebe um e-mail.`,
            });
        },
    },
    async handler(ctx, input) {
        const id = await idOf(ctx, input.pedido);
        if (!id.ok) return id;
        const assigned = await assignRequest(ctx.db, callerOf(ctx), id.data, { assignee_id: ctx.caller.userId });
        if (!assigned.ok) return assigned;
        return ok({ pedido: completo(assigned.data) });
    },
    summary({ pedido: p }) {
        return `Agora ${p.quem_cuida ?? "você"} cuida do ${p.codigo}.`;
    },
});

const mudarEtapaInput = {
    pedido: pedidoRef,
    etapa: z.enum(PIPELINE_LANES).describe("entrada, triagem, revisao, negociacao, assinatura ou arquivado."),
};

const mudarEtapa = defineTool({
    name: "mike_pedidos_mudar_etapa",
    title: "Mudar a etapa de um pedido",
    description:
        "Move o card do pedido na esteira do Legal. Quem pediu vê o reflexo nos 4 passos dele (Assinatura, Concluído). Pede confirmação antes.",
    input: mudarEtapaInput,
    scope: "pedidos:write",
    roles: TEAM,
    access: "write",
    annotations: { ...WRITE, idempotentHint: true },
    confirm: {
        async preview(ctx, input) {
            const id = await idOf(ctx, input.pedido);
            if (!id.ok) return id;
            const view = await getRequest(ctx.db, callerOf(ctx), id.data);
            if (!view.ok) return view;
            if (view.data.audience !== "team") return failure("forbidden", "Só o time do Legal muda a etapa.");
            const t = view.data as RequestTeamView;
            const from = t.lane ? (LANE_LABELS[t.lane] ?? t.lane) : "fora da esteira";
            if (t.lane === input.etapa) return failure("conflict", `O ${t.code} já está em ${from}.`);
            return ok({ resumo: `Mover o ${t.code} de ${from} para ${LANE_LABELS[input.etapa]}.` });
        },
    },
    async handler(ctx, input) {
        const id = await idOf(ctx, input.pedido);
        if (!id.ok) return id;
        const moved = await moveRequestStage(ctx.db, callerOf(ctx), id.data, { lane: input.etapa });
        if (!moved.ok) return moved;
        return ok({ pedido: completo(moved.data) });
    },
    summary({ pedido: p }) {
        return `${p.codigo} agora está em ${p.etapa_na_esteira ?? "outra etapa"}.`;
    },
});

const decidirInput = {
    pedido: pedidoRef,
    decisao: z.enum(["aceitar", "editar", "rejeitar"]),
    tipo: z.enum(REQUEST_KINDS).optional().describe("Só ao editar."),
    contraparte: z.string().max(200).optional().describe("Só ao editar."),
    responsavel_email: z
        .string()
        .email()
        .optional()
        .describe("Só ao editar: o e-mail de quem do time vai cuidar."),
    motivo: z.string().max(300).optional().describe("Ao rejeitar, por quê."),
};

type DecidirInput = z.infer<z.ZodObject<typeof decidirInput>>;

async function decisionBody(ctx: McpContext, input: DecidirInput): Promise<ServiceResult<Record<string, unknown>>> {
    const decision = { aceitar: "accepted", editar: "edited", rejeitar: "rejected" }[input.decisao];
    if (input.decisao !== "editar") return ok({ decision, reason: input.motivo });
    let assigneeId: string | undefined;
    if (input.responsavel_email) {
        const list = await listRequests(ctx.db, callerOf(ctx));
        if (!list.ok) return list;
        const member = list.data.team.find((m) => m.email.toLowerCase() === input.responsavel_email!.toLowerCase());
        if (!member) return failure("validation", "Essa pessoa não é do time do Legal.");
        assigneeId = member.id;
    }
    return ok({ decision, kind: input.tipo, counterparty: input.contraparte, assignee_id: assigneeId });
}

const decidirTriagem = defineTool({
    name: "mike_pedidos_decidir_triagem",
    title: "Decidir a triagem do agente",
    description:
        "A liderança do Legal aceita, edita (tipo, contraparte, responsável) ou rejeita a sugestão do agente de triagem. " +
        "Aceitar aplica o tipo e o responsável sugeridos. Pede confirmação antes.",
    input: decidirInput,
    scope: "pedidos:write",
    roles: ["head"],
    access: "write",
    annotations: WRITE,
    confirm: {
        async preview(ctx, input) {
            const id = await idOf(ctx, input.pedido);
            if (!id.ok) return id;
            const view = await getRequest(ctx.db, callerOf(ctx), id.data);
            if (!view.ok) return view;
            const t = view.data as RequestTeamView;
            if (view.data.audience !== "team" || !t.can_decide) {
                return failure("forbidden", "Só a liderança do Legal decide a triagem.");
            }
            const triage = t.triage as {
                kind?: string;
                counterparty?: string | null;
                assignee_name?: string | null;
                decision?: string | null;
            } | null;
            if (!triage) return failure("conflict", "A triagem ainda não terminou.");
            if (triage.decision) return failure("conflict", `A triagem do ${t.code} já foi decidida.`);
            const body = await decisionBody(ctx, input);
            if (!body.ok) return body;
            const kindLabel = (k?: string) => (k ? (KIND_LABELS[k as keyof typeof KIND_LABELS] ?? k) : "sem tipo");
            const resumo =
                input.decisao === "aceitar"
                    ? `Aceitar a triagem do ${t.code}: ${kindLabel(triage.kind)}` +
                      (triage.counterparty ? `, contraparte ${triage.counterparty}` : "") +
                      (triage.assignee_name ? `, ${triage.assignee_name} cuida` : "") +
                      "."
                    : input.decisao === "editar"
                      ? `Editar a triagem do ${t.code}: ${kindLabel(input.tipo ?? triage.kind)}` +
                        (input.contraparte ? `, contraparte ${input.contraparte}` : "") +
                        (input.responsavel_email ? `, ${input.responsavel_email} cuida` : "") +
                        "."
                      : `Rejeitar a triagem do ${t.code}` + (input.motivo ? ` (${input.motivo})` : "") + ".";
            return ok({ resumo });
        },
    },
    async handler(ctx, input) {
        const id = await idOf(ctx, input.pedido);
        if (!id.ok) return id;
        const body = await decisionBody(ctx, input);
        if (!body.ok) return body;
        const decided = await decideTriage(ctx.db, callerOf(ctx), id.data, body.data);
        if (!decided.ok) return decided;
        return ok({ pedido: completo(decided.data) });
    },
    summary({ pedido: p }) {
        return `Triagem do ${p.codigo} decidida. ${p.quem_cuida ? `${p.quem_cuida} cuida.` : "Ainda sem responsável."}`;
    },
});

/** Phase 1: reads only (doc 09 §10). */
export const REQUEST_READ_TOOLS: AnyMcpTool[] = [listarMeus, ler, statusEPlano, fila, checklist];
/** Phase 2: writes, each with a preview the mcp module confirms first. */
export const REQUEST_WRITE_TOOLS: AnyMcpTool[] = [
    criar,
    responderChecklist,
    responderDuvida,
    assumir,
    mudarEtapa,
    decidirTriagem,
];
/**
 * Everything the mcp catalog takes. The server refuses any `write` until
 * Phase 2 and leaves it out of the catalog, so the writes travel along.
 */
export const REQUEST_TOOLS: AnyMcpTool[] = [...REQUEST_READ_TOOLS, ...REQUEST_WRITE_TOOLS];
