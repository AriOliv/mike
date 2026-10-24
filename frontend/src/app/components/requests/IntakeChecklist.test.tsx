import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestIntake } from "@/app/lib/mikeApi";

const api = vi.hoisted(() => ({ getRequestIntake: vi.fn(), answerRequestIntake: vi.fn() }));
vi.mock("@/app/lib/mikeApi", () => api);
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("@/app/components/ui/toast", () => toast);
const errors = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock("@/app/lib/userFacingError", () => errors);

import { IntakeChecklist, PREFILL_POLL_MS, RequestIntakeSection } from "./IntakeChecklist";

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
        prefill: null,
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

    it("says when the agent is reading the contract or could not, and nothing once complete", () => {
        const { rerender } = render(<IntakeChecklist intake={intake({ prefill: "lendo" })} onAnswer={vi.fn()} />);
        expect(screen.getByRole("status")).toHaveTextContent("O agente está lendo o contrato");
        rerender(<IntakeChecklist intake={intake({ prefill: "falhou" })} onAnswer={vi.fn()} />);
        expect(screen.getByRole("status")).toHaveTextContent("O agente não conseguiu ler o contrato agora. Responda as perguntas abaixo.");
        rerender(<IntakeChecklist intake={intake({ prefill: "falhou", complete: true })} onAnswer={vi.fn()} />);
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("words the open questions for the team", () => {
        render(<IntakeChecklist intake={intake()} onAnswer={vi.fn()} audience="team" />);
        expect(screen.getByText("Falta saber de quem pediu")).toBeInTheDocument();
    });
});

describe("IntakeChecklist por tipo", () => {
    const ndaItems: RequestIntake["items"] = [
        {
            key: "quem_compartilha",
            label: "Quem vai compartilhar informação?",
            kind: "choice",
            required: true,
            options: [
                { value: "nos", label: "Só nós" },
                { value: "eles", label: "Só eles" },
                { value: "ambos", label: "Os dois" },
            ],
            answer: null,
            state: "pendente",
        },
        {
            key: "o_que_muda",
            label: "O que muda?",
            kind: "multi_choice",
            required: true,
            options: [
                { value: "prazo", label: "Prazo" },
                { value: "valor", label: "Valor" },
            ],
            answer: null,
            state: "pendente",
        },
        { key: "duvida", label: "O que você quer saber?", kind: "long_text", required: true, no_unknown: true, answer: null, state: "pendente" },
    ];
    const nda = (over: Partial<RequestIntake> = {}) =>
        intake({ items: ndaItems, pending: ["quem_compartilha", "o_que_muda", "duvida"], to_confirm: [], answered: 0, total: 3, kind: "nda", ...over });

    it("sends the code of one choice and the codes of several, never the label", () => {
        const onAnswer = vi.fn();
        render(<IntakeChecklist intake={nda()} onAnswer={onAnswer} />);
        fireEvent.click(screen.getByLabelText("Os dois"));
        fireEvent.click(screen.getByLabelText("Prazo"));
        fireEvent.click(screen.getByLabelText("Valor"));
        fireEvent.click(screen.getByLabelText("Valor"));
        fireEvent.click(screen.getByRole("button", { name: "Salvar respostas" }));
        expect(onAnswer).toHaveBeenCalledWith({ answers: { quem_compartilha: "ambos", o_que_muda: ["prazo"] } });
    });

    it("lets the person say they do not know, except where the question does not allow it", () => {
        const onAnswer = vi.fn();
        render(<IntakeChecklist intake={nda()} onAnswer={onAnswer} />);
        const form = screen.getByRole("form", { name: "Perguntas pendentes" });
        expect(form.querySelectorAll("button[aria-pressed]")).toHaveLength(2);
        fireEvent.click(screen.getAllByRole("button", { name: "Não sei" })[0]);
        expect(screen.getByText(/Você marcou que não sabe/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Salvar respostas" }));
        expect(onAnswer).toHaveBeenCalledWith({ answers: { quem_compartilha: { unknown: true } } });
    });

    it("shows an answer given as 'não sei' and lets the person change it", () => {
        const answered = ndaItems.map((i) =>
            i.key === "quem_compartilha"
                ? { ...i, state: "confirmado" as const, answer: { value: "Não sei", unknown: true as const, source: "requester" as const, confirmed: true, updated_at: at } }
                : i,
        );
        const onAnswer = vi.fn();
        render(<IntakeChecklist intake={nda({ items: answered, answered: 1 })} onAnswer={onAnswer} />);
        expect(screen.getByText("Não sei", { selector: "span" })).toHaveClass("italic");
        fireEvent.click(screen.getByRole("button", { name: "Mudar" }));
        fireEvent.click(screen.getByRole("button", { name: "Prefiro responder" }));
        fireEvent.click(screen.getByLabelText("Só eles"));
        fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
        expect(onAnswer).toHaveBeenCalledWith({ answers: { quem_compartilha: "eles" } });
    });

    it("says there is nothing to fill instead of 0 de 0", () => {
        render(<IntakeChecklist intake={nda({ items: [], pending: [], total: 0, complete: true, nothing_to_fill: true })} onAnswer={vi.fn()} />);
        expect(screen.getByText("Nada a preencher neste tipo de pedido")).toBeInTheDocument();
        expect(screen.queryByText(/de 0/)).not.toBeInTheDocument();
    });

    it("explains why the number of questions changed when the type did", () => {
        render(<IntakeChecklist intake={nda({ kind_changed: { from: "revisao", to: "nda" }, total: 6 })} onAnswer={vi.fn()} />);
        expect(screen.getByRole("status")).toHaveTextContent("O tipo mudou de Revisar um contrato para NDA: agora são 6 perguntas.");
    });
});

describe("RequestIntakeSection", () => {
    it("keeps the type-changed notice until a saved answer comes back without it, with no new GET", async () => {
        const changed = intake({ kind: "nda", kind_changed: { from: "revisao", to: "nda" }, total: 4 });
        api.getRequestIntake.mockResolvedValue(changed);
        api.answerRequestIntake.mockResolvedValue({ ...changed, kind_changed: null });
        render(<RequestIntakeSection requestId="r1" audience="requester" />);
        expect(await screen.findByText(/O tipo mudou de Revisar um contrato para NDA/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
        await waitFor(() => expect(screen.queryByText(/O tipo mudou de/)).not.toBeInTheDocument());
        expect(api.getRequestIntake).toHaveBeenCalledTimes(1);
    });

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

    it("looks again while the agent reads the contract, even after a failed look", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            api.getRequestIntake
                .mockResolvedValueOnce(intake({ prefill: "lendo" }))
                .mockRejectedValueOnce(new Error("rede"))
                .mockResolvedValueOnce(intake({ prefill: "concluido" }));
            render(<RequestIntakeSection requestId="r1" audience="requester" />);
            expect(await screen.findByRole("status")).toHaveTextContent("O agente está lendo o contrato");
            await vi.advanceTimersByTimeAsync(PREFILL_POLL_MS);
            await waitFor(() => expect(api.getRequestIntake).toHaveBeenCalledTimes(2));
            // A failed look keeps what is on screen and tries again.
            expect(screen.getByRole("status")).toBeInTheDocument();
            await vi.advanceTimersByTimeAsync(PREFILL_POLL_MS);
            await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
            expect(api.getRequestIntake).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it("stops looking once the agent is done", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            api.getRequestIntake.mockResolvedValueOnce(intake({ prefill: "lendo" })).mockResolvedValue(intake({ prefill: "concluido" }));
            render(<RequestIntakeSection requestId="r1" audience="requester" />);
            await screen.findByRole("status");
            await vi.advanceTimersByTimeAsync(PREFILL_POLL_MS);
            await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
            await vi.advanceTimersByTimeAsync(PREFILL_POLL_MS * 3);
            expect(api.getRequestIntake).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
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
