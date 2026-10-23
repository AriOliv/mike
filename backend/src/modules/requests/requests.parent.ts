// The contract an amendment or renewal changes (U-05). The requester finds it
// among the organization's contracts by name or counterparty; the pick ties the
// request to that contract's card (legal_requests.parent_project_id), which is
// what the term and the renewal alerts follow. "Não está no Mike" is simply a
// typed answer: no link.
//
// The list never browses: two letters at least, a handful of results, and only
// the name and the counterparty. Never the text of a contract.

import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { loadLegalTeam, NO_LEGAL_TEAM } from "./requests.access";
import { cleanText } from "./requests.shared";

export type ContractChoice = { id: string; name: string; counterparty: string | null };

const MIN_QUERY = 2;
const MAX_RESULTS = 8;
/** A team's portfolio is read once per search and filtered here, so name and counterparty match alike. */
const SCAN = 1000;

const fold = (s: string) =>
    s
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

/** The label an answer shows for a picked contract. */
export function contractLabel(c: Pick<ContractChoice, "name" | "counterparty">): string {
    return c.counterparty && !fold(c.name).includes(fold(c.counterparty)) ? `${c.name} · ${c.counterparty}` : c.name;
}

/** Contracts of the legal team's organization matching `q` by name or counterparty. */
export async function searchContracts(db: Db, query: unknown): Promise<ServiceResult<{ contracts: ContractChoice[] }>> {
    const q = cleanText(query, 100);
    if (!q || q.length < MIN_QUERY) return failure("validation", "Digite pelo menos duas letras do nome ou da contraparte.");
    try {
        const team = await loadLegalTeam(db);
        if (!team) return NO_LEGAL_TEAM;
        const { data, error } = await db
            .from("projects")
            .select("id, name, counterparty")
            .eq("org_id", team.org_id)
            .is("archived_at", null)
            .order("name", { ascending: true })
            .limit(SCAN);
        if (error) throw error;
        const needle = fold(q);
        const found = ((data ?? []) as ContractChoice[])
            .filter((p) => fold(p.name).includes(needle) || fold(p.counterparty ?? "").includes(needle))
            .slice(0, MAX_RESULTS)
            .map((p) => ({ id: p.id, name: p.name, counterparty: p.counterparty }));
        return ok({ contracts: found });
    } catch (error) {
        return internalFailure(error);
    }
}

/** One contract of the team's organization, for a pick; null when it is not one. */
export async function findContract(db: Db, orgId: string, id: unknown): Promise<ContractChoice | null> {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { data } = await db
        .from("projects")
        .select("id, name, counterparty")
        .eq("id", id)
        .eq("org_id", orgId)
        .is("archived_at", null)
        .maybeSingle();
    return (data as ContractChoice | null) ?? null;
}
