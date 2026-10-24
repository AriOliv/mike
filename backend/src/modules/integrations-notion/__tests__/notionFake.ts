// A Notion API stand-in for tests: a fixed board with synthetic names only.
import type { Fetch } from "../notion.client";

export const DB_ID = "0123456789abcdef0123456789abcdef";

export const BOARD = {
    object: "database",
    id: DB_ID,
    title: [{ plain_text: "Esteira (fictícia)" }],
    properties: {
        Contrato: { type: "title" },
        Contraparte: { type: "rich_text" },
        Solicitante: { type: "rich_text" },
        Responsável: { type: "people" },
        Pessoa: { type: "people" },
        Etapa: {
            type: "select",
            select: {
                options: ["Entrada", "Not started", "Triagem", "Revisão", "Negociação", "Assinatura", "Arquivado", "Done", "Processos", "Legal Estratégico", "Pendências menores (backlog)"].map((name) => ({ name })),
            },
        },
        Progresso: { type: "select", select: { options: [{ name: "A fazer" }, { name: "Em andamento" }] } },
        Status: { type: "status", status: { options: [{ name: "Não iniciada" }] } },
        Prioridade: { type: "select", select: { options: [{ name: "Alta" }] } },
        Risco: { type: "select", select: { options: [{ name: "OK" }] } },
        Prazo: { type: "date" },
        Renovação: { type: "date" },
        "Data de conclusão": { type: "date" },
        Atualizado: { type: "date" },
        Tipo: { type: "select", select: { options: [] } },
        ProjectId: { type: "rich_text" },
        "Abrir no app": { type: "url" },
        Documento: { type: "url" },
    },
};

export type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/** A fetch that answers like Notion; `routes` override by "METHOD path". */
export function fakeNotion(routes: Record<string, { status?: number; body?: unknown; headers?: Record<string, string> }[] | { status?: number; body?: unknown }> = {}) {
    const calls: Call[] = [];
    const queues = new Map<string, { status?: number; body?: unknown; headers?: Record<string, string> }[]>();
    for (const [key, value] of Object.entries(routes)) queues.set(key, Array.isArray(value) ? [...value] : [value]);
    const fetch: Fetch = async (url, init) => {
        const path = url.replace(/^https?:\/\/[^/]+\/v1/, "");
        calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
        const key = `${init.method} ${path.split("?")[0]}`;
        const queue = queues.get(key);
        const answer = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
        type Answer = { status?: number; body?: unknown; headers?: Record<string, string> };
        const fallback: Answer =
            key === "GET /users/me"
                ? { body: { object: "user", type: "bot" } }
                : key === `GET /databases/${DB_ID}`
                  ? { body: BOARD }
                  : key === "POST /search"
                    ? { body: { results: [{ id: DB_ID, title: BOARD.title }] } }
                    : { status: 404, body: { code: "object_not_found" } };
        const { status = 200, body = {}, headers = {} } = answer ?? fallback;
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (name: string) => headers[name] ?? null },
            json: async () => body,
        };
    };
    return { fetch, calls };
}
