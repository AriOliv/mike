"use client";

import type { ReactNode } from "react";
import { cn } from "@/app/lib/utils";

export type StatTile = {
    id: string;
    value: number | string;
    label: string;
    /** A line under the label, e.g. "o mais próximo em 4 dias". */
    hint?: ReactNode;
    /** Draws the number in the colour of something that needs action. */
    tone?: "default" | "atencao" | "critico";
};

export type StatTilesProps = {
    tiles: StatTile[];
    /** Makes each tile a filter; called again with null to clear it. */
    onSelect?: (id: string | null) => void;
    selected?: string | null;
    loading?: boolean;
    className?: string;
};

const NUMBER_TONE = {
    default: "text-gray-900",
    atencao: "text-amber-700",
    critico: "text-red-700",
} as const;

/**
 * The counters at the top of a screen. Each tile filters the list below it;
 * pressing the selected tile again clears the filter. At most four in a row.
 */
export function StatTiles({ tiles, onSelect, selected = null, loading = false, className }: StatTilesProps) {
    return (
        <div
            role="group"
            aria-label="Contadores"
            className={cn("grid grid-cols-2 gap-2 md:grid-cols-4", className)}
        >
            {tiles.map((tile) => {
                const pressed = selected === tile.id;
                const shape = cn(
                    "flex min-w-0 flex-col items-start gap-1 rounded-xl border p-4 text-left",
                    pressed ? "border-gray-300 bg-app-surface-active" : "border-gray-200 bg-app-surface",
                );
                const content = loading ? (
                    <>
                        <span className="h-8 w-10 animate-pulse rounded bg-gray-100" />
                        <span className="h-3 w-24 animate-pulse rounded bg-gray-100" />
                    </>
                ) : (
                    <>
                        <span
                            className={cn(
                                "font-serif text-3xl leading-none tabular-nums",
                                NUMBER_TONE[tile.tone ?? "default"],
                            )}
                        >
                            {tile.value}
                        </span>
                        <span className="text-xs text-gray-500">{tile.label}</span>
                        {tile.hint ? <span className="text-[11px] text-gray-400">{tile.hint}</span> : null}
                    </>
                );
                if (!onSelect || loading)
                    return (
                        <div key={tile.id} data-tile={tile.id} className={shape}>
                            {content}
                        </div>
                    );
                return (
                    <button
                        key={tile.id}
                        type="button"
                        data-tile={tile.id}
                        aria-pressed={pressed}
                        onClick={() => onSelect(pressed ? null : tile.id)}
                        className={cn(
                            shape,
                            "transition-colors hover:bg-app-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40",
                        )}
                    >
                        {content}
                    </button>
                );
            })}
        </div>
    );
}
