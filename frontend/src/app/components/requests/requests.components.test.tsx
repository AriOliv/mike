import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TriageSuggestion } from "./TriageSuggestion";
import { RequestSteps } from "./RequestSteps";
import { RequestConversation } from "./RequestConversation";
import type { RequestTriage } from "@/app/lib/mikeApi";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const team = [
    { id: "d", name: "Duda" },
    { id: "t", name: "Téo" },
];
const triage: RequestTriage = {
    kind: "nda",
    kind_changed: true,
    counterparty: "Polaris",
    area: "Comercial",
    missing: ["minuta da contraparte"],
    assignee_id: "d",
    assignee_name: "Duda",
    assignee_reason: "Duda: 0 pedidos abertos (Téo tem 2).",
    playbook_name: "Playbook NDA",
    ai: true,
    suggested_at: "2026-10-20T11:58:00Z",
    decision: null,
};

describe("TriageSuggestion", () => {
    it("shows what the agent suggests, with its reasons, and accepts in one click or with 'a'", () => {
        const onDecide = vi.fn();
        render(<TriageSuggestion triage={triage} currentKind="revisao" team={team} canDecide onDecide={onDecide} now={NOW} />);
        expect(screen.getByRole("region", { name: "Sugestão do agente de triagem" })).toBeInTheDocument();
        expect(screen.getByText("há 2 min", { exact: false })).toBeInTheDocument();
        expect(screen.getByText("(o pedido dizia outro)")).toBeInTheDocument();
        expect(screen.getByText("Duda: 0 pedidos abertos (Téo tem 2).")).toBeInTheDocument();
        expect(screen.getByText("minuta da contraparte")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: /Aceitar/ }));
        expect(onDecide).toHaveBeenLastCalledWith({ decision: "accepted" });
        fireEvent.keyDown(window, { key: "a" });
        expect(onDecide).toHaveBeenCalledTimes(2);
        fireEvent.keyDown(window, { key: "a", metaKey: true });
        expect(onDecide).toHaveBeenCalledTimes(2);
    });

    it("edits the kind, counterparty and assignee before applying", () => {
        const onDecide = vi.fn();
        render(<TriageSuggestion triage={triage} currentKind="nda" team={team} canDecide onDecide={onDecide} />);
        fireEvent.keyDown(window, { key: "e" });
        fireEvent.change(screen.getByLabelText("Tipo"), { target: { value: "parecer" } });
        fireEvent.change(screen.getByLabelText("Contraparte"), { target: { value: "  " } });
        fireEvent.change(screen.getByLabelText("Responsável"), { target: { value: "t" } });
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        expect(onDecide).toHaveBeenCalledWith({ decision: "edited", kind: "parecer", counterparty: null, assignee_id: "t" });
        fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
        expect(screen.getByRole("button", { name: /Aceitar/ })).toBeInTheDocument();
    });

    it("rejects with an optional reason; Escape backs out", () => {
        const onDecide = vi.fn();
        render(<TriageSuggestion triage={triage} currentKind="nda" team={team} canDecide onDecide={onDecide} />);
        fireEvent.click(screen.getByRole("button", { name: /Rejeitar/ }));
        const input = screen.getByLabelText("Por quê? (opcional)");
        fireEvent.keyDown(input, { key: "Escape" });
        expect(screen.queryByLabelText("Por quê? (opcional)")).not.toBeInTheDocument();
        fireEvent.keyDown(window, { key: "r" });
        fireEvent.change(screen.getByLabelText("Por quê? (opcional)"), { target: { value: "já resolvido" } });
        fireEvent.submit(screen.getByLabelText("Por quê? (opcional)").closest("form")!);
        expect(onDecide).toHaveBeenCalledWith({ decision: "rejected", reason: "já resolvido" });
    });

    it("ignores shortcuts while typing, and tells analysts the Head decides", () => {
        const onDecide = vi.fn();
        const { rerender } = render(
            <>
                <input aria-label="outro" />
                <TriageSuggestion triage={triage} currentKind="nda" team={team} canDecide onDecide={onDecide} />
            </>,
        );
        fireEvent.keyDown(screen.getByLabelText("outro"), { key: "a" });
        expect(onDecide).not.toHaveBeenCalled();
        rerender(<TriageSuggestion triage={{ ...triage, ai: false, kind: undefined, counterparty: null, area: null, missing: [], assignee_name: null, assignee_reason: null, playbook_name: null, suggested_at: undefined }} currentKind="nda" team={team} canDecide={false} onDecide={onDecide} />);
        expect(screen.getByText("A liderança do Legal confirma a triagem.")).toBeInTheDocument();
        expect(screen.getByText("· sem IA (regras)")).toBeInTheDocument();
        expect(screen.getByText("não identificada")).toBeInTheDocument();
        expect(screen.getByText("ninguém disponível")).toBeInTheDocument();
        expect(screen.getByText("nenhum compatível")).toBeInTheDocument();
    });

    it("folds into one line once decided", () => {
        const { rerender } = render(
            <TriageSuggestion triage={{ ...triage, decision: "accepted", decided_at: "2026-10-20T11:00:00Z" }} currentKind="nda" team={team} canDecide onDecide={vi.fn()} now={NOW} />,
        );
        expect(screen.getByText("Triagem aceita · há 1 h")).toBeInTheDocument();
        rerender(<TriageSuggestion triage={{ ...triage, decision: "edited" }} currentKind="nda" team={team} canDecide onDecide={vi.fn()} />);
        expect(screen.getByText("Triagem ajustada")).toBeInTheDocument();
        rerender(<TriageSuggestion triage={{ ...triage, decision: "rejected" }} currentKind="nda" team={team} canDecide onDecide={vi.fn()} />);
        expect(screen.getByText("Triagem recusada")).toBeInTheDocument();
    });
});

describe("RequestSteps", () => {
    it("marks done, current and next steps without relying on colour", () => {
        const { rerender } = render(<RequestSteps step="em_analise" />);
        expect(screen.getByText("Em análise").closest("li")).toHaveAttribute("aria-current", "step");
        expect(screen.getByText("Recebido").closest("li")).not.toHaveAttribute("aria-current");
        rerender(<RequestSteps step="concluido" />);
        expect(screen.queryByRole("listitem", { current: "step" })).not.toBeInTheDocument();
    });
});

describe("RequestConversation", () => {
    const messages = [
        { id: "1", kind: "question" as const, body: "Tem a minuta?", author_name: "Duda", author_email: "d@a", created_at: "2026-10-20T11:00:00Z" },
        { id: "2", kind: "answer" as const, body: "Segue.", author_name: null, author_email: "ana@a", created_at: "2026-10-20T11:30:00Z" },
    ];

    it("lets the team ask (pausing the clock) or leave a note", async () => {
        const onSend = vi.fn(async () => {});
        render(<RequestConversation messages={messages} mode="team" onSend={onSend} now={NOW} />);
        expect(screen.getByText("perguntou", { exact: false })).toBeInTheDocument();
        expect(screen.getByText("ana@a")).toBeInTheDocument();
        const box = screen.getByLabelText("Mensagem");
        fireEvent.change(box, { target: { value: "Pode mandar o anexo II?" } });
        fireEvent.click(screen.getByRole("button", { name: "Perguntar ao solicitante" }));
        await waitFor(() => expect(onSend).toHaveBeenCalledWith("Pode mandar o anexo II?", "question"));
        await waitFor(() => expect(box).toHaveValue(""));
        fireEvent.change(box, { target: { value: "Recebido" } });
        fireEvent.keyDown(box, { key: "Enter", metaKey: true });
        await waitFor(() => expect(onSend).toHaveBeenLastCalledWith("Recebido", "note"));
        fireEvent.click(screen.getByRole("button", { name: "Enviar recado" }));
        expect(onSend).toHaveBeenCalledTimes(2);
    });

    it("lets the requester answer, and explains the empty thread", async () => {
        const onSend = vi.fn(async () => {});
        const { rerender } = render(<RequestConversation messages={[]} mode="requester" onSend={onSend} />);
        expect(screen.getByText(/a pergunta aparece aqui e no seu e-mail/)).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "Segue" } });
        fireEvent.click(screen.getByRole("button", { name: "Responder" }));
        await waitFor(() => expect(onSend).toHaveBeenCalledWith("Segue", "note"));
        rerender(<RequestConversation messages={[]} mode="team" onSend={onSend} />);
        expect(screen.getByText(/o prazo pausa até a resposta/)).toBeInTheDocument();
        rerender(<RequestConversation messages={messages} mode="readonly" />);
        expect(screen.queryByLabelText("Mensagem")).not.toBeInTheDocument();
    });
});
