// The Notion API, for one organization's token. Fetch is injectable so tests
// run against a mock and the preview runs without network (NOTION_API_BASE
// points it at a mock server). The token is only ever in the Authorization
// header: it never appears in an error, a log line or a returned value.

const DEFAULT_BASE = "https://api.notion.com/v1";
export const NOTION_VERSION = "2022-06-28";

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    json(): Promise<unknown>;
}>;

export class NotionError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
    ) {
        super(`notion ${status} ${code}`);
    }
}

export type NotionClient = {
    request(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<Record<string, unknown>>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function notionClient(
    token: string,
    fetchImpl: Fetch = globalThis.fetch as unknown as Fetch,
    opts: { base?: string; wait?: (ms: number) => Promise<void> } = {},
): NotionClient {
    const base = (opts.base ?? process.env.NOTION_API_BASE?.trim() ?? DEFAULT_BASE).replace(/\/+$/, "");
    const wait = opts.wait ?? sleep;
    const headers = { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" };
    return {
        async request(method, path, body) {
            const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
            let response = await fetchImpl(`${base}${path}`, init);
            // Notion asks for a wait on 429; one retry after it, then give up.
            if (response.status === 429) {
                const seconds = Math.min(Number(response.headers.get("Retry-After") ?? "1") || 1, 30);
                await wait(seconds * 1000);
                response = await fetchImpl(`${base}${path}`, init);
            }
            if (!response.ok) {
                const payload = (await response.json().catch(() => ({}))) as { code?: unknown };
                throw new NotionError(response.status, typeof payload.code === "string" ? payload.code : "unknown");
            }
            return (await response.json()) as Record<string, unknown>;
        },
    };
}

/** A person-facing sentence for a Notion failure; never the raw error. */
export function notionErrorMessage(error: unknown): string {
    if (error instanceof NotionError) {
        if (error.status === 401) return "O Notion recusou o token. Confira se ele está certo e ativo.";
        if (error.status === 403 || error.status === 404)
            return "A integração não tem acesso a esta base. No Notion, abra a base e conecte a integração em Conexões.";
        if (error.status === 429) return "O Notion pediu uma pausa. Tente de novo em um minuto.";
        return "O Notion não respondeu como esperado. Tente de novo mais tarde.";
    }
    return "Não consegui falar com o Notion. Confira a saída de rede do servidor.";
}
