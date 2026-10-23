// RASCUNHO — backend/src/agents/triggers.ts. Não compilado.
//
// A esteira é o orquestrador: cada agente é um passo disparado por um evento do
// card. Esta tabela é a ÚNICA fonte de "qual evento dispara qual agente" —
// declarativa, versionada por PR, testável sem banco.
//
// Fluxo: rota/cron grava card_events → emitCardEvent() consulta TRIGGERS →
// enfileira db_jobs (kind "agent.<nome>", dedupe_key por versão do documento)
// → worker (WORKERS_MODE=agents) executa → grava agent_runs + card_events.
//
// Regra de autoridade: agente escreve campos derivados (↓) e SUGERE; nunca
// muda lane nem os campos de gestão (status/assignee/priority/deadline).
import type { Lane } from "../routes/pipeline";

export type AgentName =
    | "intake"
    | "extrator"
    | "verificador"
    | "risco"
    | "redator"
    | "verificador_assinatura"
    | "vigia"
    | "notificador"
    | "indexador";

export type CardEvent =
    | { action: "request.created"; projectId: string }
    | { action: "lane.changed"; projectId: string; from: Lane | null; to: Lane }
    | { action: "document.version_added"; projectId: string; lane: Lane | null; docSha: string }
    | { action: "agent.succeeded"; projectId: string; agent: AgentName; docSha?: string }
    | { action: "action.requested"; projectId: string; what: "redline" | "reanalyze" };

type Trigger = {
    when: (e: CardEvent) => boolean;
    run: AgentName;
    // chave de idempotência: o mesmo agente não roda 2x sobre a mesma versão
    dedupe: (e: CardEvent) => string;
};

const docOf = (e: CardEvent) => ("docSha" in e && e.docSha ? e.docSha : "current");

export const TRIGGERS: Trigger[] = [
    // Entrada
    {
        when: (e) => e.action === "request.created",
        run: "intake",
        dedupe: (e) => `intake:${e.projectId}`,
    },
    // Triagem → Extrator → Verificador → Risco (encadeado por agent.succeeded)
    {
        when: (e) => e.action === "lane.changed" && e.to === "triagem",
        run: "extrator",
        dedupe: (e) => `extrator:${e.projectId}:${docOf(e)}`,
    },
    {
        when: (e) =>
            e.action === "document.version_added" &&
            (e.lane === "triagem" || e.lane === "revisao" || e.lane === "negociacao"),
        run: "extrator",
        dedupe: (e) => `extrator:${e.projectId}:${docOf(e)}`,
    },
    {
        when: (e) => e.action === "agent.succeeded" && e.agent === "extrator",
        run: "verificador",
        dedupe: (e) => `verificador:${e.projectId}:${docOf(e)}`,
    },
    {
        when: (e) => e.action === "agent.succeeded" && e.agent === "verificador",
        run: "risco",
        dedupe: (e) => `risco:${e.projectId}:${docOf(e)}`,
    },
    // Revisão / Negociação → Redator só sob demanda (botão), nunca automático
    {
        when: (e) => e.action === "action.requested" && e.what === "redline",
        run: "redator",
        dedupe: (e) => `redator:${e.projectId}:${Date.now()}`, // cada pedido é um run
    },
    // Assinatura → confere que a versão enviada é a aprovada
    {
        when: (e) => e.action === "lane.changed" && e.to === "assinatura",
        run: "verificador_assinatura",
        dedupe: (e) => `assinatura:${e.projectId}:${docOf(e)}`,
    },
    // Arquivado → extração final (vigência/obrigações) alimenta o Vigia
    {
        when: (e) => e.action === "lane.changed" && e.to === "arquivado",
        run: "extrator",
        dedupe: (e) => `extrator-final:${e.projectId}:${docOf(e)}`,
    },
    // Toda versão nova é indexada para o Q&A (busca híbrida)
    {
        when: (e) => e.action === "document.version_added",
        run: "indexador",
        dedupe: (e) => `index:${e.projectId}:${docOf(e)}`,
    },
];

// O Vigia de prazos não reage a evento de card: roda por cron diário (07:00
// America/Sao_Paulo) como job "agent.vigia" com dedupe_key = "vigia:<data>".
// O Notificador consome a tabela notifications (outbox), não TRIGGERS.

export function agentsFor(e: CardEvent): Array<{ agent: AgentName; dedupeKey: string }> {
    return TRIGGERS.filter((t) => t.when(e)).map((t) => ({ agent: t.run, dedupeKey: t.dedupe(e) }));
}

// Contrato de cada agente (implementações em agents/<nome>.ts):
export type AgentSpec<I, O> = {
    name: AgentName;
    version: string;               // sobe a cada mudança de prompt/schema
    modelAlias: "mike-extract" | "mike-reason" | "mike-embed" | null; // null = determinístico
    promptFile?: string;           // agents/prompts/<nome>.md
    maxCostUsd: number;            // teto por execução; estourou → needs_human
    run: (input: I, ctx: AgentContext) => Promise<O>; // O validado por zod antes de gravar
};

export type AgentContext = {
    projectId: string;
    orgId: string;
    runId: string;
    // LLM sempre via LiteLLM, com tags para custo por contrato
    llm: (args: { alias: string; system: string; user: string; maxTokens?: number }) => Promise<{
        text: string;
        tokensIn: number;
        tokensOut: number;
        costUsd: number;
        modelResolved: string;
    }>;
};
