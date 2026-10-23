import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeReview, HomeSummary } from "@/app/lib/mikeApi";

const nav = vi.hoisted(() => {
    const replace = vi.fn();
    const push = vi.fn();
    // One router for every render, as Next's is: a new object each time would
    // re-create HomeView's load() and re-run its first fetch mid-test.
    return { params: new URLSearchParams(), replace, push, router: { replace, push } };
});
vi.mock("next/navigation", () => ({
    useRouter: () => nav.router,
    useSearchParams: () => nav.params,
    usePathname: () => "/inicio",
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "u", email: "duda@avenia.io" } }),
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
    useWorkspace: () => ({ activeOrganization: null, workspaceId: "personal" }),
}));
vi.mock("@/app/contexts/PageChromeContext", () => ({ usePageChrome: () => ({ mobileActionsContainer: null }) }));
const api = vi.hoisted(() => ({
    getHomeSummary: vi.fn(),
    getCardActivity: vi.fn(),
    updateContractReview: vi.fn(),
    requestContractReview: vi.fn(),
    listWatchedFolders: vi.fn(),
    listPlaybooks: vi.fn(),
    getProjectPeople: vi.fn(),
}));
vi.mock("@/app/lib/mikeApi", async (actual) => ({
    ...(await actual<typeof import("@/app/lib/mikeApi")>()),
    ...api,
}));
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

import { HomeView } from "./HomeView";

function review(overrides: Partial<HomeReview>): HomeReview {
    return {
        id: "r1",
        project_id: "p1",
        project_name: "NDA Polaris",
        counterparty: "Polaris Tecnologia",
        lane: "revisao",
        document_id: "d1",
        filename: "NDA Polaris.docx",
        status: "ready",
        step: null,
        aligned: 8,
        needs_review: 6,
        deviates: 3,
        summary: "Vigência perpétua sem direito de rescisão (cl. 9). Foro em Manaus.",
        error: null,
        assignee_email: "duda@avenia.io",
        playbook_id: "pb1",
        playbook_run_id: "run1",
        watched_folder_id: "f1",
        requester_name: "Ana",
        deadline: "2026-10-24",
        notice_deadline: "2026-11-01",
        notice_days: 61,
        term_end: "2027-01-01",
        ficha: { verified: 14, total: 24 },
        suggested_assignee: null,
        assignee_name: null,
        request: { id: "req-1", code: "LEG-0142" },
        updated_at: new Date().toISOString(),
        ...overrides,
    };
}

function summary(reviews: HomeReview[], extra: Partial<HomeSummary> = {}): HomeSummary {
    return {
        since: "2026-10-19T09:00:00Z",
        greeting: { reviewed: reviews.length, reviewed_90d: reviews.length + 3, failed: 0, notices_closing: 1, ready: 1 },
        counters: { ready: 1, mine: 1, notices_30d: 1, folders: 1 },
        reviews,
        deadlines: [
            {
                project_id: "p1",
                project_name: "NDA Polaris",
                counterparty: "Polaris",
                notice_deadline: "2026-11-01",
                notice_days: 61,
                term_end: "2027-01-01",
                auto_renewal: true,
                days_left: 12,
            },
        ],
        activity: [
            {
                id: 1,
                project_id: "p1",
                project_name: "NDA Polaris",
                at: new Date().toISOString(),
                actor_type: "agent",
                actor_id: "agent:revisor@1",
                actor_name: "Agente de revisão",
                action: "review.completed",
                after: { document: "NDA Polaris.docx", sources: 3 },
            },
        ],
        ...extra,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    nav.params = new URLSearchParams();
    api.getCardActivity.mockResolvedValue([]);
    api.listWatchedFolders.mockResolvedValue([]);
    api.listPlaybooks.mockResolvedValue([]);
    api.getProjectPeople.mockResolvedValue({
        owner: { user_id: "u", email: "duda@avenia.io", display_name: "Duda" },
        members: [{ email: "Ana@avenia.io", display_name: "Ana" }, { email: "duda@avenia.io", display_name: null }],
    });
});

describe("HomeView", () => {
    it("sends a requester to their requests and never shows the team's queue", async () => {
        api.getHomeSummary.mockResolvedValue(summary([], { audience: "requester", deadlines: [], activity: [] }));
        render(<HomeView />);
        await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/pedidos"));
        expect(screen.queryByText(/Revisei|Não revisei|Ainda não revisei/)).not.toBeInTheDocument();
        expect(screen.queryByRole("table")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Enviar contratos/ })).not.toBeInTheDocument();
    });

    it("keeps the head on the Início with the queue", async () => {
        api.getHomeSummary.mockResolvedValue(summary([review({})], { audience: "team" }));
        render(<HomeView />);
        expect(await screen.findByText(/Revisei/)).toBeInTheDocument();
        expect(nav.replace).not.toHaveBeenCalledWith("/pedidos");
    });

    it("greets with what the agents did, the counters and the queue, opening on my reviews", async () => {
        api.getHomeSummary.mockResolvedValue(
            summary([
                review({ assignee_email: "Duda@Avenia.io", assignee_name: "Duda Lima" }),
                review({ id: "r2", project_id: "p2", filename: "MSA.pdf", counterparty: null, assignee_email: null, status: "running", step: "playbook" }),
                review({ id: "r3", project_id: "p3", filename: "Nimbus.pdf", assignee_email: null, suggested_assignee: "Ana" }),
            ]),
        );
        render(<HomeView />);
        await waitFor(() => expect(api.getHomeSummary).toHaveBeenCalledWith("personal"));
        expect(await screen.findByText(/Revisei 6 contratos nos últimos 90 dias, 3 novos desde sua última visita/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Prontos p\/ revisar/ })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Avisos em 30 dias/ })).toHaveTextContent("o mais próximo em 12 dias");
        expect(screen.getByText("1", { selector: "span.text-amber-700" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Minhas revisões (1)" })).toHaveAttribute("aria-pressed", "true");
        const list = screen.getByRole("list", { name: "Revisões" });
        expect(within(list).getAllByRole("listitem")).toHaveLength(1);
        // The owner by profile name, not the local part of the e-mail.
        expect(within(list).getByText("Duda Lima")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Todas (3)" }));
        // The running row shows its step in the status and in the summary column.
        expect(within(list).getAllByText("Comparando com o playbook…")).toHaveLength(2);
        expect(within(list).getByText("Contraparte não informada")).toBeInTheDocument();
        expect(within(list).getByText("Sem responsável")).toBeInTheDocument();
        expect(within(list).getByText("sugerido: Ana")).toBeInTheDocument();
        // Prazos de aviso block and the shared activity feed.
        expect(screen.getByText("avisar até 01/11/2026 · renova sozinho")).toBeInTheDocument();
        expect(screen.getAllByText(/Agente de revisão revisou NDA Polaris.docx com 3 fontes/).length).toBeGreaterThan(0);
    });

    describe("a long queue", () => {
        // The queue is sorted most recently updated first. Each review gets its own fixed time,
        // r1 the newest, so the order is the one written here and never depends on the clock or
        // on how fast the fixtures were built (they used to share "now" and tie).
        const many = (n: number) =>
            Array.from({ length: n }, (_, i) =>
                review({
                    id: `r${i + 1}`,
                    project_id: `p${i + 1}`,
                    filename: `Contrato ${String(i + 1).padStart(2, "0")}.pdf`,
                    assignee_email: "duda@avenia.io",
                    updated_at: new Date(Date.UTC(2026, 9, 20, 12, 0, 0) - i * 60_000).toISOString(),
                }),
            );

        it("draws only the first rows and says how many there are, with the way to the rest", async () => {
            api.getHomeSummary.mockResolvedValue(summary(many(21)));
            render(<HomeView />);
            // Wait for the settled state, not just the first row: the tab, the count and
            // the link all follow the same load, and under CI load they land a tick apart.
            expect(await screen.findByText(/Mostrando 8 de 21\./)).toBeInTheDocument();
            const list = screen.getByRole("list", { name: "Revisões" });
            await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(8));
            // Only inside the table: the same name can appear elsewhere on the page (the greeting,
            // the activity), and this is about what the table draws.
            expect(within(list).queryByText("Contrato 09.pdf")).not.toBeInTheDocument();
            expect(within(list).getByText("Contrato 08.pdf")).toBeInTheDocument();
            expect(await screen.findByRole("link", { name: "Ver todos os contratos (21)" })).toHaveAttribute("href", "/contratos");
        });

        it("keeps the notice deadlines and the activity after the table in the page, not over it", async () => {
            api.getHomeSummary.mockResolvedValue(summary(many(25)));
            render(<HomeView />);
            await screen.findByText("Contrato 01.pdf");
            // The deadlines section is drawn by the same load; wait for it instead of assuming it.
            const table = await screen.findByRole("region", { name: "Revisões" });
            const deadlines = await screen.findByRole("region", { name: "Prazos de aviso" });
            // Both sections are in normal flow: nothing is absolutely placed or sticky, and the
            // table's box has a ceiling and clips what is inside it.
            expect(table.compareDocumentPosition(deadlines) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
            for (const el of [table, deadlines]) {
                expect(el.className).not.toMatch(/\b(absolute|fixed|sticky)\b/);
            }
            const box = within(table).getByRole("list", { name: "Revisões" }).closest("div[class*='max-h']");
            expect(box).not.toBeNull();
            expect(box!.className).toMatch(/overflow-hidden/);
            expect(box!.className).toMatch(/max-h-\[min\(30rem,65vh\)\]/);
        });

        it("says nothing about the rest when the queue fits", async () => {
            api.getHomeSummary.mockResolvedValue(summary(many(8)));
            render(<HomeView />);
            await screen.findByText("Contrato 08.pdf");
            expect(screen.queryByText(/Mostrando/)).not.toBeInTheDocument();
            expect(screen.queryByRole("link", { name: /Ver todos os contratos/ })).not.toBeInTheDocument();
        });

        it("counts the whole queue in the tabs and keeps j/k and the search on all of it", async () => {
            api.getHomeSummary.mockResolvedValue(summary(many(21)));
            render(<HomeView />);
            // The tab count and the first row come from the same load; wait for both, not one.
            const all = await screen.findByRole("button", { name: "Todas (21)" });
            await screen.findByText("Contrato 01.pdf");
            fireEvent.click(all);
            fireEvent.change(await screen.findByLabelText("Buscar revisões"), { target: { value: "Contrato 20" } });
            expect(await screen.findByText("Contrato 20.pdf")).toBeInTheDocument();
            // The search narrows the queue to what fits, so the "Mostrando" line goes away.
            await waitFor(() => expect(screen.queryByText(/Mostrando/)).not.toBeInTheDocument());
        });
    });

    it("filters the queue by a counter and clears it from the empty state", async () => {
        api.getHomeSummary.mockResolvedValue(summary([review({ assignee_email: null })]));
        render(<HomeView />);
        await screen.findByText(/Revisei/);
        fireEvent.click(screen.getByRole("button", { name: /Pastas monitoradas/ }));
        expect(screen.getByRole("list", { name: "Revisões" })).toHaveTextContent("NDA Polaris.docx");
        fireEvent.change(screen.getByRole("searchbox", { name: "Buscar revisões" }), { target: { value: "zzz" } });
        expect(await screen.findByText("Nada neste filtro")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Ver todas" }));
        expect(screen.getByRole("list", { name: "Revisões" })).toHaveTextContent("NDA Polaris.docx");
    });

    it("teaches the first step when nothing was reviewed", async () => {
        api.getHomeSummary.mockResolvedValue(summary([], { deadlines: [], activity: [], greeting: { reviewed: 0, reviewed_90d: 0, failed: 0, notices_closing: 0, ready: 0 } }));
        render(<HomeView />);
        expect(await screen.findByText("Ainda não revisei nenhum contrato.")).toBeInTheDocument();
        expect(screen.getByText("Nenhum contrato revisado ainda")).toBeInTheDocument();
        fireEvent.click(screen.getAllByRole("button", { name: /Enviar contratos/ }).at(-1)!);
        expect(await screen.findByRole("dialog", { name: "Enviar contratos" })).toBeInTheDocument();
    });

    it("shows a retryable error instead of an empty screen", async () => {
        api.getHomeSummary.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(summary([review({})]));
        render(<HomeView />);
        expect(await screen.findByText("Não consegui carregar o Início")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
        expect(await screen.findByText(/Revisei/)).toBeInTheDocument();
    });

    it("opens the panel from ?doc=, accepts with undo, assigns and moves with j/k", async () => {
        nav.params = new URLSearchParams("doc=r1");
        api.getHomeSummary.mockResolvedValue(
            summary([review({}), review({ id: "r2", project_id: "p2", filename: "MSA.pdf", assignee_email: "duda@avenia.io" })]),
        );
        api.updateContractReview.mockResolvedValue({});
        render(<HomeView />);
        const panel = await screen.findByRole("complementary", { name: "Detalhes" });
        expect(within(panel).getByText(/Vigência perpétua sem direito de rescisão/)).toBeInTheDocument();
        expect(within(panel).getByRole("button", { name: "Ver a cláusula 9 na revisão" })).toBeInTheDocument();
        expect(within(panel).getByRole("link", { name: "14/24 verificados" })).toHaveAttribute("href", "/projects/p1");
        expect(within(panel).getByRole("link", { name: "LEG-0142" })).toHaveAttribute("href", "/pedidos?pedido=req-1");
        expect(within(panel).getByText("de Ana")).toBeInTheDocument();
        expect(within(panel).getByText("Revisão")).toBeInTheDocument();
        fireEvent.click(within(panel).getByRole("button", { name: "3 divergem: filtrar" }));
        expect(nav.push).toHaveBeenLastCalledWith("/projects/p1/review?run=run1&veredito=diverge");
        expect(within(panel).getByRole("link", { name: /Abrir revisão/ })).toHaveAttribute(
            "href",
            "/projects/p1/review?run=run1",
        );

        fireEvent.click(within(panel).getByRole("button", { name: /Aceitar revisão/ }));
        await waitFor(() => expect(api.updateContractReview).toHaveBeenCalledWith("r1", { status: "done" }));
        const toast = toasts.showToast.mock.calls[0][0];
        expect(toast.message).toBe("Revisão aceita.");
        await act(async () => toast.actions[0].onClick());
        expect(api.updateContractReview).toHaveBeenCalledWith("r1", { status: "ready" });

        const owner = within(panel).getByRole("combobox", { name: "Responsável" });
        await waitFor(() => expect(owner).toBeEnabled());
        expect(within(owner).getAllByRole("option").map((o) => o.textContent)).toEqual([
            "Sem responsável",
            "Duda (você)",
            "Ana",
        ]);
        fireEvent.change(owner, { target: { value: "ana@avenia.io" } });
        await waitFor(() =>
            expect(api.updateContractReview).toHaveBeenCalledWith("r1", { assignee_email: "ana@avenia.io" }),
        );
        const assigned = toasts.showToast.mock.calls.at(-1)![0];
        expect(assigned.message).toBe("Atribuído a ana.");
        await act(async () => assigned.actions[0].onClick());
        expect(api.updateContractReview).toHaveBeenLastCalledWith("r1", { assignee_email: "duda@avenia.io" });

        // The shortcuts read the list through a ref that an effect refreshes after the accept and
        // the assign above; under CI load the key can land a tick before it, so wait for the result.
        fireEvent.keyDown(window, { key: "j" });
        await waitFor(() => expect(nav.replace).toHaveBeenLastCalledWith("?doc=r2", { scroll: false }));
        fireEvent.keyDown(window, { key: "Escape" });
        await waitFor(() => expect(nav.replace).toHaveBeenLastCalledWith("/", { scroll: false }));
    });

    it("retries a failed review and reports a failed accept", async () => {
        nav.params = new URLSearchParams("doc=r1");
        api.getHomeSummary.mockResolvedValue(
            summary([review({ status: "failed", error: "Não consegui ler este contrato. Tente de novo." })]),
        );
        api.requestContractReview.mockResolvedValue({ review_id: "r1", queued: true });
        render(<HomeView />);
        const panel = await screen.findByRole("complementary", { name: "Detalhes" });
        expect(within(panel).getByText("Não consegui ler este contrato. Tente de novo.")).toBeInTheDocument();
        fireEvent.click(within(panel).getByRole("button", { name: /Tentar de novo/ }));
        await waitFor(() => expect(api.requestContractReview).toHaveBeenCalledWith("p1"));
    });

    it("rolls back an accept the server refused", async () => {
        nav.params = new URLSearchParams("doc=r1");
        api.getHomeSummary.mockResolvedValue(summary([review({ assignee_email: null })]));
        api.updateContractReview.mockRejectedValue(new Error("nope"));
        render(<HomeView />);
        const panel = await screen.findByRole("complementary", { name: "Detalhes" });
        fireEvent.click(within(panel).getByRole("button", { name: /Aceitar revisão/ }));
        await waitFor(() =>
            expect(errors.notifyError).toHaveBeenCalledWith(expect.anything(), { lang: "pt", action: "aceitar a revisão" }),
        );
        expect(within(panel).getByRole("button", { name: /Aceitar revisão/ })).toBeInTheDocument();
        fireEvent.click(within(panel).getByRole("button", { name: "assumir" }));
        await waitFor(() =>
            expect(errors.notifyError).toHaveBeenCalledWith(expect.anything(), { lang: "pt", action: "atribuir a revisão" }),
        );
    });

    it("keeps the queue on screen when a refresh fails, and says so once", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            api.getHomeSummary
                .mockResolvedValueOnce(summary([review({ status: "running", step: "ficha" })]))
                .mockRejectedValue(new Error("down"));
            render(<HomeView />);
            expect(await screen.findByText(/Revisei/)).toBeInTheDocument();
            await act(async () => {
                await vi.advanceTimersByTimeAsync(5_100);
            });
            await waitFor(() =>
                expect(errors.notifyError).toHaveBeenCalledWith(expect.anything(), {
                    lang: "pt",
                    action: "atualizar o Início",
                    dedupeKey: "home-refresh",
                }),
            );
            expect(screen.queryByText("Não consegui carregar o Início")).toBeNull();
            expect(screen.getByRole("list", { name: "Revisões" })).toHaveTextContent("NDA Polaris.docx");
        } finally {
            vi.useRealTimers();
        }
    });

    it("accepts with a and reviews again with r, but not while typing or sending", async () => {
        nav.params = new URLSearchParams("doc=r1");
        api.getHomeSummary.mockResolvedValue(summary([review({})]));
        api.updateContractReview.mockResolvedValue({});
        api.requestContractReview.mockResolvedValue({ review_id: "r1", queued: true });
        render(<HomeView />);
        await screen.findByRole("complementary", { name: "Detalhes" });

        const editable = document.createElement("div");
        editable.contentEditable = "true";
        Object.defineProperty(editable, "isContentEditable", { value: true });
        document.body.appendChild(editable);
        fireEvent.keyDown(editable, { key: "a" });
        expect(api.updateContractReview).not.toHaveBeenCalled();

        fireEvent.keyDown(window, { key: "a" });
        await waitFor(() => expect(api.updateContractReview).toHaveBeenCalledWith("r1", { status: "done" }));

        fireEvent.click(screen.getAllByRole("button", { name: /Enviar contratos/ })[0]);
        await screen.findByRole("dialog", { name: "Enviar contratos" });
        fireEvent.keyDown(window, { key: "r" });
        expect(api.requestContractReview).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

        fireEvent.keyDown(window, { key: "r" });
        await waitFor(() => expect(api.requestContractReview).toHaveBeenCalledWith("p1"));
        editable.remove();
    });

    it("opens the latest review of a contract with no playbook run", async () => {
        nav.params = new URLSearchParams("doc=r1");
        api.getHomeSummary.mockResolvedValue(summary([review({ playbook_id: null, playbook_run_id: null })]));
        render(<HomeView />);
        const panel = await screen.findByRole("complementary", { name: "Detalhes" });
        expect(within(panel).getByRole("link", { name: /Abrir revisão/ })).toHaveAttribute("href", "/projects/p1/review");
    });

    it("retries a failed review from its row", async () => {
        api.getHomeSummary.mockResolvedValue(summary([review({ status: "failed" })]));
        api.requestContractReview.mockRejectedValue(new Error("nope"));
        render(<HomeView />);
        fireEvent.click(await screen.findByRole("button", { name: "Tentar de novo: NDA Polaris.docx" }));
        await waitFor(() =>
            expect(errors.notifyError).toHaveBeenCalledWith(expect.anything(), { lang: "pt", action: "revisar de novo" }),
        );
        expect(nav.replace).not.toHaveBeenCalled();
    });
});
