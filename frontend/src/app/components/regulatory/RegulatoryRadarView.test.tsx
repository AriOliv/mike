import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegulatoryChange, RegulatoryScan } from "@/app/lib/mikeApi";

const nav = vi.hoisted(() => ({ params: new URLSearchParams(), replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace: nav.replace, push: nav.push }),
    useSearchParams: () => nav.params,
    usePathname: () => "/radar-regulatorio",
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({ useWorkspaceOrgId: () => "o1" }));
vi.mock("@/app/contexts/PageChromeContext", () => ({ usePageChrome: () => ({ mobileActionsContainer: null }) }));
const api = vi.hoisted(() => ({
    getRegulatoryCatalog: vi.fn(),
    listRegulatoryScans: vi.fn(),
    listRegulatoryChanges: vi.fn(),
    createRegulatoryScan: vi.fn(),
    updateRegulatoryScan: vi.fn(),
    runRegulatoryScan: vi.fn(),
    updateRegulatoryChange: vi.fn(),
    createRequestFromRegulatoryChange: vi.fn(),
    createObligationFromRegulatoryChange: vi.fn(),
}));
vi.mock("@/app/lib/mikeApi", async (actual) => ({ ...(await actual<typeof import("@/app/lib/mikeApi")>()), ...api }));
const toasts = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("@/app/components/ui/toast", async (actual) => ({
    ...(await actual<typeof import("@/app/components/ui/toast")>()),
    ...toasts,
}));
const errors = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock("@/app/lib/userFacingError", async (actual) => ({
    ...(await actual<typeof import("@/app/lib/userFacingError")>()),
    ...errors,
}));

import { RegulatoryRadarView } from "./RegulatoryRadarView";

const catalog = {
    presets: [
        { key: "bcb_pagamentos_cripto", name: "BCB — pagamentos, cripto e câmbio", description: "BCB", sources: ["bcb_normativos"], issuers: [], keywords: [], topics: ["psp"] },
        { key: "lgpd_anpd", name: "LGPD / ANPD", description: "ANPD", sources: ["dou"], issuers: [], keywords: [], topics: ["lgpd"] },
    ],
    sources: [],
    topics: [],
};

const scan = (over: Partial<RegulatoryScan> = {}): RegulatoryScan => ({
    id: "s1",
    user_id: "u1",
    org_id: "o1",
    name: "BCB — pagamentos, cripto e câmbio",
    preset: "bcb_pagamentos_cripto",
    sources: ["bcb_normativos", "dou"],
    issuers: [],
    keywords: [],
    topics: ["psp", "cripto"],
    enabled: true,
    last_run_at: new Date().toISOString(),
    last_error: null,
    created_at: "2026-10-20T00:00:00Z",
    counts: { novas: 2, abertas: 3, alto: 1 },
    ...over,
});

const change = (over: Partial<RegulatoryChange> = {}): RegulatoryChange => ({
    id: "c1",
    scan_id: "s1",
    source: "bcb_normativos",
    title: "Resolução BCB nº 999",
    act_type: "Resolução BCB",
    issuer: "Banco Central do Brasil",
    published_at: "2026-10-19",
    url: "https://www.bcb.gov.br/x",
    excerpt: "Dispõe sobre prestadoras de serviços de ativos virtuais.",
    summary: "O BCB regula as prestadoras de ativos virtuais.",
    summary_quote: "prestadoras de serviços de ativos virtuais",
    impact: "alto",
    impact_reason: 'Alta: norma (Resolução BCB) que cita "ativos virtuais" — tema cripto/VASP; 1 contrato menciona "ativos virtuais".',
    effective_date: "2027-02-02",
    topics: ["cripto"],
    matched_terms: ["ativos virtuais"],
    affected: [{ project_id: "p1", name: "MSA Exchange", counterparty: "Exchange X", term: "ativos virtuais", quote: "…presta serviços de ativos virtuais…" }],
    affected_hidden: 1,
    suggested_action: "Criar pedido para revisar o contrato afetado.",
    status: "nova",
    starred: false,
    request_project_id: null,
    obligation_id: null,
    decided_by: null,
    decided_at: null,
    created_at: "2026-10-20T00:00:00Z",
    ...over,
});

const tabs = { todas: 2, nao_lidas: 1, favoritas: 0, arquivadas: 0 };

beforeEach(() => {
    vi.clearAllMocks();
    nav.params = new URLSearchParams();
    api.getRegulatoryCatalog.mockResolvedValue(catalog);
    api.listRegulatoryScans.mockResolvedValue([scan()]);
    api.listRegulatoryChanges.mockResolvedValue({
        changes: [change(), change({ id: "c2", title: "Comunicado nº 1", impact: "baixo", status: "lida", affected: [], affected_hidden: 0, effective_date: null })],
        tabs,
    });
    api.updateRegulatoryChange.mockImplementation(async (id: string, patch: Partial<RegulatoryChange>) => change({ id, ...patch }));
});

describe("RegulatoryRadarView", () => {
    it("teaches what to watch when there is no scan, and starts one in a click", async () => {
        api.listRegulatoryScans.mockResolvedValue([]);
        api.listRegulatoryChanges.mockResolvedValue({ changes: [], tabs: { todas: 0, nao_lidas: 0, favoritas: 0, arquivadas: 0 } });
        api.createRegulatoryScan.mockResolvedValue(scan({ name: "LGPD / ANPD" }));
        render(<RegulatoryRadarView />);
        expect(await screen.findByText("Escolha o que vigiar")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: /LGPD \/ ANPD/ }));
        await waitFor(() => expect(api.createRegulatoryScan).toHaveBeenCalledWith({ preset: "lgpd_anpd", org_id: "o1" }));
        expect(toasts.showToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "success" }));
    });

    it("leads with what the scan found and orders the changes it lists", async () => {
        render(<RegulatoryRadarView />);
        expect(await screen.findByText(/encontrou 2 mudanças\./)).toBeInTheDocument();
        const rows = screen.getAllByRole("listitem");
        expect(within(rows[0]).getByText("Resolução BCB nº 999")).toBeInTheDocument();
        expect(within(rows[0]).getByText("2 contratos afetados (1 sem acesso)")).toBeInTheDocument();
        expect(within(rows[0]).getByText("Alto")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Todas (2)" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Vigiar também|LGPD/ })).toBeInTheDocument();
    });

    it("opens a change, marks it read, and shows the official citation and the contracts", async () => {
        render(<RegulatoryRadarView />);
        fireEvent.click(await screen.findByText("Resolução BCB nº 999"));
        expect(nav.replace).toHaveBeenCalledWith("?mudanca=c1", { scroll: false });
        expect(api.updateRegulatoryChange).toHaveBeenCalledWith("c1", { status: "lida" });
    });

    it("turns a change into a request and a deadline in one click each", async () => {
        nav.params = new URLSearchParams("mudanca=c1");
        api.createRequestFromRegulatoryChange.mockResolvedValue({ project_id: "pnew", change: change({ request_project_id: "pnew" }) });
        api.createObligationFromRegulatoryChange.mockResolvedValue({ obligation_id: "ob1", change: change({ obligation_id: "ob1" }) });
        render(<RegulatoryRadarView />);
        const panel = await screen.findByRole("complementary", { name: "Detalhes" });
        expect(within(panel).getByText(/O BCB regula as prestadoras/)).toBeInTheDocument();
        expect(within(panel).getByRole("link", { name: /BCB · Resolução BCB nº 999/ })).toHaveAttribute("href", "https://www.bcb.gov.br/x");
        expect(within(panel).getByText("MSA Exchange")).toBeInTheDocument();

        fireEvent.click(within(panel).getByRole("button", { name: /Criar pedido/ }));
        await waitFor(() => expect(api.createRequestFromRegulatoryChange).toHaveBeenCalledWith("c1"));
        fireEvent.click(within(panel).getByRole("button", { name: /Criar obrigação nos Prazos/ }));
        await waitFor(() => expect(api.createObligationFromRegulatoryChange).toHaveBeenCalledWith("c1", {}));
        expect(toasts.showToast).toHaveBeenCalledWith(expect.objectContaining({ message: "Vigência adicionada aos Prazos." }));
    });

    it("asks for a date when the act does not state when it takes effect", async () => {
        nav.params = new URLSearchParams("mudanca=c1");
        api.listRegulatoryChanges.mockResolvedValue({ changes: [change({ effective_date: null })], tabs });
        api.createObligationFromRegulatoryChange.mockResolvedValue({ obligation_id: "ob1", change: change() });
        render(<RegulatoryRadarView />);
        const panel = await screen.findByRole("complementary", { name: "Detalhes" });
        fireEvent.change(within(panel).getByLabelText(/O ato não diz a vigência/), { target: { value: "2026-12-01" } });
        fireEvent.click(within(panel).getByRole("button", { name: "Criar obrigação" }));
        await waitFor(() => expect(api.createObligationFromRegulatoryChange).toHaveBeenCalledWith("c1", { due_date: "2026-12-01" }));
    });

    it("triages by keyboard: s stars, e archives with undo, c requests", async () => {
        nav.params = new URLSearchParams("mudanca=c1");
        api.createRequestFromRegulatoryChange.mockResolvedValue({ project_id: "pnew", change: change({ request_project_id: "pnew" }) });
        render(<RegulatoryRadarView />);
        await screen.findByRole("complementary", { name: "Detalhes" });
        await act(async () => {
            fireEvent.keyDown(window, { key: "s" });
        });
        expect(api.updateRegulatoryChange).toHaveBeenCalledWith("c1", { starred: true });
        await act(async () => {
            fireEvent.keyDown(window, { key: "c" });
        });
        expect(api.createRequestFromRegulatoryChange).toHaveBeenCalledWith("c1");
        await act(async () => {
            fireEvent.keyDown(window, { key: "e" });
        });
        await waitFor(() => expect(api.updateRegulatoryChange).toHaveBeenCalledWith("c1", { status: "arquivada" }));
        const archived = toasts.showToast.mock.calls.find((c) => c[0].message === "Mudança arquivada.")?.[0];
        expect(archived.actions[0].label).toBe("Desfazer");
    });

    it("moves through the list with j and k", async () => {
        render(<RegulatoryRadarView />);
        await screen.findByText("Resolução BCB nº 999");
        fireEvent.keyDown(window, { key: "j" });
        expect(nav.replace).toHaveBeenLastCalledWith("?mudanca=c1", { scroll: false });
    });

    it("filters by scan and lets the scan be re-run or paused", async () => {
        api.runRegulatoryScan.mockResolvedValue({ queued: true });
        api.updateRegulatoryScan.mockResolvedValue(scan({ enabled: false }));
        render(<RegulatoryRadarView />);
        fireEvent.click(await screen.findByRole("button", { name: /3\s*BCB — pagamentos/ }));
        await waitFor(() => expect(api.listRegulatoryChanges).toHaveBeenLastCalledWith({ scanId: "s1", tab: "todas", q: undefined }));
        fireEvent.click(screen.getByRole("button", { name: /Buscar agora/ }));
        await waitFor(() => expect(api.runRegulatoryScan).toHaveBeenCalledWith("s1"));
        fireEvent.click(screen.getByRole("button", { name: /Pausar/ }));
        await waitFor(() => expect(api.updateRegulatoryScan).toHaveBeenCalledWith("s1", { enabled: false }));
    });

    it("shows a failure with a way to retry", async () => {
        api.listRegulatoryScans.mockRejectedValue(new Error("boom"));
        render(<RegulatoryRadarView />);
        expect(await screen.findByText("Não consegui carregar o radar")).toBeInTheDocument();
        api.listRegulatoryScans.mockResolvedValue([scan()]);
        fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
        expect(await screen.findByText("Resolução BCB nº 999")).toBeInTheDocument();
    });

    it("explains an empty tab and leads back to all changes", async () => {
        api.listRegulatoryChanges.mockResolvedValue({ changes: [], tabs });
        render(<RegulatoryRadarView />);
        fireEvent.click(await screen.findByRole("button", { name: "Favoritas (0)" }));
        expect(await screen.findByText("Nenhuma favorita")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Ver todas" }));
        await waitFor(() => expect(api.listRegulatoryChanges).toHaveBeenLastCalledWith({ scanId: null, tab: "todas", q: undefined }));
    });
});
