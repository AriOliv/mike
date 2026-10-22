// Per-key call budgets the HTTP limiter cannot express: the per-person limit
// of a service token is keyed by the identity link, known only after the
// token and the header are resolved (doc 09 §3.2). One-minute fixed windows,
// per process, like the per-token limiter on the route.

const WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;
const windows = new Map<string, { start: number; count: number }>();

/** Counts one call for `key`; false once `max` calls were made in the current minute. */
export function allowCall(key: string, max: number, now: Date = new Date()): boolean {
    const t = now.getTime();
    const w = windows.get(key);
    if (!w || t - w.start >= WINDOW_MS) {
        if (windows.size >= MAX_KEYS) {
            for (const [k, v] of windows) if (t - v.start >= WINDOW_MS) windows.delete(k);
            if (windows.size >= MAX_KEYS) windows.clear();
        }
        windows.set(key, { start: t, count: 1 });
        return true;
    }
    w.count += 1;
    return w.count <= max;
}

/** For tests. */
export function resetCallLimits(): void {
    windows.clear();
}
