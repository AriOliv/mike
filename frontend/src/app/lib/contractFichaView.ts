// How the Ficha reads on screen: fields grouped like the Legal team's
// spreadsheet, and each structured value said in one PT-BR line ("Automática,
// aviso de 30 dias corridos"). The value stays structured in the Ficha; this is
// only its wording.

import type { FichaChoices, FichaField } from "./mikeApi";

export const FICHA_GROUPS: { title: string; fields: [string, string][] }[] = [
    {
        title: "Identificação",
        fields: [
            ["identificacao.tipo_contrato", "Tipo de contrato"],
            ["identificacao.contraparte", "Contraparte"],
            ["identificacao.papel_avenia", "Papel da Avenia"],
        ],
    },
    {
        title: "Vigência e rescisão",
        fields: [
            ["vigencia.prazo", "Prazo de vigência"],
            ["vigencia.renovacao", "Renovação"],
            ["rescisao.imotivada", "Rescisão sem justa causa"],
            ["rescisao.multa_rescisoria", "Multa rescisória"],
        ],
    },
    {
        title: "Alteração de parte",
        fields: [
            ["alteracao_parte.cessao", "Cessão"],
            ["alteracao_parte.mudanca_controle", "Mudança de controle"],
        ],
    },
    {
        title: "Dados pessoais",
        fields: [
            ["dados_pessoais.compartilhamento", "Compartilha dados pessoais"],
            ["dados_pessoais.papel_avenia", "Papel LGPD da Avenia"],
            ["dados_pessoais.dpa", "Regras de tratamento (DPA)"],
            ["dados_pessoais.transferencia_internacional", "Transferência internacional"],
        ],
    },
    {
        title: "Responsabilidade, confidencialidade e foro",
        fields: [
            ["responsabilidade.limitacao", "Limitação de responsabilidade"],
            ["responsabilidade.multa_geral", "Multa por descumprimento"],
            ["regulatorio.confidencialidade", "Confidencialidade e reguladores"],
            ["foro.lei_aplicavel", "Lei aplicável"],
        ],
    },
];

const WORDS: Record<string, string> = {
    automatica: "automática",
    mediante_aditivo: "mediante aditivo",
    opcao_unilateral: "opção unilateral",
    sem_renovacao: "sem renovação",
    nao_regulada: "não regulada",
    determinado: "determinado",
    indeterminado: "indeterminado",
    ambas: "ambas as partes",
    somente_avenia: "só a Avenia",
    somente_contraparte: "só a contraparte",
    nenhuma: "nenhuma parte",
    livre: "livre",
    notificacao: "mediante notificação",
    consentimento_previo: "com consentimento prévio",
    vedada: "vedada",
    avenia: "Avenia",
    contraparte: "contraparte",
    contratante: "contratante",
    contratada: "contratada",
    controlador: "controladora",
    operador: "operadora",
    controlador_conjunto: "controladora conjunta",
    suboperador: "suboperadora",
    nao_definido: "não definido",
    no_corpo: "no corpo do contrato",
    anexo: "em anexo",
    por_referencia: "só por referência (documento externo)",
    ausente: "ausente",
    percentual_valor_total: "% do valor total",
    percentual_saldo: "% do saldo",
    meses_remuneracao: "meses de remuneração",
    ilimitada: "ilimitada",
    afiliadas: "afiliadas",
    prestacao_servicos: "prestação de serviços",
    parceiro_bancario_baas: "parceiro bancário / BaaS",
    licenca_saas: "licença SaaS",
};

const word = (value: unknown) => (typeof value === "string" ? (WORDS[value] ?? value.replace(/_/g, " ")) : "");

const number = (n: number) => n.toLocaleString("pt-BR");

function duration(value: unknown): string {
    if (!value || typeof value !== "object") return "";
    const { amount, unit, day_count } = value as { amount?: number; unit?: string; day_count?: string };
    if (typeof amount !== "number" || !unit) return "";
    const one: Record<string, string> = { horas: "hora", dias: "dia", meses: "mês", anos: "ano" };
    const noun = amount === 1 ? (one[unit] ?? unit) : unit;
    const count =
        unit !== "dias" ? "" : day_count === "uteis" ? (amount === 1 ? " útil" : " úteis") : day_count === "corridos" ? (amount === 1 ? " corrido" : " corridos") : "";
    return `${number(amount)} ${noun}${count}`;
}

/** One line for a structured value; booleans and enums in words. */
export function fieldSummary(field: Pick<FichaField, "value">): string {
    const value = field.value;
    if (value === null || value === undefined) return "";
    if (typeof value === "boolean") return value ? "Sim" : "Não";
    if (typeof value === "string") return word(value);
    if (typeof value === "number") return number(value);
    if (typeof value !== "object") return String(value);
    const v = value as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof v.nome === "string") parts.push(v.nome);
    if (typeof v.categoria === "string") parts.push(word(v.categoria));
    if (typeof v.jurisdicao === "string") parts.push(v.jurisdicao.toUpperCase() === "BR" ? "Brasil" : v.jurisdicao);
    if (typeof v.tipo === "string") parts.push(word(v.tipo));
    if (typeof v.regime === "string") parts.push(word(v.regime));
    if (typeof v.permitida_para === "string") parts.push(word(v.permitida_para));
    if (typeof v.aplica_a === "string") parts.push(`para ${word(v.aplica_a)}`);
    if (typeof v.existe === "boolean" && parts.length === 0) parts.push(v.existe ? "Sim" : "Não");
    if (typeof v.ocorre === "boolean") parts.push(v.ocorre ? "Sim" : "Não");
    if (duration(v.duracao)) parts.push(duration(v.duracao));
    if (duration(v.aviso_nao_renovacao)) parts.push(`aviso de ${duration(v.aviso_nao_renovacao)}`);
    if (duration(v.aviso_previo_avenia)) parts.push(`aviso da Avenia: ${duration(v.aviso_previo_avenia)}`);
    if (duration(v.aviso_previo_contraparte)) parts.push(`aviso da contraparte: ${duration(v.aviso_previo_contraparte)}`);
    if (typeof v.percentual === "number") parts.push(`${number(v.percentual)}%`);
    if (typeof v.meses === "number") parts.push(`${number(v.meses)} ${v.meses === 1 ? "mês" : "meses"}`);
    if (typeof v.devida_por === "string") parts.push(`devida por ${word(v.devida_por)}`);
    if (typeof v.protege === "string") parts.push(`protege ${word(v.protege)}`);
    if (Array.isArray(v.excecoes) && v.excecoes.length) parts.push(`exceto ${v.excecoes.map(word).join(", ")}`);
    if (v.direito_rescisao_contraparte === true) parts.push("contraparte pode rescindir");
    if (v.define_controle === false) parts.push("sem definição de controle");
    if (v.carve_out_autoridades === true) parts.push("com exceção para autoridades");
    if (v.carve_out_autoridades === false) parts.push("sem exceção para autoridades");
    if (v.exige_aviso_previo_a_contraparte === true) parts.push("exige avisar a contraparte antes");
    if (v.limitada === false) parts.push("sem teto");
    if (typeof v.mecanismo === "string") parts.push(v.mecanismo);
    const text = parts.join(", ");
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : "—";
}

/** The Legal team's name for a Ficha field. */
export function fichaLabel(path: string): string {
    for (const group of FICHA_GROUPS) for (const [p, label] of group.fields) if (p === path) return label;
    return "campo da Ficha";
}

/** The groups with the fields this Ficha has, in the spreadsheet's order. */
export function fichaGroups(ficha: Record<string, FichaField>) {
    return FICHA_GROUPS.map((group) => ({
        title: group.title,
        fields: group.fields
            .filter(([path]) => ficha[path] && ficha[path].status !== "nao_aplicavel")
            .map(([path, label]) => ({ path, label, field: ficha[path] })),
    })).filter((group) => group.fields.length > 0);
}

/** Free-text fields and the key their text goes to; anything else is chosen from a list. */
const FREE_TEXT_KEY: Record<string, string> = {
    "foro.lei_aplicavel": "jurisdicao",
    "identificacao.contraparte": "nome",
};

export type CorrectionForm =
    | { kind: "boolean" }
    | { kind: "choice"; key: string; options: { value: string; label: string }[] }
    | { kind: "text"; key: string }
    | null;

/** How a person corrects this field, from the choices the server sent. */
export function correctionForm(path: string, choices: FichaChoices | undefined): CorrectionForm {
    if (choices === "boolean") return { kind: "boolean" };
    if (choices && choices.length) {
        const [first] = choices;
        return { kind: "choice", key: first.key, options: first.values.map((value) => ({ value, label: word(value) })) };
    }
    return FREE_TEXT_KEY[path] ? { kind: "text", key: FREE_TEXT_KEY[path] } : null;
}

/** What the form currently shows for the field. */
export function correctionDraft(form: NonNullable<CorrectionForm>, value: unknown): string {
    if (form.kind === "boolean") return value === true ? "true" : value === false ? "false" : "";
    const current = form.key ? (value as Record<string, unknown> | null)?.[form.key] : value;
    return typeof current === "string" ? current : "";
}

/**
 * The corrected value in the field's shape: the chosen option goes to its
 * key and the rest of the structured value is kept, so a correction of the
 * regime does not erase who it applies to.
 */
export function correctedValue(form: NonNullable<CorrectionForm>, previous: unknown, draft: string): unknown {
    if (form.kind === "boolean") return draft === "true" ? true : draft === "false" ? false : null;
    const text = draft.trim();
    if (!text) return null;
    if (!form.key) return text;
    const base = previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
    return { ...base, [form.key]: text };
}
