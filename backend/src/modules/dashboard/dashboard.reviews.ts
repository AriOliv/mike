// The one count of contracts reviewed by agents, shared with the home
// screen's "Revisei N contratos" so the two can never disagree.
//
// TEMPORARY COPY of Beacon's countAgentReviews (contracts facade, PR #11,
// commit 5c29079f), same signature and same queries. It lives in #11 because
// it reads contract_reviews, which ships with that PR's migration; this
// branch sits on #6 and cannot import it yet. When #11 lands, delete this
// file and import countAgentReviews from "../contracts/contracts.service".
// The only addition here: a database without contract_reviews yet counts the
// reviewer runs alone instead of failing.

import type { Db } from "../../lib/supabase";

/** The agents whose finished run counts as a contract reviewed. */
export const REVIEW_AGENTS = ["revisor"] as const;

// PostgREST caps an `in` list by URL length; the ids are read in slices.
const ID_CHUNK = 200;

/** Postgres undefined_table, or PostgREST's schema-cache miss for it. */
function isMissingTable(error: { code?: string }): boolean {
    return error.code === "42P01" || error.code === "PGRST205";
}

/**
 * Distinct contracts among `projectIds` with a succeeded run of a review agent,
 * or an automatic review that is ready or done, finished inside
 * [since, until). A null end leaves that side open.
 */
export async function countAgentReviews(
    db: Db,
    projectIds: string[],
    since: string | null,
    until: string | null = null,
): Promise<number> {
    const reviewed = new Set<string>();
    for (let i = 0; i < projectIds.length; i += ID_CHUNK) {
        const slice = projectIds.slice(i, i + ID_CHUNK);
        let runs = db
            .from("agent_runs")
            .select("project_id")
            .in("project_id", slice)
            .in("agent", [...REVIEW_AGENTS])
            .eq("status", "succeeded");
        if (since) runs = runs.gte("finished_at", since);
        if (until) runs = runs.lt("finished_at", until);
        let reviews = db
            .from("contract_reviews")
            .select("project_id")
            .in("project_id", slice)
            .in("status", ["ready", "done"]);
        if (since) reviews = reviews.gte("finished_at", since);
        if (until) reviews = reviews.lt("finished_at", until);
        for (const [table, query] of [
            ["agent_runs", runs],
            ["contract_reviews", reviews],
        ] as const) {
            const { data, error } = await query;
            if (error && table === "contract_reviews" && isMissingTable(error)) continue;
            if (error) throw error;
            for (const row of (data ?? []) as { project_id: string }[]) reviewed.add(row.project_id);
        }
    }
    return reviewed.size;
}
