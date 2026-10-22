import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";

type Call = { table: string; filters: unknown[][] };
function fakeDb(answers: Record<string, { data?: unknown; error?: unknown }>) {
    const calls: Call[] = [];
    const from = (table: string) => {
        const call: Call = { table, filters: [] };
        const builder: Record<string, unknown> = {
            select: () => builder,
            then: (resolve: (v: unknown) => unknown) => {
                calls.push(call);
                const answer = answers[table] ?? {};
                return Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null }).then(resolve);
            },
        };
        for (const filter of ["eq", "is", "in", "not"])
            builder[filter] = (...args: unknown[]) => {
                call.filters.push([filter, ...args]);
                return builder;
            };
        return builder;
    };
    return { db: { from } as unknown as Db, calls };
}

const access = vi.hoisted(() => ({ listAccessibleProjectIds: vi.fn() }));
vi.mock("../../../lib/access", () => access);

import { listContractPortfolio } from "../contractReview.service";

const caller = { userId: "u1", userEmail: "duda@avenia.io" };
const field = (value: unknown, status = "encontrado", state = "pendente") => ({
    status,
    value,
    citations: [],
    confidence: "alta",
    origin: "ia",
    notes: null,
    review: { state, by: null, at: null, comment: null },
});

const PROJECTS = [
    { id: "p2", name: "SaaS — Nuvem", counterparty: "Nuvem", contract_type: "saas", lane: "revisao" },
    { id: "p1", name: "Aditivo — Delta", counterparty: "Delta", contract_type: "aditivo", lane: "arquivado" },
    { id: "p3", name: "Locação — Sol", counterparty: "Sol", contract_type: "locacao", lane: "arquivado" },
];

beforeEach(() => {
    access.listAccessibleProjectIds.mockReset();
    access.listAccessibleProjectIds.mockResolvedValue(["p1", "p2", "p3"]);
});

describe("listContractPortfolio", () => {
    it("lists one row per contract the caller can open, with the Ficha's numbers and dates", async () => {
        const fake = fakeDb({
            projects: { data: PROJECTS },
            contract_fichas: {
                data: [
                    {
                        project_id: "p2",
                        risk_overall: "atencao",
                        ficha: {
                            "vigencia.renovacao": field({ tipo: "automatica", aviso_nao_renovacao: { amount: 30, unit: "dias", day_count: "corridos" } }, "encontrado", "confirmado"),
                            "foro.lei_aplicavel": field({ jurisdicao: "BR" }),
                            "regulatorio.confidencialidade": field(null, "nao_encontrado"),
                        },
                    },
                    {
                        project_id: "p1",
                        risk_overall: "ok",
                        ficha: {
                            "rescisao.imotivada": field({ permitida_para: "ambas", aviso_previo_avenia: { amount: 2, unit: "meses", day_count: "nao_especificado" } }, "inferido"),
                        },
                    },
                ],
            },
            contract_terms: {
                data: [
                    { project_id: "p2", term_end: "2027-03-01", notice_days: 45, notice_deadline: "2027-01-30" },
                    { project_id: "p3", term_end: "2026-12-31", notice_days: 90, notice_deadline: "2026-10-02" },
                ],
            },
        });
        const result = await listContractPortfolio(fake.db, caller, {});
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.total).toBe(3);
        expect(result.data.next_offset).toBeNull();
        expect(result.data.rows.map((r) => r.project_id)).toEqual(["p1", "p3", "p2"]);
        expect(result.data.rows[2]).toEqual({
            project_id: "p2",
            name: "SaaS — Nuvem",
            counterparty: "Nuvem",
            contract_type: "saas",
            lane: "revisao",
            term_end: "2027-03-01",
            // The Ficha's literal reading wins over the older terms extraction.
            notice_days: 30,
            notice_deadline: "2027-01-30",
            filled: 2,
            verified: 1,
            total: 3,
            risk: "atencao",
        });
        expect(result.data.rows[0]).toMatchObject({ notice_days: 60, filled: 1, total: 1, term_end: null });
        // No Ficha: the terms' notice stands and the counts are zero.
        expect(result.data.rows[1]).toMatchObject({ notice_days: 90, filled: 0, verified: 0, total: 0, risk: null });
        const projects = fake.calls.find((c) => c.table === "projects")!;
        expect(projects.filters).toContainEqual(["in", "id", ["p1", "p2", "p3"]]);
        expect(projects.filters).toContainEqual(["not", "lane", "is", null]);
    });

    it("sorts by the nearest notice deadline and pages", async () => {
        const fake = fakeDb({
            projects: { data: PROJECTS },
            contract_fichas: { data: [] },
            contract_terms: {
                data: [
                    { project_id: "p2", term_end: null, notice_days: null, notice_deadline: "2027-01-30" },
                    { project_id: "p3", term_end: null, notice_days: null, notice_deadline: "2026-10-02" },
                ],
            },
        });
        const first = await listContractPortfolio(fake.db, caller, { sort: "aviso", limit: "2" });
        expect(first.ok && first.data.rows.map((r) => r.project_id)).toEqual(["p3", "p2"]);
        expect(first.ok && first.data.next_offset).toBe(2);
        const second = await listContractPortfolio(fake.db, caller, { sort: "aviso", limit: "2", offset: "2" });
        expect(second.ok && second.data.rows.map((r) => r.project_id)).toEqual(["p1"]);
    });

    it("returns nothing for a caller with no contracts, and refuses a malformed page", async () => {
        access.listAccessibleProjectIds.mockResolvedValueOnce([]);
        expect(await listContractPortfolio(fakeDb({}).db, caller, {})).toEqual({ ok: true, data: { rows: [], total: 0, next_offset: null } });
        for (const query of [{ limit: "0" }, { limit: "101" }, { offset: "-1" }, { sort: "valor" }, { limit: "x" }])
            expect(await listContractPortfolio(fakeDb({}).db, caller, query)).toMatchObject({ ok: false, kind: "validation" });
    });

    it("hides database errors", async () => {
        const result = await listContractPortfolio(fakeDb({ projects: { error: { message: "relation missing" } } }).db, caller, {});
        expect(result).toMatchObject({ ok: false, kind: "error" });
    });

    it("narrows to one workspace when asked, the cut the home screen counts in", async () => {
        const projects = [
            { ...PROJECTS[0], org_id: "org-a" },
            { ...PROJECTS[1], org_id: null },
            { ...PROJECTS[2], org_id: "org-b" },
        ];
        const ids = async (workspace: string | null) => {
            const fake = fakeDb({ projects: { data: projects }, contract_fichas: { data: [] }, contract_terms: { data: [] } });
            const r = await listContractPortfolio(fake.db, caller, {}, workspace);
            return r.ok ? r.data.rows.map((row) => row.project_id) : r;
        };
        expect(await ids(null)).toEqual(["p1", "p3", "p2"]);
        expect(await ids("org-a")).toEqual(["p2"]);
        expect(await ids("personal")).toEqual(["p1"]);
    });
});
