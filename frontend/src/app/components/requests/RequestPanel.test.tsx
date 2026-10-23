import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestPanel } from "./RequestPanel";

const state = vi.hoisted(() => ({ getRequest: vi.fn(), getCardActivity: vi.fn() }));

vi.mock("@/app/lib/mikeApi", () => ({
    assignRequest: vi.fn(),
    decideRequestTriage: vi.fn(),
    deliverRequest: vi.fn(),
    getCardActivity: state.getCardActivity,
    getRequest: state.getRequest,
    inviteRequestParticipant: vi.fn(),
    postRequestMessage: vi.fn(),
    requestContractAnalysis: vi.fn(),
    revokeRequestParticipant: vi.fn(),
}));
vi.mock("./IntakeChecklist", () => ({ RequestIntakeSection: () => null }));
vi.mock("./RequestConversation", () => ({ RequestConversation: () => null }));
vi.mock("./CriticalAlerts", () => ({ CriticalAlertBanner: () => null }));
vi.mock("@/app/components/contract-review/AnalystAnalysisView", () => ({ AnalystAnalysisView: () => null }));

const team = [{ id: "u1", name: "Téo", email: "teo@avenia.io" }];

function request(over: Record<string, unknown> = {}) {
    return {
        id: "r1",
        code: "LEG-0002",
        title: "Revisar minuta",
        kind: "revisao_contrato",
        kind_label: "Revisão de contrato",
        counterparty: "Delta TI",
        context: "",
        urgency: "normal",
        needed_by: null,
        status: "em_andamento",
        step: "em_analise",
        due_at: "2099-01-01T12:00:00Z",
        sla: "no_prazo",
        summary: "Resumo.",
        assignee_id: "u1",
        assignee_name: "Téo",
        requester_name: "Ana",
        requester_email: "ana@avenia.io",
        requester_area: "Compras",
        delivery: null,
        messages: [],
        participants: [],
        created_at: "",
        updated_at: "",
        audience: "team",
        project_id: "p1",
        can_decide: true,
        triage: null,
        ...over,
    };
}

describe("RequestPanel: sua tarefa", () => {
    beforeEach(() => {
        state.getRequest.mockReset();
        state.getCardActivity.mockReset();
        state.getCardActivity.mockResolvedValue([]);
    });

    it("pins the signed-in person's task above the fields, with a link to the document", async () => {
        state.getRequest.mockResolvedValue(request());
        render(<RequestPanel requestId="r1" team={team} userId="u1" onClose={() => {}} onChanged={() => {}} />);
        const card = await screen.findByRole("region", { name: "Sua tarefa" });
        expect(card).toHaveTextContent("Analisar e decidir");
        expect(screen.getByRole("link", { name: "Abrir o documento" })).toHaveAttribute("href", "/projects/p1/review");
    });

    it("asks the Head to choose an owner when nobody has the request", async () => {
        state.getRequest.mockResolvedValue(request({ assignee_id: null, assignee_name: null }));
        render(<RequestPanel requestId="r1" team={team} userId="u9" onClose={() => {}} onChanged={() => {}} />);
        const card = await screen.findByRole("region", { name: "Sua tarefa" });
        expect(card).toHaveTextContent("Escolher quem pega este pedido");
        expect(screen.getByRole("button", { name: "Escolher responsável" })).toBeInTheDocument();
    });

    it("never cuts the task title: it wraps, so a long one still reads whole", async () => {
        state.getRequest.mockResolvedValue(request({ assignee_id: null, assignee_name: null }));
        render(<RequestPanel requestId="r1" team={team} userId="u9" onClose={() => {}} onChanged={() => {}} />);
        const title = await screen.findByText("Escolher quem pega este pedido");
        expect(title.className).not.toMatch(/truncate/);
    });

    it("shows nothing when the task belongs to someone else", async () => {
        state.getRequest.mockResolvedValue(request());
        render(<RequestPanel requestId="r1" team={team} userId="u2" onClose={() => {}} onChanged={() => {}} />);
        await screen.findByText("Revisar minuta");
        expect(screen.queryByRole("region", { name: "Sua tarefa" })).not.toBeInTheDocument();
    });
});
