// How the Ficha reads on screen: fields grouped like the Legal team's
// spreadsheet, and each structured value said in one PT-BR line ("Automática,
// aviso de 30 dias corridos"). The value stays structured in the Ficha; this is
// only its wording.

import type { FichaField } from "./mikeApi";

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

function duration(value: unknown): string {
    if (!value || typeof value !== "object") return "";
    const { amount, unit, day_count } = value as { amount?: number; unit?: string; day_count?: string };
    if (typeof amount !== "number" || !unit) return "";
    const count = day_count === "uteis" ? " úteis" : day_count === "corridos" ? " corridos" : "";
    return `${amount} ${unit}${unit === "dias" ? count : ""}`;
}

/** One line for a structured value; booleans and enums in words. */
export function fieldSummary(field: Pick<FichaField, "value">): string {
    const value = field.value;
    if (value === null || value === undefined) return "";
    if (typeof value === "boolean") return value ? "Sim" : "Não";
    if (typeof value === "string") return word(value);
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
    if (typeof v.percentual === "number") parts.push(`${v.percentual}%`);
    if (typeof v.meses === "number") parts.push(`${v.meses} meses`);
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
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : JSON.stringify(value);
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

/**
 * A correction typed as text. "sim"/"não" become booleans; anything else is
 * kept as the person wrote it, in `nota`, so nothing they typed is lost.
 */
export function parseCorrection(text: string): unknown {
    const value = text.trim();
    if (!value) return null;
    if (/^(sim|s)$/i.test(value)) return true;
    if (/^(não|nao|n)$/i.test(value)) return false;
    return { nota: value };
}
