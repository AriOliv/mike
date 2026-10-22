import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestIntake } from "@/app/lib/mikeApi";

const api = vi.hoisted(() => ({ getRequestIntake: vi.fn(), answerRequestIntake: vi.fn() }));
vi.mock("@/app/lib/mikeApi", () => api);
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("@/app/components/ui/toast", () => toast);
const errors = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock("@/app/lib/userFacingError", () => errors);

import { IntakeChecklist, RequestIntakeSection } from "./IntakeChecklist";

const at = "2026-10-22T12:00:00Z";
function intake(over: Partial<RequestIntake> = {}): RequestIntake {
    return {
        request_id: "r1",
        items: [
            {
                key: "contraparte",
                label: "Nome da contraparte",
                kind: "text",
                required: true,
                answer: { value: "Nuvem Fictícia S.A.", source: "requester", confirmed: true, updated_at: at },
                state: "confirmado",
            },
            {
                key: "valor",
                label: "Valor e recorrência de pagamento",
                kind: "money",
                required: true,
                answer: { value: "R$ 12.000,00 por mês", source: "inferred", confirmed: false, quote: "O valor mensal é de R$ 12.000,00", updated_at: at },
                state: "inferido",
            },
            {
                key: "confidencial",
                label: "Há compartilhamento de informação confidencial?",
                kind: "yes_no",
                required: true,
                detail_label: "Quem compartilha?",
                answer: null,
                state: "pendente",
            },
            { key: "obs", label: "Algo mais?", kind: "long_text", required: false, hint: "Livre.", answer: null, state: "pendente" },
        ],
        pending: ["valor", "confidencial"],
        to_confirm: ["valor"],
        complete: false,
        answered: 1,
        total: 4,
        completed_at: null,
        can_answer: true,
        template_source: "padrao",
        ...over,
    };
}

beforeEach(() => {
    api.getRequestIntake.mockReset();
    api.answerRequestIntake.mockReset();
    toast.showToast.mockReset();
    errors.notifyError.mockReset();
});

describe("IntakeChecklist", () => {
    it("shows what is confirmed, what the agent read (with the contract's words) and asks only what is open", () => {
        render(<IntakeChecklist intake={intake()} onAnswer={vi.fn()} />);
        expect(screen.getByText("1 de 4 respondidas")).toBeInTheDocument();
        expect(screen.getByText("· 1 lida no contrato para confirmar")).toBeInTheDocument();
        expect(screen.getByText("“O valor mensal é de R$ 12.000,00”")).toBeInTheDocument();
        expect(screen.getByText("Lido no contrato pelo agente. Confirme ou corrija.")).toBeInTheDocument();
        const form = screen.getByRole("form", { name: "Perguntas pendentes" });
        expect(form).toHaveTextContent("Há compartilhamento de informação confidencial?");
        expect(form).toHaveTextContent("(opcional)");
        expect(form).not.toHaveTextContent("Nome da contraparte");
    });

    it("confirms an inferred answer in one click", () => {
        const onAnswer = vi.fn();
        render(<IntakeChecklist intake={intake()} onAnswer={onAnswer} />);
        fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
        expect(onAnswer).toHaveBeenCalledWith({ confirm: ["valor"] });
    });

    it("corrects an inferred answer in place", () => {
        const onAnswer = vi.fn();
        render(<IntakeChecklist intake={intake()} onAnswer={onAnswer} />);
        fireEvent.click(screen.getByRole("button", { name: "Corrigir" }));
        const field = screen.getByDisplayValue("R$ 12.000,00 por mês");
        fireEvent.change(field, { target: { value: "R$ 10.000 por mês" } });
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        expect(onAnswer).toHaveBeenCalledWith({ answers: { valor: "R$ 10.000 por mês" } });
    });

    it("sends the open answers, with the detail of a yes", () => {
        const onAnswer = vi.fn();
        render(<IntakeChecklist intake={intake()} onAnswer={onAnswer} />);
        const save = screen.getByRole("button", { name: "Salvar respostas" });
        expect(save).toBeDisabled();
        fireEvent.click(screen.getByLabelText("Sim"));
        fireEvent.change(screen.getByLabelText("Quem compartilha?"), { target: { value: "As duas partes" } });
        fireEvent.change(screen.getByLabelText(/Algo mais\?/), { target: { value: "Urgente" } });
        fireEvent.click(save);
        expect(onAnswer).toHaveBeenCalledWith({
            answers: { confidencial: { value: "sim", detail: "As duas partes" }, obs: "Urgente" },
        });
    });

    it("only lists what is open when the viewer may not answer, and says when it is complete", () => {
        const { rerender } = render(<IntakeChecklist intake={intake({ can_answer: false })} onAnswer={vi.fn()} />);
        expect(screen.queryByRole("form", { name: "Perguntas pendentes" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Confirmar" })).not.toBeInTheDocument();
        expect(screen.getByText("Algo mais?")).toBeInTheDocument();
        rerender(<IntakeChecklist intake={intake({ complete: true, items: intake().items.slice(0, 1), to_confirm: [] })} onAnswer={vi.fn()} audience="team" />);
        expect(screen.getByText("Checklist completo")).toBeInTheDocument();
    });

    it("words the open questions for the team", () => {
        render(<IntakeChecklist intake={intake()} onAnswer={vi.fn()} audience="team" />);
        expect(screen.getByText("Falta saber de quem pediu")).toBeInTheDocument();
    });
});

describe("RequestIntakeSection", () => {
    it("loads, saves, and says when the checklist closes", async () => {
        api.getRequestIntake.mockResolvedValue(intake());
        api.answerRequestIntake.mockResolvedValue(intake({ complete: true }));
        const onChanged = vi.fn();
        render(<RequestIntakeSection requestId="r1" audience="requester" onChanged={onChanged} />);
        fireEvent.click(await screen.findByRole("button", { name: "Confirmar" }));
        await waitFor(() => expect(api.answerRequestIntake).toHaveBeenCalledWith("r1", { confirm: ["valor"] }));
        await waitFor(() => expect(onChanged).toHaveBeenCalled());
        expect(toast.showToast).toHaveBeenCalledWith(expect.objectContaining({ message: "Checklist completo. O Legal já pode analisar o contrato." }));
    });

    it("tells the person when saving fails, and renders nothing when it cannot load", async () => {
        api.getRequestIntake.mockResolvedValueOnce(intake());
        api.answerRequestIntake.mockRejectedValue(new Error("x"));
        const { unmount } = render(<RequestIntakeSection requestId="r1" audience="requester" />);
        fireEvent.click(await screen.findByRole("button", { name: "Confirmar" }));
        await waitFor(() => expect(errors.notifyError).toHaveBeenCalledWith(expect.any(Error), { lang: "pt", action: "salvar as respostas" }));
        unmount();
        api.getRequestIntake.mockRejectedValue(new Error("404"));
        const { container } = render(<RequestIntakeSection requestId="r2" audience="team" />);
        await waitFor(() => expect(api.getRequestIntake).toHaveBeenCalledWith("r2"));
        expect(container).toBeEmptyDOMElement();
    });
});
