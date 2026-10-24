import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ sendFeedback: vi.fn() }));
vi.mock("@/app/lib/mikeApi", async (orig) => ({ ...(await orig<typeof import("@/app/lib/mikeApi")>()), ...api }));
vi.mock("@/app/contexts/WorkspaceContext", () => ({ useWorkspace: () => ({ workspaceId: "org-1" }) }));

import { feedbackStore } from "@/app/lib/feedback";
import { FeedbackModal } from "./FeedbackModal";

beforeEach(() => {
    api.sendFeedback.mockReset();
    feedbackStore.clearDraft();
});

describe("FeedbackModal", () => {
    it("explains where the report goes, in plain words", () => {
        render(<FeedbackModal open onClose={vi.fn()} />);
        expect(screen.getByText(/Seu relato vai para o time de tecnologia da Avenia\. Não escreva dados de pessoas, como nome, e-mail e CPF, nem trechos de contrato\./)).toBeInTheDocument();
        expect(screen.queryByText(/repositório/i)).toBeNull();
    });

    it("needs a type and a sentence, and says what is missing", () => {
        render(<FeedbackModal open onClose={vi.fn()} />);
        const send = screen.getByRole("button", { name: "Enviar" });
        expect(send).toBeDisabled();
        fireEvent.click(screen.getByRole("button", { name: "Algo deu errado" }));
        fireEvent.change(screen.getByRole("textbox", { name: /O que aconteceu/ }), { target: { value: "ab" } });
        expect(screen.getByText("Conte um pouco mais, pelo menos uma frase.")).toBeInTheDocument();
        expect(send).toBeDisabled();
    });

    it("sends the report with the page and no token, then gives the number and clears the draft", async () => {
        api.sendFeedback.mockResolvedValue({ number: 42, label: "REL-0042", redacted: true });
        render(<FeedbackModal open onClose={vi.fn()} />);
        fireEvent.click(screen.getByRole("button", { name: "Algo deu errado" }));
        fireEvent.change(screen.getByRole("textbox", { name: /O que aconteceu/ }), { target: { value: "O botão Salvar não responde" } });
        fireEvent.change(screen.getByRole("textbox", { name: /O que deveria ter acontecido/ }), { target: { value: "Salvar" } });
        fireEvent.submit(document.getElementById("feedback-form")!);
        expect(await screen.findByText("Recebemos seu relato.")).toBeInTheDocument();
        expect(screen.getByText("REL-0042")).toBeInTheDocument();
        expect(screen.getByText(/Apagamos do texto/)).toBeInTheDocument();
        const sent = api.sendFeedback.mock.calls[0][0];
        expect(sent).toMatchObject({ kind: "bug", body: "O botão Salvar não responde", expected: "Salvar", org_id: "org-1" });
        expect(Object.keys(sent)).toEqual(expect.not.arrayContaining(["cookie", "token", "authorization"]));
        expect(feedbackStore.getDraft().body).toBe("");
    });

    it("keeps the draft when closed with Esc and shows it again", () => {
        const { rerender } = render(<FeedbackModal open onClose={vi.fn()} />);
        fireEvent.change(screen.getByRole("textbox", { name: /O que aconteceu/ }), { target: { value: "ainda escrevendo" } });
        rerender(<FeedbackModal open={false} onClose={vi.fn()} />);
        rerender(<FeedbackModal open onClose={vi.fn()} />);
        expect((screen.getByRole("textbox", { name: /O que aconteceu/ }) as HTMLTextAreaElement).value).toBe("ainda escrevendo");
    });

    it("shows an error in the box when sending fails, and keeps what was typed", async () => {
        api.sendFeedback.mockRejectedValue(Object.assign(new Error("x"), { status: 429, code: "feedback_rate_limited" }));
        render(<FeedbackModal open onClose={vi.fn()} />);
        fireEvent.click(screen.getByRole("button", { name: "Tenho uma ideia" }));
        fireEvent.change(screen.getByRole("textbox", { name: /Qual é a ideia/ }), { target: { value: "Filtrar por área" } });
        fireEvent.submit(document.getElementById("feedback-form")!);
        await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
        expect((screen.getByRole("textbox", { name: /Qual é a ideia/ }) as HTMLTextAreaElement).value).toBe("Filtrar por área");
    });
});
