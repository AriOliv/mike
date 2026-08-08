import { useEffect, useState } from "react";
import { getCustomModels, type CustomModelOption } from "@/app/lib/mikeApi";

// Module-level store so every picker shares one fetch and a refresh propagates
// to all of them. Empty list when no custom endpoint is configured — the app
// works without it.
let cache: CustomModelOption[] | null = null;
let inflight: Promise<CustomModelOption[]> | null = null;
const listeners = new Set<() => void>();

function load(force = false): Promise<CustomModelOption[]> {
    if (force) {
        cache = null;
        inflight = null;
    }
    if (cache) return Promise.resolve(cache);
    if (!inflight) {
        inflight = getCustomModels()
            .then((m) => {
                cache = m;
                listeners.forEach((l) => l());
                return m;
            })
            .catch(() => {
                inflight = null; // don't poison cache — retry on next load
                return [];
            });
    }
    return inflight;
}

// Clear the cache and refetch; mounted pickers update automatically.
export function refreshCustomModels(): Promise<CustomModelOption[]> {
    return load(true);
}

export function useCustomModels(): CustomModelOption[] {
    const [models, setModels] = useState<CustomModelOption[]>(cache ?? []);

    useEffect(() => {
        const update = () => setModels(cache ?? []);
        listeners.add(update);
        void load().then(update);
        return () => {
            listeners.delete(update);
        };
    }, []);

    return models;
}
