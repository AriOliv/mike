// Labels and form helpers for Configurações → Integrações → Notion. The
// server checks everything again; these keep the mapping form honest.

import type { NotionLane, NotionStageTarget } from "./mikeApi";

export const LANE_LABEL: Record<NotionLane, string> = {
    entrada: "Entrada",
    triagem: "Triagem",
    revisao: "Revisão",
    negociacao: "Negociação",
    assinatura: "Assinatura",
    arquivado: "Arquivado",
};

export const OWNER_LABEL: Record<"legal" | "mike" | "key", string> = {
    legal: "o Legal edita no Notion; vale a última edição",
    mike: "o Mike calcula; o Mike manda",
    key: "identifica o card",
};

/** A Notion token looks like an internal integration token. */
export function looksLikeToken(value: string): boolean {
    return /^(ntn_|secret_)[A-Za-z0-9]{20,120}$/.test(value.trim());
}

/** The Mike field each property feeds, inverted: field → property, for the form. */
export function propertyOf(fieldMap: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(fieldMap).map(([property, field]) => [field, property]));
}

/** Points a Mike field at a property (or none), keeping each property used once. */
export function assign(fieldMap: Record<string, string>, field: string, property: string | null): Record<string, string> {
    const next = Object.fromEntries(Object.entries(fieldMap).filter(([p, f]) => f !== field && p !== property));
    if (property) next[property] = field;
    return next;
}

/** What is still missing before the mapping can be saved, in words. */
export function mappingProblems(fieldMap: Record<string, string>, stageOptions: string[], stageMap: Record<string, NotionStageTarget>): string[] {
    const fields = new Set(Object.values(fieldMap));
    const problems: string[] = [];
    if (!fields.has("name")) problems.push("Escolha a propriedade com o nome do contrato.");
    if (!fields.has("lane")) problems.push("Escolha a propriedade com a etapa.");
    const missing = stageOptions.filter((o) => !stageMap[o]);
    if (missing.length) problems.push(`Escolha a etapa do Mike para ${missing.join(", ")}.`);
    return problems;
}

/** The properties of a type a field accepts, by name. */
export function propertiesFor(properties: { name: string; type: string }[], types: string[]): string[] {
    return properties.filter((p) => types.includes(p.type)).map((p) => p.name);
}

export const MATCH_LABEL: Record<"linked" | "project" | "duplicate" | "new", { label: string; hint: string }> = {
    new: { label: "Novos", hint: "viram cards no Mike" },
    project: { label: "Pelo ID", hint: "o ProjectId da página aponta para um card do Mike" },
    duplicate: { label: "Duplicados", hint: "mesmo contrato e contraparte de um card que já existe; são ligados a ele" },
    linked: { label: "Já ligados", hint: "importados antes; ficam como estão" },
};
