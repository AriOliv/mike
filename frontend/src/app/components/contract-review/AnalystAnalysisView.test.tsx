import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalystAnalysis } from "@/app/lib/mikeApi";

const api = vi.hoisted(() => ({
    getLatestAnalysis: vi.fn(),
    startAnalystAnalysis: vi.fn(),
    listAnalysisDecisions: vi.fn(),
    decideAnalysisRedline: vi.fn(),
    exportAnalysis: vi.fn(),
}));
vi.mock("@/app/lib/mikeApi", async (original) => ({
    ...(await original<typeof import("@/app/lib/mikeApi")>()),
    ...api,
}));
const errors = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock("@/app/lib/userFacingError", async (original) => ({
    ...(await original<typeof import("@/app/lib/userFacingError")>()),
    notifyError: errors.notifyError,
}));

import { AnalystAnalysisView } from "./AnalystAnalysisView";

// Fictitious content: no real party or clause.
const done: AnalystAnalysis = {
    id: "a1",
    project_id: "p1",
    request_id: null,
    document_id: "d1",
    version_id: "v1",
    playbook_id: null,
    playbook_run_id: null,
    intake: [],
    model: "claude-sonnet-5-5",
    status: "done",
    dropped_citations: [{ section: "critical", title: "Trecho inventado", quote: "x", reason: "trecho não encontrado no documento" }],
    usage: { model: "claude-sonnet-5-5", calls: 1, input_tokens: 10_000, output_tokens: 2_000, estimated_cost_usd: 0.06 },
    error: null,
    created_at: "2026-10-22T10:00:00Z",
    finished_at: "2026-10-22T10:02:00Z",
    result: {
        notice: "Rascunho gerado por IA para o time jurídico. Não é parecer jurídico.",
        executive_summary: { text: "Suporte técnico entre duas empresas fictícias.", object: "Suporte", parties: ["Fornecedora Exemplo", "Empresa Teste"], value: "R$ 10.000 por mês" },
        critical: [{ id: "c1", title: "Multa rescisória alta", quote: "multa de 50% do valor total", clause: "cl. 5.1", rationale: "Desproporcional.", suggestion: "Reduzir para 10%.", light: "red", rule_id: null, span: null }],
        attention: [],
        favorable: [{ id: "f1", title: "Foro no Brasil", quote: "foro da Comarca de São Paulo", clause: "cl. 9.1", rationale: "Bom.", suggestion: null, light: "green", rule_id: null, span: null }],
        redlines: [{ id: "r1", clause: "cl. 5.1", from: "multa de 50% do valor total", to: "multa de 10% do saldo", why: "Proporcionalidade.", item_id: "c1", span: null }],
        compliance: { data_protection: "Sem dados pessoais.", confidentiality: "Adequada.", governing_law_forum: "Lei brasileira.", term_termination_penalties: "Multa alta." },
        open_points: [{ id: "o1", text: "Aprovação do founder.", depends_on: "founder" }],
    },
};

beforeEach(() => {
    vi.clearAllMocks();
    api.listAnalysisDecisions.mockResolvedValue([]);
});

describe("AnalystAnalysisView", () => {
    it("shows the analysis in the analyst's layout, with the AI notice and what was dropped", async () => {
        render(<AnalystAnalysisView projectId="p1" analysis={done} />);
        expect(screen.getByRole("note")).toHaveTextContent("Não é parecer jurídico");
        expect(screen.getByRole("region", { name: "Resumo executivo" })).toHaveTextContent("Fornecedora Exemplo · Empresa Teste");
        const critical = screen.getByRole("region", { name: "Riscos críticos" });
        expect(within(critical).getByText("cl. 5.1 · Multa rescisória alta")).toBeInTheDocument();
        expect(within(critical).getByText("Diverge")).toBeInTheDocument();
        expect(screen.getByRole("region", { name: "Pontos de atenção" })).toHaveTextContent("Nenhum ponto de atenção.");
        expect(screen.getByRole("region", { name: "Pontos abertos" })).toHaveTextContent("depende de: Founder");
        expect(screen.getByText("1 item descartado: o trecho citado não está no contrato")).toBeInTheDocument();
        expect(screen.getByText(/custo estimado US\$ 0\.06/)).toBeInTheDocument();
        await waitFor(() => expect(api.listAnalysisDecisions).toHaveBeenCalledWith("p1", "a1"));
    });

    it("scrolls the document to a quote when a citation is clicked", () => {
        const onLocate = vi.fn();
        render(<AnalystAnalysisView projectId="p1" analysis={done} onLocate={onLocate} />);
        const critical = screen.getByRole("region", { name: "Riscos críticos" });
        fireEvent.click(within(critical).getByRole("button", { name: "Ver o trecho no documento" }));
        expect(onLocate).toHaveBeenCalledWith("multa de 50% do valor total");
    });

    it("decides a redline only when a person accepts it, and reloads the document", async () => {
        const onChanged = vi.fn();
        api.decideAnalysisRedline.mockResolvedValue({
            redline_id: "r1", decision: "aceito", edited_text: null, reason: null, decided_by: "Pessoa", decided_at: "2026-10-22T10:05:00Z", edit: null,
        });
        render(<AnalystAnalysisView projectId="p1" analysis={done} canDecide onChanged={onChanged} />);
        const redlines = screen.getByRole("region", { name: "Sugestões de redline" });
        expect(api.decideAnalysisRedline).not.toHaveBeenCalled();
        fireEvent.click(within(redlines).getByRole("button", { name: /Aceitar/ }));
        await waitFor(() => expect(api.decideAnalysisRedline).toHaveBeenCalledWith("p1", "a1", "r1", { decision: "aceito" }));
        await waitFor(() => expect(onChanged).toHaveBeenCalled());
        expect(await within(redlines).findByText(/Aceito/)).toBeInTheDocument();
    });

    describe("when the server refuses a decision with a 409", () => {
        function refuse(code: string) {
            api.decideAnalysisRedline.mockRejectedValue(Object.assign(new Error("frase do servidor"), { code, status: 409 }));
        }
        async function accept(onLocate?: (quote: string) => void) {
            render(<AnalystAnalysisView projectId="p1" analysis={done} canDecide onLocate={onLocate} />);
            const redlines = screen.getByRole("region", { name: "Sugestões de redline" });
            fireEvent.click(within(redlines).getByRole("button", { name: /Aceitar/ }));
            await waitFor(() => expect(errors.notifyError).toHaveBeenCalled());
            return errors.notifyError.mock.calls[0][1] as { actions?: { label: string; onClick: () => void }[]; onRetry?: () => void };
        }

        it("offers a new analysis when the clause changed", async () => {
            refuse("analysis_text_changed");
            api.startAnalystAnalysis.mockResolvedValue({ analysis_id: "a2", queued: true });
            const options = await accept();
            expect(options.actions?.map((a) => a.label)).toEqual(["Pedir nova análise"]);
            options.actions![0].onClick();
            await waitFor(() => expect(api.startAnalystAnalysis).toHaveBeenCalledWith("p1"));
        });

        it("takes the person to the clause when it appears more than once", async () => {
            refuse("analysis_text_ambiguous");
            const onLocate = vi.fn();
            const options = await accept(onLocate);
            expect(options.actions?.map((a) => a.label)).toEqual(["Ver na revisão"]);
            options.actions![0].onClick();
            expect(onLocate).toHaveBeenCalled();
        });

        it("lets the person send the decision again when the contract was busy", async () => {
            refuse("document_busy");
            const options = await accept();
            expect(options.actions).toBeUndefined();
            api.decideAnalysisRedline.mockClear();
            options.onRetry!();
            await waitFor(() => expect(api.decideAnalysisRedline).toHaveBeenCalledTimes(1));
        });
    });

    it("marks an open point read from the contract as a suggestion and finds it in the document", () => {
        const onLocate = vi.fn();
        const withQuote: AnalystAnalysis = {
            ...done,
            result: {
                ...done.result!,
                open_points: [
                    ...done.result!.open_points,
                    { id: "u_foro", text: "Sem resposta no checklist: foro.", depends_on: "outro", quote: "Fica eleito o foro da comarca de Cidade Fictícia" },
                ],
            },
        };
        render(<AnalystAnalysisView projectId="p1" analysis={withQuote} onLocate={onLocate} />);
        const points = screen.getByRole("region", { name: "Pontos abertos" });
        expect(within(points).getAllByText(/Sugestão: confirmar com quem pediu/)).toHaveLength(1);
        fireEvent.click(within(points).getByRole("button", { name: "Ver o trecho no documento" }));
        expect(onLocate).toHaveBeenCalledWith("Fica eleito o foro da comarca de Cidade Fictícia");
    });

    it("reads the redlines without deciding for someone who cannot edit", () => {
        render(<AnalystAnalysisView projectId="p1" analysis={done} />);
        const redlines = screen.getByRole("region", { name: "Sugestões de redline" });
        expect(within(redlines).queryByRole("button", { name: /Aceitar/ })).not.toBeInTheDocument();
    });

    it("offers to start an analysis when there is none, and follows it", async () => {
        api.getLatestAnalysis.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...done, status: "running", result: null });
        api.startAnalystAnalysis.mockResolvedValue({ analysis_id: "a1", queued: true });
        render(<AnalystAnalysisView projectId="p1" canDecide />);
        fireEvent.click(await screen.findByRole("button", { name: /Pedir a análise/ }));
        await waitFor(() => expect(api.startAnalystAnalysis).toHaveBeenCalledWith("p1"));
        expect(await screen.findByRole("status")).toHaveTextContent("O agente analista está lendo o contrato");
    });

    it("explains a failed analysis and lets the team try again", () => {
        render(<AnalystAnalysisView projectId="p1" analysis={{ ...done, status: "failed", result: null, error: "Não consegui ler o texto do contrato." }} canDecide />);
        expect(screen.getByText("A análise falhou")).toBeInTheDocument();
        expect(screen.getByText("Não consegui ler o texto do contrato.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Tentar de novo/ })).toBeInTheDocument();
    });
});
