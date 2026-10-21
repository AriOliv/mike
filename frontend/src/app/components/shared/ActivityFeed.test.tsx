import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActivityFeed, type ActivityItem } from "./ActivityFeed";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const items: ActivityItem[] = [
    { id: "1", actorType: "user", actorName: "Duda", verb: "comentou", at: "2026-10-20T11:55:00Z" },
    {
        id: "2",
        actorType: "agent",
        actorName: "Agente de revisão",
        verb: "revisou",
        object: "NDA.docx",
        sources: 3,
        at: "2026-10-20T10:00:00Z",
        href: "/playbooks/p/runs/r",
    },
    { id: "3", actorType: "hermes", actorName: "Assistente no Slack", verb: "criou o pedido", at: "2026-10-19T10:00:00Z" },
    { id: "4", actorType: "system", actorName: "Mike", verb: "passou a monitorar a pasta", at: "2026-10-19T09:00:00Z" },
];

describe("ActivityFeed", () => {
    it("tells people and agents apart and links to what an agent did", () => {
        render(<ActivityFeed items={items} now={NOW} />);
        expect(screen.getByText(/Duda comentou/)).toBeInTheDocument();
        expect(screen.getByText(/Agente de revisão revisou NDA.docx com 3 fontes/)).toBeInTheDocument();
        expect(screen.getByRole("img", { name: "Agente" })).toBeInTheDocument();
        expect(screen.getByRole("img", { name: "Assistente" })).toBeInTheDocument();
        expect(screen.getByRole("img", { name: "Sistema" })).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /ver o que fez/ })).toHaveAttribute("href", "/playbooks/p/runs/r");
        expect(screen.getByText(/há 5 min/)).toBeInTheDocument();
    });

    it("lists an agent's steps when there is no link, and who confirmed it", () => {
        render(
            <ActivityFeed
                now={NOW}
                items={[
                    {
                        id: "9",
                        actorType: "agent",
                        actorName: "Agente de atribuição",
                        verb: "atribuiu a",
                        object: "duda",
                        at: "2026-10-20T10:00:00Z",
                        steps: ["leu a carga do time", "sugeriu Duda"],
                        confirmedBy: "Fernanda",
                    },
                ]}
            />,
        );
        expect(screen.getByText(/confirmado por Fernanda/)).toBeInTheDocument();
        expect(screen.getByText("ver o que fez ▸").tagName).toBe("SUMMARY");
        expect(screen.getByText("sugeriu Duda")).toBeInTheDocument();
    });

    it("limits the lines and offers the rest", () => {
        render(<ActivityFeed items={items} limit={2} seeAllHref="/inicio" now={NOW} />);
        expect(screen.getAllByRole("listitem")).toHaveLength(2);
        expect(screen.getByRole("link", { name: "Ver tudo (4)" })).toHaveAttribute("href", "/inicio");
    });

    it("has a loading state and an empty state", () => {
        const { rerender, container } = render(<ActivityFeed items={[]} loading />);
        expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
        rerender(<ActivityFeed items={[]} emptyText="Sem atividade." />);
        expect(screen.getByText("Sem atividade.")).toBeInTheDocument();
    });
});
