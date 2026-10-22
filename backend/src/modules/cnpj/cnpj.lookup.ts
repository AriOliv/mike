// L-54: the company record of a CNPJ, from the Receita's public data through
// BrasilAPI (ReceitaWS as the second source). No key. Behind CNPJ_LOOKUP_ENABLED
// because staging egress is default-deny: the two hosts below need to be
// allowed before it is switched on. Cached per CNPJ for CNPJ_CACHE_DAYS.
// The partners' names (QSA) are left out on purpose: personal data we do not need.

import type { Db } from "../../lib/supabase";
import { egressProxyFor, proxiedFetch } from "../../lib/egressProxy";
import { guardedFetch } from "../../lib/mcp/client";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";

export const CNPJ_HOSTS = ["brasilapi.com.br", "receitaws.com.br"] as const;
const TIMEOUT_MS = 8000;
const DEFAULT_CACHE_DAYS = 30;

export type CnpjRecord = {
    cnpj: string;
    razao_social: string;
    nome_fantasia: string | null;
    situacao: string | null;
    natureza_juridica: string | null;
    cnae: { codigo: string | null; descricao: string | null };
    porte: string | null;
    abertura: string | null;
    endereco: string | null;
    telefone: string | null;
    email: string | null;
};
export type CnpjResult = CnpjRecord & { fonte: "cache" | "brasilapi" | "receitaws"; consultado_em: string };

export const cnpjLookupEnabled = () => process.env.CNPJ_LOOKUP_ENABLED === "true";

export function onlyDigits(value: string): string {
    return value.replace(/\D/g, "");
}

/** The two check digits of a CNPJ (modulo 11). Rejects all-equal sequences. */
export function validCnpj(value: string): boolean {
    const d = onlyDigits(value);
    if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
    const digit = (len: number) => {
        let sum = 0;
        let weight = len - 7;
        for (let i = 0; i < len; i++) {
            sum += Number(d[i]) * weight--;
            if (weight < 2) weight = 9;
        }
        const r = sum % 11;
        return r < 2 ? 0 : 11 - r;
    };
    return digit(12) === Number(d[12]) && digit(13) === Number(d[13]);
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const join = (parts: unknown[], sep: string) => parts.map(str).filter(Boolean).join(sep) || null;

export function fromBrasilApi(cnpj: string, j: Record<string, unknown>): CnpjRecord | null {
    const razao = str(j.razao_social);
    if (!razao) return null;
    return {
        cnpj,
        razao_social: razao,
        nome_fantasia: str(j.nome_fantasia),
        situacao: str(j.descricao_situacao_cadastral),
        natureza_juridica: str(j.natureza_juridica),
        cnae: { codigo: j.cnae_fiscal == null ? null : String(j.cnae_fiscal), descricao: str(j.cnae_fiscal_descricao) },
        porte: str(j.porte),
        abertura: str(j.data_inicio_atividade),
        endereco: join(
            [join([j.logradouro, j.numero, j.complemento], " "), j.bairro, join([j.municipio, j.uf], "/"), j.cep],
            ", ",
        ),
        telefone: str(j.ddd_telefone_1),
        email: str(j.email),
    };
}

export function fromReceitaWs(cnpj: string, j: Record<string, unknown>): CnpjRecord | null {
    const razao = str(j.nome);
    if (!razao || j.status === "ERROR") return null;
    const main = Array.isArray(j.atividade_principal) ? (j.atividade_principal[0] as Record<string, unknown> | undefined) : undefined;
    return {
        cnpj,
        razao_social: razao,
        nome_fantasia: str(j.fantasia),
        situacao: str(j.situacao),
        natureza_juridica: str(j.natureza_juridica),
        cnae: { codigo: str(main?.code)?.replace(/\D/g, "") ?? null, descricao: str(main?.text) },
        porte: str(j.porte),
        abertura: str(j.abertura),
        endereco: join([join([j.logradouro, j.numero, j.complemento], " "), j.bairro, join([j.municipio, j.uf], "/"), j.cep], ", "),
        telefone: str(j.telefone),
        email: str(j.email),
    };
}

export type Fetcher = (url: string) => Promise<{ status: number; json: () => Promise<unknown> }>;

/**
 * With CNPJ_EGRESS_PROXY_URL (or the shared EGRESS_PROXY_URL) set, the two
 * hosts above are reached through that proxy, and only those two. Without it,
 * the guarded direct path, as before.
 */
export const defaultFetcher: Fetcher = (url) => {
    const init = { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) };
    const proxyUrl = egressProxyFor("CNPJ_EGRESS_PROXY_URL");
    return proxyUrl
        ? proxiedFetch(url, init, { proxyUrl, allowedHosts: CNPJ_HOSTS })
        : guardedFetch(url, init, { label: "CNPJ lookup URL" });
};

type Source = { id: "brasilapi" | "receitaws"; url: (c: string) => string; parse: typeof fromBrasilApi };
const SOURCES: Source[] = [
    { id: "brasilapi", url: (c) => `https://brasilapi.com.br/api/cnpj/v1/${c}`, parse: fromBrasilApi },
    { id: "receitaws", url: (c) => `https://receitaws.com.br/v1/cnpj/${c}`, parse: fromReceitaWs },
];

export async function lookupCnpj(
    db: Db,
    raw: string,
    deps: { fetcher?: Fetcher; now?: Date } = {},
): Promise<ServiceResult<CnpjResult>> {
    if (!cnpjLookupEnabled()) return failure("unavailable", "A consulta de CNPJ não está ligada neste ambiente.", "cnpj_disabled");
    if (!validCnpj(raw)) return failure("validation", "Esse CNPJ não é válido. Confira os 14 dígitos.", "cnpj_invalid");
    const cnpj = onlyDigits(raw);
    const now = deps.now ?? new Date();
    const days = Number(process.env.CNPJ_CACHE_DAYS) > 0 ? Number(process.env.CNPJ_CACHE_DAYS) : DEFAULT_CACHE_DAYS;

    const { data: cached, error: cacheError } = await db
        .from("cnpj_lookups")
        .select("payload, fetched_at")
        .eq("cnpj", cnpj)
        .maybeSingle();
    if (cacheError) return internalFailure(cacheError);
    const row = cached as { payload: CnpjRecord; fetched_at: string } | null;
    if (row && now.getTime() - Date.parse(row.fetched_at) < days * 86_400_000) {
        return ok({ ...row.payload, fonte: "cache", consultado_em: row.fetched_at });
    }

    const fetcher = deps.fetcher ?? defaultFetcher;
    let notFound = false;
    for (const source of SOURCES) {
        try {
            const answer = await fetcher(source.url(cnpj));
            if (answer.status === 404) {
                notFound = true;
                continue;
            }
            if (answer.status !== 200) continue;
            const record = source.parse(cnpj, (await answer.json()) as Record<string, unknown>);
            if (!record) continue;
            const fetched_at = now.toISOString();
            const { error } = await db.from("cnpj_lookups").upsert({ cnpj, payload: record, fetched_at });
            if (error) return internalFailure(error);
            return ok({ ...record, fonte: source.id, consultado_em: fetched_at });
        } catch {
            // Timeout, blocked egress or a bad body: try the next source.
        }
    }
    // A stale answer beats none when both sources are down.
    if (row) return ok({ ...row.payload, fonte: "cache", consultado_em: row.fetched_at });
    return notFound
        ? failure("not_found", "Não encontrei esse CNPJ na Receita.", "cnpj_not_found")
        : failure("unavailable", "Não consegui consultar a Receita agora. Tente de novo em instantes.", "cnpj_unreachable");
}
