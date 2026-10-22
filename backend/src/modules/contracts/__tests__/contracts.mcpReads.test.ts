// Prazos and Perguntar over MCP: listNoticeDeadlines (read only, same access
// and workspace cut as the home screen) and the two tools on top of it and
// askAcervo. Fictional contracts only.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const access = vi.hoisted(() => ({ checkProjectAccess: vi.fn(), listAccessibleProjectIds: vi.fn() }));
vi.mock("../../../lib/access", () => access);
const acervo = vi.hoisted(() => ({ askAcervo: vi.fn() }));
vi.mock("../contracts.acervo", () => acervo);
vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn(async () => undefined) }));

import { failure, ok } from "../../../lib/serviceResult";
import { runToolForTest } from "../../mcp/__tests__/runToolForTest";
import { listNoticeDeadlines } from "../contracts.home";
import { CONTRACT_TOOLS } from "../contracts.mcp";

const NOW = new Date("2026-10-21T15:00:00Z");
const caller = { userId: "00000000-0000-4000-b000-000000000001", userEmail: "ana@exemplo.test" };
const tool = (name: string) => CONTRACT_TOOLS.find((t) => t.name === name)!;

const projects = [
    { id: "p1", org_id: "org-1", name: "SaaS — Nuvem", counterparty: "Nuvem Contábil" },
    { id: "p2", org_id: "org-1", name: "Locação — Sol", counterparty: "Imobiliária Sol" },
    { id: "p3", org_id: null, name: "NDA — Polaris", counterparty: "Polaris" },
];
const terms = [
    { project_id: "p1", notice_deadline: "2026-11-20", notice_days: 60, term_end: "2027-01-19", auto_renewal: true },
    { project_id: "p2", notice_deadline: "2026-10-25", notice_days: 30, term_end: "2026-11-24", auto_renewal: false },
    { project_id: "p3", notice_deadline: "2026-10-22", notice_days: 30, term_end: "2026-11-21", auto_renewal: true },
];

beforeEach(() => {
    access.listAccessibleProjectIds.mockReset().mockResolvedValue(["p1", "p2", "p3"]);
    acervo.askAcervo.mockReset();
    process.env.FRONTEND_URL = "https://mike.exemplo.test";
});

describe("listNoticeDeadlines", () => {
    it("lists the notice deadlines in the workspace, soonest first, without recording a visit", async () => {
        const fake = scriptedDb([
            { table: "projects", data: projects },
            { table: "contract_terms", data: terms.slice(0, 2) },
        ]);
        const r = await listNoticeDeadlines(fake.db, caller, { daysAhead: 30, workspace: "org-1" }, NOW);
        expect(r).toEqual({
            ok: true,
            data: [
                { project_id: "p2", project_name: "Locação — Sol", counterparty: "Imobiliária Sol", notice_deadline: "2026-10-25", notice_days: 30, term_end: "2026-11-24", auto_renewal: false, days_left: 4 },
                { project_id: "p1", project_name: "SaaS — Nuvem", counterparty: "Nuvem Contábil", notice_deadline: "2026-11-20", notice_days: 60, term_end: "2027-01-19", auto_renewal: true, days_left: 30 },
            ],
        });
        expect(fake.calls.map((c) => c.table)).toEqual(["projects", "contract_terms"]);
        expect(fake.calls[0].filters).toContainEqual(["is", "archived_at", null]);
        expect(fake.calls[1].filters).toContainEqual(["in", "project_id", ["p1", "p2"]]);
        fake.done();
    });

    it("cuts the window and filters by counterparty; a read failure is an internal error", async () => {
        const short = scriptedDb([
            { table: "projects", data: projects },
            { table: "contract_terms", data: terms },
        ]);
        const r = await listNoticeDeadlines(short.db, caller, { daysAhead: 5, workspace: null }, NOW);
        expect(r.ok && r.data.map((d) => d.project_id)).toEqual(["p3", "p2"]);

        const byCounterparty = scriptedDb([
            { table: "projects", data: projects },
            { table: "contract_terms", data: [terms[2]] },
        ]);
        const c = await listNoticeDeadlines(byCounterparty.db, caller, { daysAhead: 180, workspace: null, counterparty: "polaris" }, NOW);
        expect(byCounterparty.calls[1].filters).toContainEqual(["in", "project_id", ["p3"]]);
        expect(c.ok && c.data.map((d) => d.project_id)).toEqual(["p3"]);

        const broken = scriptedDb([{ table: "projects", error: { message: "down" } }]);
        expect(await listNoticeDeadlines(broken.db, caller, { daysAhead: 30, workspace: null }, NOW)).toMatchObject({ ok: false, kind: "error" });
    });
});

describe("mike_prazos_proximos", () => {
    it("passes the token's workspace and shapes the deadlines for the agent", async () => {
        const fake = scriptedDb([
            { table: "projects", data: projects },
            { table: "contract_terms", data: [terms[2]] },
        ]);
        const { result } = await runToolForTest(tool("mike_prazos_proximos"), { dias: 180 }, { db: fake.db, workspace: "personal" });
        expect(result.structuredContent).toMatchObject({
            dias: 180,
            prazos: [{ project_id: "p3", contrato: "NDA — Polaris", avisar_ate: "2026-10-22", renovacao_automatica: true, link: "https://mike.exemplo.test/projects/p3/review" }],
        });
        expect((result.content as { text: string }[])[0].text).toMatch(/^1 aviso\(s\) prévio\(s\) nos próximos 180 dias; o primeiro vence em \d+ dia\(s\) \(NDA — Polaris\)\.$/);
    });

    it("says when nothing is due, and is not for requesters", async () => {
        const fake = scriptedDb([
            { table: "projects", data: [] },
            { table: "contract_terms", data: [] },
        ]);
        const { result } = await runToolForTest(tool("mike_prazos_proximos"), {}, { db: fake.db });
        expect(result.content).toEqual([{ type: "text", text: "Nenhum aviso prévio nos próximos 30 dias." }]);
        expect(tool("mike_prazos_proximos")).toMatchObject({ scope: "prazos:read", roles: ["head", "team"] });
    });
});

describe("mike_base_perguntar", () => {
    const answer = {
        answer: "O contrato da Nuvem renova automaticamente [1].",
        found: true,
        sources: [{ n: 1, project_id: "p1", document_id: "d1", contract: "SaaS — Nuvem", ref: "12.1", quote: "renova-se automaticamente", verified: true, start_char: 1, end_char: 20 }],
        searched: 3,
        total: 3,
        matches: [],
        aggregate: false,
        coverage: { total_versions: 3, indexed_versions: 3, pending_versions: 0, failed_versions: 0, versions_needing_ocr: 0, contracts_pending: 0, contracts_not_searched: 0 },
        terms: ["renova"],
        law_available: false,
        law_sources: [],
    };

    it("asks in the token's workspace, with the filters, and cites the sources", async () => {
        acervo.askAcervo.mockResolvedValue(ok(answer));
        const { result, ctx } = await runToolForTest(tool("mike_base_perguntar"), { pergunta: "Quais contratos renovam sozinhos?", contraparte: "Nuvem" }, { workspace: "org-1" });
        expect(acervo.askAcervo).toHaveBeenCalledWith(
            ctx.db,
            ctx.caller,
            { question: "Quais contratos renovam sozinhos?", scope: { counterparty: "Nuvem", contract_type: undefined, project_ids: undefined }, include_law: false },
            "org-1",
        );
        expect(result.structuredContent).toMatchObject({
            encontrou: true,
            fontes: [{ n: 1, contrato: "SaaS — Nuvem", referencia: "12.1", trecho: "renova-se automaticamente", conferido_no_texto: true, link: "https://mike.exemplo.test/projects/p1/review" }],
            aviso: "Não substitui o parecer do Legal.",
        });
        expect((result.content as { text: string }[])[0].text).toBe(
            "O contrato da Nuvem renova automaticamente [1].\n\n(1 fonte(s); 3 de 3 contrato(s) lidos. Não substitui o parecer do Legal.)",
        );
    });

    it("asks the whole base when unfiltered, and says when it found nothing or had nothing to read", async () => {
        acervo.askAcervo.mockResolvedValueOnce(ok({ ...answer, found: false, sources: [] }));
        const miss = await runToolForTest(tool("mike_base_perguntar"), { pergunta: "Há cláusula de arbitragem?" });
        expect(acervo.askAcervo.mock.calls[0][2]).toMatchObject({ scope: "todos" });
        expect(miss.result.content).toEqual([{ type: "text", text: "Não encontrei a resposta nos 3 contrato(s) lidos de 3." }]);
        acervo.askAcervo.mockResolvedValueOnce(ok({ ...answer, total: 0, searched: 0 }));
        expect((await runToolForTest(tool("mike_base_perguntar"), { pergunta: "Algo?" })).result.content).toEqual([{ type: "text", text: "Nenhum contrato no escopo para responder." }]);
        acervo.askAcervo.mockResolvedValueOnce(failure("validation", "Escreva uma pergunta."));
        expect((await runToolForTest(tool("mike_base_perguntar"), { pergunta: "   " })).result).toMatchObject({ structuredContent: { error: { code: "invalid_input" } } });
    });
});
