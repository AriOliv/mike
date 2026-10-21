import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentPlan, type AgentPlanStep } from "./AgentPlan";

const steps: AgentPlanStep[] = [
    { id: "1", owner: { kind: "agent", name: "Agente de triagem" }, task: "classificou como NDA", state: "feito" },
    { id: "2", owner: { kind: "requester", name: "Ana" }, task: "enviar a minuta", state: "aguardando" },
    { id: "3", owner: { kind: "person", name: "Duda" }, task: "analisar e decidir", state: "rodando" },
    { id: "4", owner: { kind: "person", name: "Duda" }, task: "devolver ao solicitante", state: "a_fazer", asksFirst: true },
    { id: "5", owner: { kind: "person", name: "Téo" }, task: "conferir", state: "feito" },
];

describe("AgentPlan", () => {
    it("lists people and agents in order with their state in words", () => {
        render(<AgentPlan steps={steps} />);
        expect(screen.getByText("2 de 5 passos feitos · 1 por agentes")).toBeInTheDocument();
        expect(screen.getByRole("img", { name: "Agente" })).toBeInTheDocument();
        expect(screen.getByText("· solicitante")).toBeInTheDocument();
        for (const word of ["feito", "aguardando", "em andamento", "a fazer"]) {
            expect(screen.getAllByText(word).length).toBeGreaterThan(0);
        }
        expect(screen.getByText("pede ok antes")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "trocar" })).not.toBeInTheDocument();
    });

    it("offers to change the person on open people's steps only", () => {
        const onChangeOwner = vi.fn();
        render(<AgentPlan title="Plano do pedido" steps={steps} onChangeOwner={onChangeOwner} />);
        expect(screen.getByRole("region", { name: "Plano do pedido" })).toBeInTheDocument();
        const buttons = screen.getAllByRole("button", { name: "trocar" });
        expect(buttons).toHaveLength(2);
        fireEvent.click(buttons[1]);
        expect(onChangeOwner).toHaveBeenCalledWith("4");
    });
});
