import { useState } from "react";
import { StatTiles } from "@/app/components/ui/stat-tiles";

const meta = { title: "UI / StatTiles" };
export default meta;

const tiles = [
    { id: "prontos", value: 26, label: "Prontos p/ revisar" },
    { id: "meus", value: 9, label: "Atribuídos a você" },
    { id: "avisos", value: 3, label: "Avisos em 30 dias", tone: "critico" as const, hint: "o mais próximo em 4 dias" },
    { id: "pastas", value: 2, label: "Pastas monitoradas" },
];

/** Each tile filters the list below it. */
export const Filterable = () => {
    const [selected, setSelected] = useState<string | null>(null);
    return <StatTiles tiles={tiles} onSelect={setSelected} selected={selected} />;
};

export const Loading = () => <StatTiles tiles={tiles} loading />;
