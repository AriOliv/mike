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
        expect(screen.getByText("há 2 min · sugerido", { exact: false })).toBeInTheDocument();
        expect(screen.getByText("(o pedido dizia outro)")).toBeInTheDocument();
        expect(screen.getByText("Duda: 0 pedidos abertos (Téo tem 2).")).toBeInTheDocument();
        expect(screen.getByText("minuta da contraparte")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: /Aceitar/ }));
        expect(onDecide).toHaveBeenLastCalledWith({ decision: "accepted" });
        fireEvent.keyDown(screen.getByRole("article"), { key: "a" });
        expect(onDecide).toHaveBeenCalledTimes(2);
    });

    it("edits the kind, counterparty and assignee before applying", () => {
        const onDecide = vi.fn();
        render(<TriageSuggestion triage={triage} currentKind="nda" team={team} canDecide onDecide={onDecide} />);
        fireEvent.keyDown(screen.getByRole("article"), { key: "e" });
        expect(screen.queryByRole("button", { name: /Aceitar/ })).not.toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Tipo"), { target: { value: "parecer" } });
        fireEvent.change(screen.getByLabelText("Contraparte"), { target: { value: "  " } });
        fireEvent.change(screen.getByLabelText("Responsável"), { target: { value: "t" } });
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        expect(onDecide).toHaveBeenCalledWith({ decision: "edited", kind: "parecer", counterparty: null, assignee_id: "t" });
        fireEvent.click(screen.getByRole("button", { name: /Editar/ }));
        fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
        expect(screen.getByRole("button", { name: /Aceitar/ })).toBeInTheDocument();
    });

    it("does not accept when 'a' is pressed while choosing in a select", () => {
        const onDecide = vi.fn();
        render(<TriageSuggestion triage={triage} currentKind="nda" team={team} canDecide onDecide={onDecide} />);
        fireEvent.click(screen.getByRole("button", { name: /Editar/ }));
        fireEvent.keyDown(screen.getByLabelText("Responsável"), { key: "a" });
        expect(onDecide).not.toHaveBeenCalled();
    });

    it("reopens a decided triage from its folded line", () => {
        const onReopen = vi.fn();
        render(
            <TriageSuggestion triage={{ ...triage, decision: "accepted", decided_at: "2026-10-20T11:00:00Z" }} currentKind="nda" team={team} canDecide onDecide={vi.fn()} onReopen={onReopen} decidedBy="Marina" />,
        );
        fireEvent.click(screen.getByRole("button", { name: /Reabrir/ }));
        expect(onReopen).toHaveBeenCalled();
    });

    it("rejects with an optional reason", () => {
        const onDecide = vi.fn();
        render(<TriageSuggestion triage={triage} currentKind="nda" team={team} canDecide onDecide={onDecide} />);
        fireEvent.click(screen.getByRole("button", { name: /Rejeitar/ }));
        const input = screen.getByPlaceholderText("Por quê? (opcional, Enter confirma)");
        fireEvent.change(input, { target: { value: "já resolvido" } });
        fireEvent.keyDown(input, { key: "Enter" });
        expect(onDecide).toHaveBeenCalledWith({ decision: "rejected", reason: "já resolvido" });
        fireEvent.click(screen.getByRole("button", { name: /Rejeitar/ }));
        fireEvent.keyDown(screen.getByPlaceholderText("Por quê? (opcional, Enter confirma)"), { key: "Enter" });
        expect(onDecide).toHaveBeenLastCalledWith({ decision: "rejected", reason: undefined });
    });

    it("tells analysts the Head decides, and says when the agent ran without AI", () => {
        render(
            <TriageSuggestion
                triage={{ ...triage, ai: false, kind: undefined, counterparty: null, area: null, missing: [], assignee_name: null, assignee_reason: null, playbook_name: null, suggested_at: undefined }}
                currentKind="nda"
                team={team}
                canDecide={false}
                onDecide={vi.fn()}
            />,
        );
        expect(screen.getByText("A liderança do Legal confirma a triagem.")).toBeInTheDocument();
        expect(screen.getByText("sugerido · sem IA (regras)", { exact: false })).toBeInTheDocument();
        expect(screen.getByText("não identificada")).toBeInTheDocument();
        expect(screen.getByText("ninguém disponível")).toBeInTheDocument();
        expect(screen.getByText("nenhum compatível")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Aceitar/ })).not.toBeInTheDocument();
    });

    it("folds into one line once decided", () => {
        const { rerender } = render(
            <TriageSuggestion triage={{ ...triage, decision: "accepted", decided_at: "2026-10-20T11:00:00Z" }} currentKind="nda" team={team} canDecide onDecide={vi.fn()} decidedBy="Marina" />,
        );
        expect(screen.getByText(/Aceito por Marina/)).toBeInTheDocument();
        rerender(<TriageSuggestion triage={{ ...triage, decision: "edited" }} currentKind="nda" team={team} canDecide onDecide={vi.fn()} />);
        expect(screen.getByText(/Editado por liderança do Legal/)).toBeInTheDocument();
        rerender(<TriageSuggestion triage={{ ...triage, decision: "rejected" }} currentKind="nda" team={team} canDecide onDecide={vi.fn()} />);
        expect(screen.getByText(/Rejeitado por liderança do Legal/)).toBeInTheDocument();
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

    it("never shows a cancelled request as Concluído", () => {
        render(<RequestSteps step="concluido" cancelled />);
        expect(screen.getByText("Cancelado")).toBeInTheDocument();
        expect(screen.queryByText("Concluído")).not.toBeInTheDocument();
        expect(screen.queryByText("Assinatura")).not.toBeInTheDocument();
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
