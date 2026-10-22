import { useState } from "react";
import {
    VerdictCountsUI,
    VerdictLabelUI,
    type VerdictTally,
} from "@/shared/ui/VerdictUI";

const meta = { title: "Shared UI / Verdict" };
export default meta;

/** The label on one finding. Colour always comes with an icon and a word. */
export const Labels = () => (
    <div className="flex flex-wrap items-center gap-2">
        <VerdictLabelUI verdict="diverge" />
        <VerdictLabelUI verdict="precisa_revisao" />
        <VerdictLabelUI verdict="alinhado" />
        <VerdictLabelUI verdict="nao_aplica" />
        <VerdictLabelUI verdict="diverge" label="Exige ação" />
    </div>
);

/** In a table row: icon and number only. A zero stays, in grey. */
export const Compact = () => (
    <div className="space-y-2 text-sm">
        <VerdictCountsUI alinhado={8} precisa_revisao={6} diverge={3} />
        <VerdictCountsUI alinhado={12} precisa_revisao={0} diverge={0} />
    </div>
);

/** In a side panel or a review's header: each tile filters the findings. */
export const TilesAsFilter = () => {
    const [selected, setSelected] = useState<keyof VerdictTally | null>("diverge");
    return (
        <div className="max-w-md space-y-2">
            <VerdictCountsUI
                variant="tiles"
                alinhado={8}
                precisa_revisao={6}
                diverge={3}
                selected={selected}
                onSelect={setSelected}
            />
            <p className="text-xs text-gray-500">
                Filtro: {selected ?? "nenhum"}
            </p>
        </div>
    );
};
