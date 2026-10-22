import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const corpus = vi.hoisted(() => ({ contractCorpus: vi.fn() }));
vi.mock("../../contracts/contracts.service", () => corpus);
const settings = vi.hoisted(() => ({ getUserModelSettings: vi.fn() }));
vi.mock("../../user/user.service", () => settings);
const llm = vi.hoisted(() => ({ completeText: vi.fn() }));
vi.mock("../../../lib/llm", () => llm);
const dbq = vi.hoisted(() => ({ enqueueDbJob: vi.fn() }));
vi.mock("../../../lib/dbq/enqueue", () => dbq);

import {
    actKey,
    enqueueDueRegulatoryScans,
    handleRegulatoryScan,
    modelSummarizer,
    quoteChecksOut,
    runRegulatoryScan,
} from "../regulatory.scan";
import type { Fetcher } from "../regulatory.sources";
import type { DbJob } from "../../../lib/dbq/types";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const NOW = new Date("2026-10-20T12:00:00Z");

const fixtureFetcher: Fetcher = async (url) => ({
    ok: true,
    status: 200,
    text: async () =>
        url.includes("bcb.gov.br") ? fixture("bcb-normativos.json") : url.includes("in.gov.br") ? fixture("dou-leiturajornal.html") : fixture("cvm-rss.xml"),
});

const scan = {
    id: "s1",
    user_id: "u1",
    org_id: "o1",
    name: "BCB",
    sources: ["bcb_normativos", "dou"],
    issuers: ["Banco Central do Brasil"],
    keywords: ["ativos virtuais", "pix"],
    topics: ["cripto", "psp"],
    enabled: true,
};

beforeEach(() => {
    corpus.contractCorpus.mockReset();
    settings.getUserModelSettings.mockReset();
    llm.completeText.mockReset();
    dbq.enqueueDbJob.mockReset();
});

describe("runRegulatoryScan", () => {
    it("stores the matching changes with impact, citation and the contracts they affect", async () => {
        corpus.contractCorpus.mockResolvedValue([
            { project_id: "p1", name: "MSA Exchange", counterparty: "X", org_id: "o1", text: "A parte presta serviços de ativos virtuais." },
            { project_id: "p2", name: "Locação", counterparty: "Y", org_id: "o1", text: "Imóvel comercial." },
        ]);
        const summarize = vi.fn(async () => ({
            summary: "O BCB regula as prestadoras de ativos virtuais.",
            quote: "prestação de serviços de ativos virtuais",
        }));
        const fake = scriptedDb([
            { table: "regulatory_scans", data: scan },
            { table: "regulatory_changes", data: [] },
            { table: "regulatory_changes", op: "insert" },
            { table: "regulatory_scans", op: "update" },
        ]);

        const result = await runRegulatoryScan(fake.db, "s1", { fetcher: fixtureFetcher, now: NOW, summarize });

        expect(result).toMatchObject({ matched: 1, inserted: 1, errors: [], contracts_searched: 2 });
        expect(corpus.contractCorpus).toHaveBeenCalledWith(fake.db, { orgId: "o1", userId: "u1" });
        const [row] = fake.calls[2].payload as Record<string, unknown>[];
        expect(row).toMatchObject({
            scan_id: "s1",
            source: "bcb_normativos",
            external_id: "900001",
            impact: "alto",
            effective_date: "2027-02-02",
            summary: "O BCB regula as prestadoras de ativos virtuais.",
            topics: ["cripto"],
            affected: [{ project_id: "p1", term: "ativos virtuais" }],
        });
        expect(row.affected).toEqual([expect.objectContaining({ quote: expect.stringContaining("ativos virtuais") })]);
        expect(fake.calls[0].filters).toContainEqual(["eq", "id", "s1"]);
        expect(fake.calls[3].payload).toMatchObject({ last_run_at: NOW.toISOString(), last_error: null });
        fake.done();
    });

    it("drops a summary whose quote is not in the official text", async () => {
        corpus.contractCorpus.mockResolvedValue([]);
        const fake = scriptedDb([
            { table: "regulatory_scans", data: scan },
            { table: "regulatory_changes", data: [] },
            { table: "regulatory_changes", op: "insert" },
            { table: "regulatory_scans", op: "update" },
        ]);
        await runRegulatoryScan(fake.db, "s1", {
            fetcher: fixtureFetcher,
            now: NOW,
            summarize: async () => ({ summary: "Inventado.", quote: "texto que não existe no ato oficial" }),
        });
        expect((fake.calls[2].payload as Record<string, unknown>[])[0]).toMatchObject({ summary: null, summary_quote: null });
        fake.done();
    });

    it("keeps the change when the summarizer fails", async () => {
        corpus.contractCorpus.mockResolvedValue([]);
        const fake = scriptedDb([
            { table: "regulatory_scans", data: scan },
            { table: "regulatory_changes", data: [] },
            { table: "regulatory_changes", op: "insert" },
            { table: "regulatory_scans", op: "update" },
        ]);
        const result = await runRegulatoryScan(fake.db, "s1", {
            fetcher: fixtureFetcher,
            now: NOW,
            summarize: async () => {
                throw new Error("provider down");
            },
        });
        expect(result.inserted).toBe(1);
        fake.done();
    });

    it("inserts nothing on a re-run (idempotent) and dedupes the same act across sources", async () => {
        const fake = scriptedDb([
            { table: "regulatory_scans", data: { ...scan, keywords: [] } },
            {
                table: "regulatory_changes",
                data: [
                    { source: "bcb_normativos", external_id: "900001", title: "Resolução BCB N° 999" },
                    // the DOU's IN 782 was already found via the BCB API
                    { source: "bcb_normativos", external_id: "x", title: "Instrução Normativa BCB nº 782" },
                ],
            },
            { table: "regulatory_changes", op: "insert" },
            { table: "regulatory_scans", op: "update" },
        ]);
        corpus.contractCorpus.mockResolvedValue([]);
        const result = await runRegulatoryScan(fake.db, "s1", { fetcher: fixtureFetcher, now: NOW, summarize: async () => null });
        const inserted = (fake.calls[2].payload as { title: string }[]).map((r) => r.title);
        expect(inserted).not.toContain("Resolução BCB N° 999");
        expect(inserted.some((t) => t.includes("782"))).toBe(false);
        expect(result.inserted).toBe(inserted.length);
        fake.done();
    });

    it("records the failure when every source is down", async () => {
        const fake = scriptedDb([
            { table: "regulatory_scans", data: scan },
            { table: "regulatory_changes", data: [] },
            { table: "regulatory_scans", op: "update" },
        ]);
        const result = await runRegulatoryScan(fake.db, "s1", {
            fetcher: async () => ({ ok: false, status: 500, text: async () => "" }),
            now: NOW,
        });
        expect(result.inserted).toBe(0);
        expect(corpus.contractCorpus).not.toHaveBeenCalled();
        expect(fake.calls[2].payload).toMatchObject({ last_error: expect.stringContaining("HTTP 500") });
        fake.done();
    });

    it("does nothing for a disabled or missing scan, and ignores unknown sources", async () => {
        const off = scriptedDb([{ table: "regulatory_scans", data: { ...scan, enabled: false } }]);
        expect(await runRegulatoryScan(off.db, "s1", { fetcher: fixtureFetcher })).toMatchObject({ read: 0 });
        off.done();
        const unknown = scriptedDb([
            { table: "regulatory_scans", data: { ...scan, sources: ["twitter"] } },
            { table: "regulatory_changes", data: [] },
            { table: "regulatory_scans", op: "update" },
        ]);
        expect(await runRegulatoryScan(unknown.db, "s1", { fetcher: fixtureFetcher, now: NOW })).toMatchObject({ read: 0 });
        unknown.done();
    });

    it("throws a database error so the job retries", async () => {
        const fake = scriptedDb([{ table: "regulatory_scans", error: { message: "down" } }]);
        await expect(runRegulatoryScan(fake.db, "s1")).rejects.toEqual({ message: "down" });
    });
});

describe("summarizer", () => {
    const item = {
        source: "dou" as const,
        external_id: "1",
        title: "Resolução",
        act_type: null,
        issuer: null,
        published_at: null,
        url: null,
        excerpt: "Texto oficial.",
    };

    it("uses the scan owner's model and parses its JSON", async () => {
        settings.getUserModelSettings.mockResolvedValue({ tabular_model: "m1", last_selected_chat_model: null, api_keys: {} });
        llm.completeText.mockResolvedValue('```json\n{"summary": " Resumo. ", "quote": "Texto oficial"}\n```');
        const summarize = modelSummarizer({} as never);
        expect(await summarize({ scan, item })).toEqual({ summary: "Resumo.", quote: "Texto oficial" });
        expect(llm.completeText).toHaveBeenCalledWith(expect.objectContaining({ model: "m1", maxTokens: 600 }));
        expect(settings.getUserModelSettings).toHaveBeenCalledWith("u1", {}, { orgId: "o1" });
    });

    it("returns nothing without an owner, a model, or valid JSON", async () => {
        const summarize = modelSummarizer({} as never);
        expect(await summarize({ scan: { ...scan, user_id: null }, item })).toBeNull();
        settings.getUserModelSettings.mockResolvedValue({ tabular_model: null, last_selected_chat_model: null, api_keys: {} });
        expect(await summarize({ scan, item })).toBeNull();
        settings.getUserModelSettings.mockResolvedValue({ tabular_model: null, last_selected_chat_model: "m2", api_keys: {} });
        llm.completeText.mockResolvedValueOnce("não é json");
        expect(await summarize({ scan, item })).toBeNull();
        llm.completeText.mockResolvedValueOnce("{quebrado}");
        expect(await summarize({ scan, item })).toBeNull();
        llm.completeText.mockResolvedValueOnce('{"summary": "só resumo"}');
        expect(await summarize({ scan, item })).toBeNull();
    });

    it("checks a quote against the official text, ignoring accents and punctuation", () => {
        expect(quoteChecksOut("Serviços de ATIVOS virtuais…", "dispõe sobre serviços de ativos virtuais.")).toBe(true);
        expect(quoteChecksOut("curto", "curto demais")).toBe(false);
        expect(quoteChecksOut("algo que não está lá", "texto oficial")).toBe(false);
    });
});

describe("act identity", () => {
    it("recognises the same act written two ways", () => {
        expect(actKey("RESOLUÇÃO BCB Nº 456, DE 16 DE OUTUBRO DE 2026")).toBe(actKey("Resolução BCB n° 456"));
        expect(actKey("INSTRUÇÃO NORMATIVA BCB Nº 782")).toBe("instrucao normativa|bcb|782");
        expect(actKey("Comunicado N° 46.152")).toBe("comunicado||46152");
        expect(actKey("Despacho")).toBeNull();
    });
});

describe("job plumbing", () => {
    const job = (payload: Record<string, unknown>) => ({ payload }) as unknown as DbJob;

    it("skips a malformed job", async () => {
        expect(await handleRegulatoryScan({} as never, job({}))).toEqual({ skipped: "malformed" });
    });

    it("runs the scan named in the payload", async () => {
        const fake = scriptedDb([{ table: "regulatory_scans", data: null }]);
        expect(await handleRegulatoryScan(fake.db, job({ scanId: "s1" }))).toMatchObject({ inserted: 0 });
        fake.done();
    });

    it("queues each scan that is due, one live job per scan", async () => {
        const fake = scriptedDb([{ table: "regulatory_scans", data: [{ id: "a" }, { id: "b" }] }]);
        expect(await enqueueDueRegulatoryScans(fake.db, NOW)).toBe(2);
        expect(dbq.enqueueDbJob).toHaveBeenCalledWith(fake.db, {
            kind: "regulatory.scan",
            payload: { scanId: "a" },
            dedupeKey: "regulatory.scan:a",
            maxAttempts: 3,
        });
        expect(fake.calls[0].filters).toContainEqual(["eq", "enabled", true]);
        fake.done();
    });

    it("surfaces a sweep read error", async () => {
        const fake = scriptedDb([{ table: "regulatory_scans", error: { message: "x" } }]);
        await expect(enqueueDueRegulatoryScans(fake.db)).rejects.toEqual({ message: "x" });
    });
});
