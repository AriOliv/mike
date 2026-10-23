// L-54: validation, sources, cache and the flag. No network: a fake fetcher
// answers; the CNPJs are the well-known test number 11.222.333/0001-81.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { fromBrasilApi, fromReceitaWs, lookupCnpj, validCnpj, type Fetcher } from "../cnpj.lookup";

const CNPJ = "11222333000181";
const NOW = new Date("2026-10-23T12:00:00Z");
const brasil = {
    razao_social: "EMPRESA FICTICIA LTDA",
    nome_fantasia: "Ficticia",
    descricao_situacao_cadastral: "ATIVA",
    natureza_juridica: "Sociedade Empresária Limitada",
    cnae_fiscal: 6201501,
    cnae_fiscal_descricao: "Desenvolvimento de programas de computador sob encomenda",
    logradouro: "RUA DAS FLORES",
    numero: "10",
    bairro: "CENTRO",
    municipio: "SAO PAULO",
    uf: "SP",
    cep: "01000000",
    qsa: [{ nome_socio: "NAO DEVE APARECER" }],
};
const reply = (status: number, body: unknown = {}): Fetcher => async () => ({ status, json: async () => body });

beforeEach(() => {
    process.env.CNPJ_LOOKUP_ENABLED = "true";
});
afterEach(() => {
    delete process.env.CNPJ_LOOKUP_ENABLED;
    delete process.env.CNPJ_CACHE_DAYS;
});

describe("validCnpj", () => {
    it("checks the digits, with or without punctuation", () => {
        expect(validCnpj("11.222.333/0001-81")).toBe(true);
        expect(validCnpj(CNPJ)).toBe(true);
        expect(validCnpj("11222333000182")).toBe(false);
        expect(validCnpj("00000000000000")).toBe(false);
        expect(validCnpj("123")).toBe(false);
    });
});

describe("source mapping", () => {
    it("maps BrasilAPI and leaves the partners out", () => {
        const r = fromBrasilApi(CNPJ, brasil)!;
        expect(r).toMatchObject({ razao_social: "EMPRESA FICTICIA LTDA", situacao: "ATIVA", cnae: { codigo: "6201501" } });
        expect(r.endereco).toBe("RUA DAS FLORES 10, CENTRO, SAO PAULO/SP, 01000000");
        expect(JSON.stringify(r)).not.toContain("NAO DEVE APARECER");
    });
    it("maps ReceitaWS and rejects its error body", () => {
        expect(fromReceitaWs(CNPJ, { nome: "X LTDA", situacao: "ATIVA", atividade_principal: [{ code: "62.01-5-01", text: "Software" }] })).toMatchObject({
            razao_social: "X LTDA",
            cnae: { codigo: "6201501", descricao: "Software" },
        });
        expect(fromReceitaWs(CNPJ, { status: "ERROR", message: "CNPJ inválido" })).toBeNull();
    });
});

describe("lookupCnpj", () => {
    it("is off unless the flag is on", async () => {
        delete process.env.CNPJ_LOOKUP_ENABLED;
        expect(await lookupCnpj(scriptedDb([]).db, CNPJ)).toMatchObject({ ok: false, code: "cnpj_disabled" });
    });

    it("refuses an invalid CNPJ before any query", async () => {
        expect(await lookupCnpj(scriptedDb([]).db, "11222333000182")).toMatchObject({ ok: false, kind: "validation", code: "cnpj_invalid" });
    });

    it("fetches, caches, and answers from the cache inside the window", async () => {
        const miss = scriptedDb([
            { table: "cnpj_lookups", data: null },
            { table: "cnpj_lookups", op: "upsert", data: null },
        ]);
        const first = await lookupCnpj(miss.db, "11.222.333/0001-81", { fetcher: reply(200, brasil), now: NOW });
        expect(first).toMatchObject({ ok: true, data: { fonte: "brasilapi", razao_social: "EMPRESA FICTICIA LTDA" } });
        miss.done();
        expect((miss.calls[1].payload as { cnpj: string }).cnpj).toBe(CNPJ);

        const stored = (miss.calls[1].payload as { payload: unknown; fetched_at: string });
        const hit = scriptedDb([{ table: "cnpj_lookups", data: stored }]);
        const never: Fetcher = async () => {
            throw new Error("must not fetch");
        };
        expect(await lookupCnpj(hit.db, CNPJ, { fetcher: never, now: new Date(NOW.getTime() + 86_400_000) })).toMatchObject({
            ok: true,
            data: { fonte: "cache" },
        });
    });

    it("refreshes an old row, and falls to ReceitaWS when BrasilAPI fails", async () => {
        const old = { payload: { ...fromBrasilApi(CNPJ, brasil)! }, fetched_at: "2026-01-01T00:00:00Z" };
        const fake = scriptedDb([
            { table: "cnpj_lookups", data: old },
            { table: "cnpj_lookups", op: "upsert", data: null },
        ]);
        const fetcher: Fetcher = async (url) =>
            url.includes("brasilapi") ? { status: 500, json: async () => ({}) } : { status: 200, json: async () => ({ nome: "NOVA RAZAO LTDA" }) };
        expect(await lookupCnpj(fake.db, CNPJ, { fetcher, now: NOW })).toMatchObject({ ok: true, data: { fonte: "receitaws", razao_social: "NOVA RAZAO LTDA" } });
        fake.done();
    });

    it("serves the stale row when both sources are down, and names the failure when there is none", async () => {
        const old = { payload: { ...fromBrasilApi(CNPJ, brasil)! }, fetched_at: "2026-01-01T00:00:00Z" };
        const down: Fetcher = async () => {
            throw new Error("ERR_BLOCKED_DESTINATION");
        };
        expect(await lookupCnpj(scriptedDb([{ table: "cnpj_lookups", data: old }]).db, CNPJ, { fetcher: down, now: NOW })).toMatchObject({
            ok: true,
            data: { fonte: "cache" },
        });
        expect(await lookupCnpj(scriptedDb([{ table: "cnpj_lookups", data: null }]).db, CNPJ, { fetcher: down, now: NOW })).toMatchObject({
            ok: false,
            kind: "unavailable",
            code: "cnpj_unreachable",
        });
    });

    it("says not found when the sources do not know the CNPJ", async () => {
        expect(await lookupCnpj(scriptedDb([{ table: "cnpj_lookups", data: null }]).db, CNPJ, { fetcher: reply(404), now: NOW })).toMatchObject({
            ok: false,
            kind: "not_found",
            code: "cnpj_not_found",
        });
    });
});
