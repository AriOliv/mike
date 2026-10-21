import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContractFicha, ContractReview, ReviewClause } from "@/app/lib/mikeApi";

const api = vi.hoisted(() => ({
    listContractReviews: vi.fn(),
    getContractReview: vi.fn(),
    startContractReview: vi.fn(),
    decideReviewClause: vi.fn(),
    getContractFicha: vi.fn(),
    extractContractFicha: vi.fn(),
    decideFichaField: vi.fn(),
    getDocumentFile: vi.fn(),
    getCardActivity: vi.fn(),
}));
const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push, replace: vi.fn() }) }));
vi.mock("@/app/lib/mikeApi", async (original) => ({
    ...(await original<typeof import("@/app/lib/mikeApi")>()),
    ...api,
}));
const viewer = vi.hoisted(() => ({ docx: vi.fn() }));
// The real viewer lazy-loads a Word renderer that jsdom cannot run.
vi.mock("@/app/components/shared/views/DocxView", () => ({
    DocxView: (props: { documentId: string; quotes?: { quote: string }[] }) => {
        viewer.docx(props);
        return <div role="document" aria-label={`Documento ${props.documentId}`} />;
    },
}));
const toasts = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("@/shared/ui/ToastUI", async (original) => ({
    ...(await original<typeof import("@/shared/ui/ToastUI")>()),
    showToast: toasts.showToast,
}));
const errors = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock("@/app/lib/userFacingError", async (original) => ({
    ...(await original<typeof import("@/app/lib/userFacingError")>()),
    notifyError: errors.notifyError,
}));

import { ContractReviewWorkspace } from "./ContractReviewWorkspace";

function clause(id: string, verdict: ReviewClause["verdict"], extra: Partial<ReviewClause> = {}): ReviewClause {
    return {
        id,
        topicId: "t",
        ruleId: id,
        ruleName: `Regra ${id}`,
        status: "needs_review",
        quote: `trecho ${id}`,
        location: `Cláusula ${id}`,
        analysis: `Avaliação ${id}`,
        suggestedText: `nova redação ${id}`,
        verdict,
        playbook_status: "needs_review",
        covered: true,
        sources: [{ kind: "playbook", label: "x", position: `Posição ${id}`, criteria: "" }],
        rule_findings: [],
        precedent: null,
        decision: null,
        ...extra,
    };
}

const REVIEW: ContractReview = {
    id: "run-1",
    status: "completed",
    error: null,
    summary: "Dois pontos divergem do playbook.",
    started_at: "2026-10-20T10:00:00Z",
    completed_at: "2026-10-20T10:01:00Z",
    model: "m",
    playbook: { id: "pb", name: "Playbook Avenia v1" },
    document: { id: "doc-1", name: "Contrato.docx", edited_version_id: "v2" },
    clauses: [
        clause("cessao", "alinhado", { status: "acceptable", playbook_status: "acceptable" }),
        clause("foro", "diverge", {
            precedent: { same: 2, of: 3, projects: [{ id: "p9", name: "MSA Trópico" }] },
            sources: [
                { kind: "playbook", label: "Foro", position: "Lei brasileira e foro de São Paulo", criteria: "" },
                { kind: "regra", rule_id: "FOR-01", label: "Lei estrangeira", severity: "media", pending_validation: true },
                { kind: "ficha", path: "foro.lei_aplicavel", label: "Lei aplicável", state: "pendente", quote: "q" },
            ],
        }),
        clause("extra", "nao_aplica", { covered: false, suggestedText: "" }),
    ],
    uncovered: [{ rule_id: "REG-08", titulo: "Exclusividade", severidade: "alta", justificativa: "", acao_sugerida: "", campos: [], depende_de_campo_nao_validado: true }],
};

const FICHA: ContractFicha = {
    ficha: {
        "foro.lei_aplicavel": {
            status: "encontrado",
            value: { jurisdicao: "US" },
            citations: [{ quote: "leis de Nova York", clause: "cl. 20", span: null, verified: true, match: "exato" }],
            confidence: "alta",
            origin: "ia",
            notes: null,
            review: { state: "pendente", by: null, at: null, comment: null },
        },
    },
    choices: { "foro.lei_aplicavel": null, "dados_pessoais.compartilhamento": "boolean" },
    findings: [],
    risk_overall: "atencao",
    progress: { verified: 0, total: 1 },
    document_id: "doc-1",
    extracted_at: "t",
    model: "m",
};

const props = () => ({ projectId: "p1", projectName: "MSA Polaris", canEdit: true, onShare: vi.fn() });

beforeEach(() => {
    api.listContractReviews.mockResolvedValue([
        { id: "run-1", status: "completed", started_at: "2026-10-20T10:00:00Z", playbook_name: "Playbook Avenia v1", counts: { alinhado: 1, precisa_revisao: 0, diverge: 1 } },
    ]);
    api.getContractReview.mockResolvedValue(REVIEW);
    api.getContractFicha.mockResolvedValue(FICHA);
    api.decideReviewClause.mockResolvedValue({ decision: null, edit: null });
    api.getCardActivity.mockResolvedValue([]);
});

afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
});

describe("ContractReviewWorkspace", () => {
    it("shows the document beside the first review, most urgent first, with its sources", async () => {
        render(<ContractReviewWorkspace {...props()} />);
        expect(await screen.findByRole("document", { name: "Documento doc-1" })).toBeInTheDocument();
        const cards = await screen.findAllByRole("article");
        expect(cards.map((card) => within(card).getAllByRole("button")[0].textContent)).toEqual([
            "Cláusula foro · Regra foro",
            "Cláusula cessao · Regra cessao",
            "Cláusula extra · Regra extra",
        ]);
        const foro = cards[0];
        expect(within(foro).getByText("Diverge")).toBeInTheDocument();
        expect(within(foro).getByText(/Lei brasileira e foro de São Paulo/)).toBeInTheDocument();
        expect(within(foro).getByText("Lei estrangeira")).toBeInTheDocument();
        expect(within(foro).queryByText(/FOR-01/)).toBeNull();
        expect(within(foro).getByRole("button", { name: "Ver o trecho no documento" })).toBeInTheDocument();
        expect(within(foro).getByText(/a confirmar na Ficha/)).toBeInTheDocument();
        expect(within(foro).getByText(/Igual a 2 de 3 contratos assinados/)).toBeInTheDocument();
        expect(within(foro).getByRole("link", { name: "MSA Trópico" })).toHaveAttribute("href", "/projects/p9/review");
        expect(within(cards[2]).getByText(/Sem regra no playbook para este ponto/)).toBeInTheDocument();
        expect(screen.getByText("Exclusividade")).toBeInTheDocument();
        expect(screen.queryByText("REG-08")).toBeNull();
        expect(screen.getByRole("button", { name: "1 diverge: filtrar" })).toBeInTheDocument();
    });

    it("opens the run and filter from the URL and keeps the URL in step", async () => {
        const onUrlStateChange = vi.fn();
        render(<ContractReviewWorkspace {...props()} initialRunId="run-1" initialVerdict="diverge" onUrlStateChange={onUrlStateChange} />);
        await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
        expect(screen.getByRole("button", { name: "1 diverge: filtrar" })).toHaveAttribute("aria-pressed", "true");
        fireEvent.click(screen.getByRole("button", { name: "1 diverge: filtrar" }));
        await waitFor(() => expect(onUrlStateChange).toHaveBeenLastCalledWith({ runId: "run-1", filter: null }));
    });

    it("falls back to the newest review when the linked one is not this contract's", async () => {
        const onUrlStateChange = vi.fn();
        render(<ContractReviewWorkspace {...props()} initialRunId="de-outro" onUrlStateChange={onUrlStateChange} />);
        await screen.findAllByRole("article");
        await waitFor(() => expect(onUrlStateChange).toHaveBeenLastCalledWith({ runId: "run-1", filter: null }));
        expect(api.getContractReview).toHaveBeenLastCalledWith("p1", "run-1");
    });

    it("filters by the traffic light", async () => {
        render(<ContractReviewWorkspace {...props()} />);
        fireEvent.click(await screen.findByRole("button", { name: "1 alinhado: filtrar" }));
        expect(screen.getAllByRole("article")).toHaveLength(1);
        fireEvent.click(screen.getByRole("button", { name: "1 alinhado: filtrar" }));
        expect(screen.getAllByRole("article")).toHaveLength(3);
    });

    it("shows the clause in the document when its title is clicked", async () => {
        render(<ContractReviewWorkspace {...props()} />);
        fireEvent.click(await screen.findByRole("button", { name: "Cláusula foro · Regra foro" }));
        expect(viewer.docx).toHaveBeenLastCalledWith(expect.objectContaining({ quotes: [{ quote: "trecho foro" }] }));
    });

    it("accepts at once and sends the decision after the undo window", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        render(<ContractReviewWorkspace {...props()} />);
        const foro = (await screen.findAllByRole("article"))[0];
        fireEvent.click(within(foro).getByRole("button", { name: /Aceitar/ }));
        expect(await screen.findByRole("button", { name: "Reabrir: Aceito" })).toHaveTextContent("Aceito por você");
        expect(toasts.showToast).toHaveBeenCalledWith(expect.objectContaining({ message: "Aceito: Regra foro", durationMs: 10_000 }));
        expect(api.decideReviewClause).not.toHaveBeenCalled();
        await act(async () => {
            vi.advanceTimersByTime(10_000);
        });
        await waitFor(() => expect(api.decideReviewClause).toHaveBeenCalledWith("p1", "run-1", "foro", { decision: "aceito" }));
    });

    it("undoes a decision from the toast without touching the document", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        render(<ContractReviewWorkspace {...props()} />);
        const foro = (await screen.findAllByRole("article"))[0];
        fireEvent.click(within(foro).getByRole("button", { name: /Rejeitar/ }));
        fireEvent.keyDown(within(foro).getByLabelText("Por quê? (opcional)"), { key: "Enter" });
        const undo = toasts.showToast.mock.calls[0][0].actions[0];
        expect(undo.label).toBe("Desfazer");
        act(() => undo.onClick());
        await act(async () => {
            vi.advanceTimersByTime(10_000);
        });
        expect(api.decideReviewClause).not.toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: /Reabrir/ })).toBeNull();
    });

    it("corrects a yes/no field from a list, never as free text", async () => {
        api.getContractFicha.mockResolvedValue({
            ...FICHA,
            ficha: {
                "dados_pessoais.compartilhamento": { ...FICHA.ficha!["foro.lei_aplicavel"], value: true },
            },
        });
        api.decideFichaField.mockResolvedValue(FICHA);
        render(<ContractReviewWorkspace {...props()} />);
        fireEvent.click(await screen.findByRole("tab", { name: /Ficha/ }));
        fireEvent.click(await screen.findByRole("button", { name: "Corrigir Compartilha dados pessoais" }));
        const select = screen.getByRole("combobox", { name: "Valor correto de Compartilha dados pessoais" });
        expect(select).toHaveValue("true");
        fireEvent.change(select, { target: { value: "false" } });
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        await waitFor(() =>
            expect(api.decideFichaField).toHaveBeenCalledWith("p1", { path: "dados_pessoais.compartilhamento", action: "corrigir", value: false }),
        );
    });

    it("explains that a rejection already in the document is changed there", async () => {
        api.getContractReview.mockResolvedValue({
            ...REVIEW,
            clauses: [clause("foro", "diverge", { decision: { decision: "rejeitado", edited_text: null, reason: null, decided_by: "duda@avenia.io", decided_at: "2026-10-20T10:05:00Z", edit: null } })],
        });
        render(<ContractReviewWorkspace {...props()} />);
        fireEvent.click(await screen.findByRole("button", { name: "Reabrir: Rejeitado" }));
        expect(toasts.showToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "info" }));
        expect(api.decideReviewClause).not.toHaveBeenCalled();
    });

    it("lets an old toast's undo touch only its own decision", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        render(<ContractReviewWorkspace {...props()} />);
        const foro = (await screen.findAllByRole("article"))[0];
        fireEvent.click(within(foro).getByRole("button", { name: /Aceitar/ }));
        const firstUndo = toasts.showToast.mock.calls[0][0].actions[0];
        fireEvent.click(await screen.findByRole("button", { name: "Reabrir: Aceito" }));
        const again = screen.getAllByRole("article").find((card) => within(card).queryByText("Cláusula foro · Regra foro"))!;
        fireEvent.click(within(again).getByRole("button", { name: /Rejeitar/ }));
        fireEvent.keyDown(within(again).getByLabelText("Por quê? (opcional)"), { key: "Enter" });
        act(() => firstUndo.onClick());
        await act(async () => {
            vi.advanceTimersByTime(10_000);
        });
        await waitFor(() => expect(api.decideReviewClause).toHaveBeenCalledWith("p1", "run-1", "foro", { decision: "rejeitado" }));
        expect(api.decideReviewClause).toHaveBeenCalledTimes(1);
    });

    it("shows the focused clause in the document with Enter", async () => {
        render(<ContractReviewWorkspace {...props()} />);
        const cards = await screen.findAllByRole("article");
        fireEvent.keyDown(cards[0].parentElement!, { key: "j" });
        fireEvent.keyDown(cards[0], { key: "Enter" });
        expect(viewer.docx).toHaveBeenLastCalledWith(expect.objectContaining({ quotes: [{ quote: "trecho foro" }] }));
    });

    it("reopens a decided clause on the server", async () => {
        api.getContractReview.mockResolvedValue({
            ...REVIEW,
            clauses: [clause("foro", "diverge", { decision: { decision: "aceito", edited_text: null, reason: null, decided_by: "duda@avenia.io", decided_at: "2026-10-20T10:05:00Z", edit: null } })],
        });
        render(<ContractReviewWorkspace {...props()} />);
        fireEvent.click(await screen.findByRole("button", { name: "Reabrir: Aceito" }));
        await waitFor(() => expect(api.decideReviewClause).toHaveBeenCalledWith("p1", "run-1", "foro", { decision: "desfeito" }));
    });

    it("accepts every aligned suggestion with one notice, one undo and one refresh", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        api.getContractReview.mockResolvedValue({
            ...REVIEW,
            clauses: [
                clause("a1", "alinhado", { status: "acceptable", playbook_status: "acceptable" }),
                clause("a2", "alinhado", { status: "acceptable", playbook_status: "acceptable" }),
            ],
        });
        api.decideReviewClause.mockImplementation(async (_p: string, _r: string, id: string) => ({
            decision: { decision: "aceito", edited_text: null, reason: null, decided_by: "Duda Lima", decided_at: "2026-10-20T10:05:00Z", edit: null },
            edit: null,
            id,
        }));
        render(<ContractReviewWorkspace {...props()} />);
        fireEvent.click(await screen.findByRole("button", { name: "Aceitar todos os alinhados (2)" }));
        expect(toasts.showToast).toHaveBeenCalledTimes(1);
        expect(toasts.showToast).toHaveBeenCalledWith(expect.objectContaining({ message: "2 cláusulas conferidas" }));
        const loadsBefore = api.getContractReview.mock.calls.length;
        await act(async () => {
            vi.advanceTimersByTime(10_000);
        });
        await waitFor(() => expect(api.decideReviewClause).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(api.getContractReview.mock.calls.length).toBe(loadsBefore + 1));
    });

    it("takes back a whole batch with its one undo", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        api.getContractReview.mockResolvedValue({
            ...REVIEW,
            clauses: [clause("a1", "alinhado"), clause("a2", "alinhado")],
        });
        render(<ContractReviewWorkspace {...props()} />);
        fireEvent.click(await screen.findByRole("button", { name: "Aceitar todos os alinhados (2)" }));
        act(() => toasts.showToast.mock.calls[0][0].actions[0].onClick());
        await act(async () => {
            vi.advanceTimersByTime(10_000);
        });
        expect(api.decideReviewClause).not.toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: /Reabrir/ })).toBeNull();
    });

    it("keeps a sent decision on screen even when the refresh fails", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        api.decideReviewClause.mockResolvedValue({
            decision: { decision: "aceito", edited_text: null, reason: null, decided_by: "Duda Lima", decided_at: "2026-10-20T10:05:00Z", edit: null },
            edit: null,
        });
        render(<ContractReviewWorkspace {...props()} />);
        const foro = (await screen.findAllByRole("article"))[0];
        api.getContractReview.mockRejectedValue(new Error("offline"));
        fireEvent.click(within(foro).getByRole("button", { name: /Aceitar/ }));
        await act(async () => {
            vi.advanceTimersByTime(10_000);
        });
        expect(await screen.findByRole("button", { name: "Reabrir: Aceito" })).toHaveTextContent("Aceito por Duda Lima");
        // The failed refresh is a notice, not a blank page.
        await waitFor(() => expect(errors.notifyError).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ lang: "pt", dedupeKey: "review-refresh" })));
        expect(screen.queryByText("Não consegui carregar a revisão")).toBeNull();
    });

    it("starts a different version clean", async () => {
        api.listContractReviews.mockResolvedValue([
            { id: "run-1", status: "completed", started_at: "2026-10-20T10:00:00Z", playbook_name: "Playbook Avenia v1", counts: { alinhado: 1, precisa_revisao: 0, diverge: 1 } },
            { id: "run-0", status: "completed", started_at: "2026-10-19T10:00:00Z", playbook_name: "Playbook Avenia v1", counts: { alinhado: 0, precisa_revisao: 0, diverge: 0 } },
        ]);
        let resolveOld: (value: ContractReview) => void = () => undefined;
        api.getContractReview.mockImplementation((_p: string, runId: string) =>
            runId === "run-0" ? new Promise((resolve) => (resolveOld = resolve)) : Promise.resolve(REVIEW),
        );
        const onUrlStateChange = vi.fn();
        const { rerender } = render(<ContractReviewWorkspace {...props()} onUrlStateChange={onUrlStateChange} />);
        await screen.findAllByRole("article");
        rerender(<ContractReviewWorkspace {...props()} initialRunId="run-0" onUrlStateChange={onUrlStateChange} />);
        // initialRunId only seeds the first render; pick the version from the menu instead.
        fireEvent.pointerDown(screen.getByRole("button", { name: "Versões da revisão" }), { button: 0, ctrlKey: false });
        const item = await screen.findByRole("menuitemradio", { name: /Revisão 1/ });
        fireEvent.click(item);
        await waitFor(() => expect(screen.queryAllByRole("article")).toHaveLength(0));
        act(() => resolveOld({ ...REVIEW, id: "run-0", clauses: [clause("velha", "alinhado")] }));
        expect(await screen.findByText("Cláusula velha · Regra velha")).toBeInTheDocument();
    });

    it("offers to show everything when a filter leaves nothing, and to send the contract when there is none", async () => {
        render(<ContractReviewWorkspace {...props()} initialVerdict="precisa_revisao" />);
        fireEvent.click(await screen.findByRole("button", { name: "Mostrar tudo" }));
        expect(screen.getAllByRole("article")).toHaveLength(3);
    });

    it("shows the contract's activity, decisions included", async () => {
        api.getCardActivity.mockResolvedValue([
            { id: 1, project_id: "p1", at: new Date().toISOString(), actor_type: "user", actor_id: "u", actor_name: "Duda", action: "review.clause_aceito", field: "Cessão do contrato" },
        ]);
        render(<ContractReviewWorkspace {...props()} />);
        fireEvent.click(await screen.findByRole("tab", { name: "Atividade" }));
        expect(await screen.findByText(/aceitou a sugestão em/)).toBeInTheDocument();
        expect(api.getCardActivity).toHaveBeenCalledWith("p1");
    });

    it("moves between clauses with j/k", async () => {
        render(<ContractReviewWorkspace {...props()} />);
        const cards = await screen.findAllByRole("article");
        const list = cards[0].parentElement!;
        fireEvent.keyDown(list, { key: "j" });
        expect(cards[0]).toHaveFocus();
        fireEvent.keyDown(list, { key: "j" });
        expect(screen.getAllByRole("article")[1]).toHaveFocus();
        fireEvent.keyDown(list, { key: "k" });
        expect(screen.getAllByRole("article")[0]).toHaveFocus();
    });

    it("teaches the next step before the first review and starts one", async () => {
        api.listContractReviews.mockResolvedValue([]);
        api.getContractFicha.mockResolvedValue({ ...FICHA, ficha: null, document_id: null });
        api.startContractReview.mockResolvedValue({ id: "run-2", status: "running" });
        api.getContractReview.mockResolvedValue({ ...REVIEW, id: "run-2", status: "running", clauses: [] });
        render(<ContractReviewWorkspace {...props()} />);
        expect(await screen.findByText("Nenhuma revisão ainda")).toBeInTheDocument();
        expect(screen.getByText("O contrato aparece aqui")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Enviar contrato" }));
        expect(nav.push).toHaveBeenCalledWith("/projects/p1");
        const buttons = screen.getAllByRole("button", { name: /Revisar com o playbook/ });
        fireEvent.click(buttons[buttons.length - 1]);
        expect(await screen.findByText("Redigindo edições…")).toBeInTheDocument();
        expect(api.startContractReview).toHaveBeenCalledWith("p1");
    });

    it("explains a failed review and a failed load", async () => {
        api.getContractReview.mockResolvedValueOnce({ ...REVIEW, error: "A revisão falhou. Tente de novo." });
        const { unmount } = render(<ContractReviewWorkspace {...props()} />);
        expect(await screen.findByText("A revisão não terminou")).toBeInTheDocument();
        unmount();
        api.listContractReviews.mockRejectedValueOnce(new Error("boom"));
        render(<ContractReviewWorkspace {...props()} />);
        expect(await screen.findByText("Não consegui carregar a revisão")).toBeInTheDocument();
        api.listContractReviews.mockResolvedValue([]);
        fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
        expect(await screen.findByText("Nenhuma revisão ainda")).toBeInTheDocument();
    });

    it("shows the Ficha with its count and verifies a field in one click, after the undo window", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        api.decideFichaField.mockResolvedValue({ ...FICHA, progress: { verified: 1, total: 1 } });
        render(<ContractReviewWorkspace {...props()} />);
        const tab = await screen.findByRole("tab", { name: /Ficha/ });
        await waitFor(() => expect(tab).toHaveTextContent("0/1"));
        fireEvent.click(tab);
        expect(screen.getByText("Lei aplicável")).toBeInTheDocument();
        expect(screen.getByText("US")).toBeInTheDocument();
        expect(screen.getByText("a conferir")).toHaveClass("text-amber-700");
        const verify = screen.getByRole("button", { name: "Verificar Lei aplicável" });
        fireEvent.click(verify);
        // A second click while it waits does nothing.
        expect(verify).toBeDisabled();
        expect(toasts.showToast).toHaveBeenCalledWith(expect.objectContaining({ message: "Verificado: Lei aplicável" }));
        expect(api.decideFichaField).not.toHaveBeenCalled();
        await act(async () => {
            vi.advanceTimersByTime(10_000);
        });
        await waitFor(() => expect(api.decideFichaField).toHaveBeenCalledWith("p1", { path: "foro.lei_aplicavel", action: "confirmar" }));
        await waitFor(() => expect(screen.getByRole("tab", { name: /Ficha/ })).toHaveTextContent("1/1"));
    });

    it("undoes a Verificar before it is sent", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        render(<ContractReviewWorkspace {...props()} />);
        fireEvent.click(await screen.findByRole("tab", { name: /Ficha/ }));
        fireEvent.click(await screen.findByRole("button", { name: "Verificar Lei aplicável" }));
        act(() => toasts.showToast.mock.calls.at(-1)![0].actions[0].onClick());
        await act(async () => {
            vi.advanceTimersByTime(10_000);
        });
        expect(api.decideFichaField).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Verificar Lei aplicável" })).toBeEnabled();
    });

    it("shows what the model read differently on a verified field", async () => {
        api.getContractFicha.mockResolvedValue({
            ...FICHA,
            ficha: {
                "foro.lei_aplicavel": {
                    ...FICHA.ficha!["foro.lei_aplicavel"],
                    value: { jurisdicao: "BR" },
                    ai_value: { jurisdicao: "US-NY" },
                    notes: "A IA leu diferente na nova versão do documento.",
                    review: { state: "confirmado", by: "duda", at: "t", comment: null },
                },
            },
        });
        render(<ContractReviewWorkspace {...props()} />);
        fireEvent.click(await screen.findByRole("tab", { name: /Ficha/ }));
        expect(await screen.findByText("A IA leu diferente na nova versão do documento. IA leu: US-NY")).toBeInTheDocument();
    });

    it("corrects a Ficha field as typed, and shows a citation in the document", async () => {
        api.decideFichaField.mockResolvedValue(FICHA);
        render(<ContractReviewWorkspace {...props()} />);
        fireEvent.click(await screen.findByRole("tab", { name: /Ficha/ }));
        fireEvent.click(await screen.findByRole("button", { name: "Ver no documento: cl. 20" }));
        expect(viewer.docx).toHaveBeenLastCalledWith(expect.objectContaining({ quotes: [{ quote: "leis de Nova York" }] }));
        fireEvent.click(screen.getByRole("button", { name: "Corrigir Lei aplicável" }));
        const input = screen.getByLabelText("Valor correto de Lei aplicável");
        expect(input).toHaveValue("US");
        fireEvent.change(input, { target: { value: "BR" } });
        fireEvent.keyDown(input, { key: "Enter" });
        await waitFor(() =>
            expect(api.decideFichaField).toHaveBeenCalledWith("p1", {
                path: "foro.lei_aplicavel",
                action: "corrigir",
                value: { jurisdicao: "BR" },
            }),
        );
    });

    it("extracts the Ficha from its empty state", async () => {
        api.getContractFicha.mockResolvedValue({ ...FICHA, ficha: null });
        api.extractContractFicha.mockResolvedValue(FICHA);
        render(<ContractReviewWorkspace {...props()} />);
        fireEvent.click(await screen.findByRole("button", { name: "Extrair a Ficha" }));
        fireEvent.click(await screen.findByRole("button", { name: "Extrair a Ficha" }));
        await waitFor(() => expect(api.extractContractFicha).toHaveBeenCalledWith("p1"));
        expect(await screen.findByText("Lei aplicável")).toBeInTheDocument();
    });

    it("shares and exports from the header", async () => {
        const onShare = vi.fn();
        api.getDocumentFile.mockResolvedValue({ blob: new Blob(["x"]), filename: "Contrato v2.docx" });
        const createObjectURL = vi.fn(() => "blob:1");
        vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
        render(<ContractReviewWorkspace {...props()} onShare={onShare} />);
        fireEvent.click(await screen.findByRole("button", { name: "Compartilhar" }));
        expect(onShare).toHaveBeenCalled();
        await waitFor(() => expect(screen.getByRole("button", { name: "Exportar .docx" })).toBeEnabled());
        fireEvent.click(screen.getByRole("button", { name: "Exportar .docx" }));
        await waitFor(() => expect(api.getDocumentFile).toHaveBeenCalledWith("doc-1"));
        expect(createObjectURL).toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it("is read-only for a viewer", async () => {
        render(<ContractReviewWorkspace {...props()} canEdit={false} />);
        await screen.findAllByRole("article");
        expect(screen.queryByRole("button", { name: /Aceitar/ })).toBeNull();
        expect(screen.queryByRole("button", { name: /Revisar/ })).toBeNull();
    });
});
