import { API_BASE } from "@/app/lib/mikeApi";
import { authenticatedFetch } from "@/app/lib/authEvents";
import type { NavRole } from "@/app/lib/navItems";

const ROLES: readonly NavRole[] = ["head", "team", "requester"];

/**
 * The caller's role for the menu, from GET /requests/me. Any failure, a
 * server without that route included, answers null, and the menu then shows
 * everything: hiding the team's pages from the team would be worse than
 * showing them to someone who asks. For the same reason a deployment with no
 * Legal team configured (`configured: false`) answers null: there is nobody
 * to ask, so everyone keeps the whole menu.
 */
export async function loadNavRole(signal?: AbortSignal): Promise<NavRole | null> {
    try {
        const response = await authenticatedFetch(`${API_BASE}/requests/me`, {
            cache: "no-store",
            headers: { Accept: "application/json" },
            signal,
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { configured?: unknown; role?: unknown };
        if (body.configured === false) return null;
        return ROLES.includes(body.role as NavRole) ? (body.role as NavRole) : null;
    } catch {
        return null;
    }
}
