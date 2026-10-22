import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RequestStageRow, RequestStageStrip } from "@/app/lib/mikeApi";
import { StageStrip } from "./StageStrip";

const now = Date.parse("2026-10-20T12:00:00Z");
const LABELS: [RequestStageStrip["stage"], string][] = [
    ["recebido", "Recebido"],
    ["triagem", "Triagem"],
    ["checklist", "Checklist"],
    ["analise", "Análise"],
    ["negociacao", "Negociação"],
    ["assinatura", "Assinatura"],
    ["concluido", "Concluído"],
];

function strip(current: RequestStageStrip["stage"], over: Partial<RequestStageStrip> = {}): RequestStageStrip {
    const at = LABELS.findIndex(([s]) => s === current);
    return {
        stage: current,
        label: LABELS[at][1],
        position: at > 0 && at < 6 ? { index: at, of: 5 } : null,
        owner: { kind: "person", id: "u1", name: "Téo" },
        since: "2026-10-19T09:00:00Z",
        strip: LABELS.map(([stage, label], i) => ({
            stage,
            label,
            state: current === "concluido" || i < at ? "concluida" : i === at ? "atual" : "pendente",
            owner: null,
            since: null,
        })),
        ...over,
    };
}

const history: RequestStageRow[] = [
    { stage: "recebido", owner_kind: "agent", owner_name: "Agente de triagem", entered_at: "2026-10-18T09:00:00Z", left_at: "2026-10-18T09:01:00Z", note: "pedido recebido" },
    { stage: "analise", owner_kind: "person", owner_name: "Téo", entered_at: "2026-10-19T09:00:00Z", left_at: null, note: "responsável definido" },
];

describe("StageStrip", () => {
    it("names the current stage, its position, who has it and since when", () => {
        render(<StageStrip stage={strip("analise")} stages={history} now={now} />);
        const region = screen.getByRole("region", { name: "Etapa do pedido" });
        expect(within(region).getByText("Análise", { selector: "p" })).toBeInTheDocument();
        expect(within(region).getByText("Etapa 3 de 5")).toBeInTheDocument();
        expect(within(region).getByText("com Téo, desde ontem")).toBeInTheDocument();
        const items = screen.getAllByRole("list", { name: "Etapas" })[0];
        expect(within(items).getByText("Análise").closest("li")).toHaveAttribute("aria-current", "step");
    });

    it("shows no position on the two ends and leaves out the time when there is no history", () => {
        render(<StageStrip stage={strip("recebido", { since: null, owner: { kind: "agent", id: null, name: "Agente de triagem" } })} now={now} />);
        expect(screen.queryByText(/Etapa \d de/)).not.toBeInTheDocument();
        expect(screen.getByText("com o agente de triagem")).toBeInTheDocument();
        expect(screen.getByText("IA")).toBeInTheDocument();
        expect(screen.queryByRole("list", { name: "Linha do tempo" })).not.toBeInTheDocument();
    });

    it("puts the amber on the requester's turn and on a stage nobody holds, and nowhere else", () => {
        const { rerender } = render(
            <StageStrip stage={strip("checklist", { owner: { kind: "requester", id: null, name: "Ana" } })} now={now} />,
        );
        expect(screen.getByText("aguardando Ana, desde ontem")).toHaveClass("text-amber-700");
        rerender(<StageStrip stage={strip("analise", { owner: { kind: "none", id: null, name: null } })} now={now} />);
        expect(screen.getByText("sem responsável, desde ontem")).toHaveClass("text-amber-700");
        rerender(<StageStrip stage={strip("analise")} now={now} />);
        expect(screen.getByText("com Téo, desde ontem")).not.toHaveClass("text-amber-700");
    });

    it("lists the timeline with the current stage first, and the agent marked as IA", () => {
        render(<StageStrip stage={strip("analise")} stages={history} now={now} />);
        const rows = within(screen.getByRole("list", { name: "Linha do tempo" })).getAllByRole("listitem");
        expect(rows).toHaveLength(2);
        expect(rows[0]).toHaveTextContent("Análise");
        expect(rows[0]).toHaveTextContent("Téo");
        expect(rows[0]).toHaveTextContent("responsável definido");
        expect(rows[1]).toHaveTextContent("Recebido");
        expect(rows[1]).toHaveTextContent("IA");
    });

    it("says nothing about who holds a finished request", () => {
        render(<StageStrip stage={strip("concluido", { owner: { kind: "none", id: null, name: null } })} now={now} />);
        expect(screen.getByText("Concluído", { selector: "p" })).toBeInTheDocument();
        expect(screen.queryByText(/sem responsável/)).not.toBeInTheDocument();
    });
});
