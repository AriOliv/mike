// "Controle de Contratos": the Legal team's spreadsheet (34 columns, A..AH)
// as a tabular review. Each column says where its value comes from, as the
// Ficha (docs/product/contract-schema.v1.json, `x-planilha`) does:
//
//   ia        read from the contract by the model, with a citation;
//   derivado  computed by code from other columns, never asked of the model;
//   humano    filled by the Legal (area, status, past assignments);
//   sistema   filled by the platform (the Drive link).
//
// Only the `ia` columns become prompts in the tabular review. The others stay
// in the sheet so the export keeps the spreadsheet's order, and are filled by
// `deriveControleRow` or left for the Legal.

import { durationDays } from "./contractReview.rules";

export type ControleOrigin = "ia" | "derivado" | "humano" | "sistema";

export type ControleColumn = {
    /** Spreadsheet column letter (A..AH). */
    letter: string;
    /** Merged header above the column, when it has one (row 2 of the sheet). */
    group: string | null;
    /** The column's own header. */
    name: string;
    origin: ControleOrigin;
    /** The Ficha field it reads (contract-schema.v1), when there is one. */
    field: string | null;
    /** Upstream tabular format, for `ia` columns. */
    format?: "text" | "tag" | "bulleted_list";
    tags?: string[];
    /** What to extract; the format and the citation rules are added upstream. */
    prompt?: string;
};

export const CONTROLE_TEMPLATE_TITLE = "Controle de Contratos";

export const CONTROLE_TEMPLATE_DESCRIPTION =
    "As 34 colunas da planilha de controle do Legal. A IA lê do contrato as colunas de conteúdo, " +
    "sempre com o trecho de onde veio. Dias para vencimento é calculado; Área, Link do drive, Ativo? " +
    "e Alteração de parte ficam para o Legal.";

/** The answer a column gives when the contract does not deal with the subject. */
export const NAO_ENCONTRADO = "Não encontrado";

const SIM_NAO = ["Sim", "Não", NAO_ENCONTRADO];

// Shared reading rules, added to every `ia` prompt. Upstream adds the citation
// format and its own "Not Found" line; these say how to write the value.
const REGRAS =
    " Responda em português, com o valor como está no contrato, sem resumir a cláusula." +
    " Datas em DD/MM/AAAA. Prazos com número e unidade como escritos (ex.: 30 dias corridos, 12 meses, 5 dias úteis)." +
    " Valores com moeda (R$, US$, USDC) e percentuais com %." +
    ` Se o contrato não tratar do assunto, responda exatamente "${NAO_ENCONTRADO}" e não deduza.`;

const ia = (
    letter: string,
    group: string | null,
    name: string,
    field: string,
    prompt: string,
    format: ControleColumn["format"] = "text",
    tags?: string[],
): ControleColumn => ({ letter, group, name, origin: "ia", field, format, ...(tags ? { tags } : {}), prompt: prompt + REGRAS });

const regimeAlteracao = (assunto: string) =>
    `${assunto}: o que o contrato exige de cada parte. Responda com uma de: livre, notificação, autorização prévia, vedada; diga a qual parte se aplica (Avenia, contraparte, ambas) e as exceções (grupo econômico, reorganização, fusão/incorporação).`;

export const CONTROLE_COLUMNS: ControleColumn[] = [
    ia(
        "A",
        null,
        "Tipo de Contrato",
        "identificacao.tipo_contrato",
        "Que tipo de contrato é este? Classifique em uma das categorias e, se for 'Outro', diga em poucas palavras o que é. Leia o objeto e o título; se não houver cláusula única que diga, classifique pelo conjunto.",
        "tag",
        [
            "NDA",
            "Prestação de serviços",
            "MSA",
            "Pedido / SOW",
            "Licença SaaS",
            "Parceria comercial",
            "Indicação / rebate",
            "Parceiro bancário / BaaS",
            "Arranjo PSP / adquirência",
            "Liquidez / OTC / câmbio",
            "Custódia cripto",
            "Cliente API / plataforma",
            "Locação",
            "Prestador PJ",
            "Mútuo / empréstimo",
            "Carta de intenção / MOU",
            "Procuração",
            "Aditivo",
            "Outro",
            NAO_ENCONTRADO,
        ],
    ),
    ia(
        "B",
        null,
        "Contraparte",
        "identificacao.contraparte",
        "Razão social da outra parte (a que não é empresa do grupo Avenia), como qualificada no preâmbulo, com o CNPJ/CPF ou o identificador estrangeiro se houver. Se houver mais de uma contraparte, liste todas.",
    ),
    { letter: "C", group: null, name: "Área responsável", origin: "humano", field: "gestao.area_responsavel" },
    { letter: "D", group: null, name: "Link do drive", origin: "sistema", field: "gestao.link_drive" },
    { letter: "E", group: null, name: "Ativo?", origin: "humano", field: "gestao.status_contrato" },
    ia(
        "F",
        null,
        "Obrigações periódicas/importantes",
        "obrigacoes",
        "Obrigações periódicas ou importantes de qualquer parte: relatórios, certidões, SLAs com prazo, entregas, auditorias, comunicações obrigatórias. Um item por obrigação, com quem deve, o que, e a periodicidade ou o prazo.",
        "bulleted_list",
    ),
    ia(
        "G",
        "Pagamento",
        "Prazo",
        "pagamento.prazo",
        "Prazo de pagamento: em quantos dias e a partir de quê (emissão da nota fiscal, recebimento da fatura, fim do mês, antecipado) ou o dia fixo do mês.",
    ),
    ia(
        "H",
        "Pagamento",
        "Multa",
        "pagamento.multa_moratoria",
        "Multa por atraso no pagamento (multa moratória): percentual ou valor e sobre o que incide. Não confunda com multa rescisória ou multa por descumprimento.",
    ),
    ia(
        "I",
        "Pagamento",
        "Juros",
        "pagamento.juros_mora",
        "Juros de mora por atraso no pagamento: percentual e período (ao dia, ao mês, ao ano) e se pro rata die.",
    ),
    ia(
        "J",
        "Pagamento",
        "Correção Monetária",
        "pagamento.correcao_monetaria",
        "Índice de correção monetária de valores em atraso (IPCA, IGP-M, INPC, SELIC, CDI...) e o índice substituto, se houver. Reajuste anual do preço não é correção de atraso: só mencione se o contrato usar o mesmo índice para os dois, e diga isso.",
    ),
    ia(
        "K",
        "Pagamento",
        "Valor",
        "pagamento.valor",
        "Contraprestação: quanto se paga, quem paga e o modelo (valor fixo, mensalidade, por transação, percentual ou bps, tabela anexa, mínimo mensal). Se o preço estiver em anexo não incluído, diga 'em anexo'. Se não houver contraprestação, diga 'Sem contraprestação'.",
    ),
    ia(
        "L",
        "Pagamento",
        "Tributos",
        "pagamento.tributos",
        "Tratamento de tributos: se estão inclusos no preço, acrescidos ao preço ou com gross-up, e as retenções previstas (ISS, IRRF, PIS, COFINS, CSLL, INSS, IOF).",
    ),
    ia(
        "M",
        "Vigência",
        "Data Assinatura",
        "vigencia.data_assinatura",
        "Data de assinatura do contrato. Em assinatura eletrônica, a data da última assinatura. Só a data escrita no documento ou no registro de assinaturas; não presuma pela data do arquivo.",
    ),
    ia(
        "N",
        "Vigência",
        "Prazo de vigência",
        "vigencia.prazo",
        "Prazo de vigência: determinado (com a duração e o início, se diferente da assinatura) ou indeterminado.",
    ),
    { letter: "O", group: "Vigência", name: "Dias para vencimento/renovação", origin: "derivado", field: "derivados.dias_para_vencimento" },
    ia(
        "P",
        "Vigência",
        "Data de vencimento",
        "vigencia.data_vencimento",
        "Data de término da vigência SÓ quando estiver escrita no contrato. Não calcule a partir do prazo: se o contrato só der o prazo, responda o que estiver escrito ou 'Não encontrado'.",
    ),
    ia(
        "Q",
        "Vigência",
        "Renovação Automática",
        "vigencia.renovacao",
        "O contrato renova automaticamente ao fim da vigência? Sim só se renovar sem ato das partes. Na justificativa diga o período de cada renovação e o aviso para não renovar (distinto do aviso de rescisão).",
        "tag",
        SIM_NAO,
    ),
    ia(
        "R",
        "Rescisão",
        "Rescisão antecipada",
        "rescisao.imotivada",
        "Rescisão antecipada sem justa causa (imotivada, denúncia): é permitida? Para quem (ambas as partes, só a Avenia, só a contraparte, nenhuma)?",
    ),
    ia(
        "S",
        "Rescisão",
        "Prazo do aviso prévio",
        "rescisao.imotivada",
        "Prazo do aviso prévio para a rescisão sem justa causa, o que vale para a Avenia; se for diferente para a contraparte, diga os dois. Não confunda com o aviso de não renovação.",
    ),
    ia(
        "T",
        "Multa rescisória",
        "Sim/Não",
        "rescisao.multa_rescisoria",
        "Há multa pela rescisão antecipada do contrato (multa rescisória)? Não conte multa moratória nem multa por descumprimento de obrigação.",
        "tag",
        SIM_NAO,
    ),
    ia(
        "U",
        "Multa rescisória",
        "Valor",
        "rescisao.multa_rescisoria",
        "Valor ou fórmula da multa rescisória (valor fixo, percentual do valor total ou do saldo remanescente, meses de remuneração, proporcional), quem paga e em que hipótese.",
    ),
    ia("V", "Cessão", "Sim / Não", "alteracao_parte.cessao", "O contrato permite a cessão da posição contratual (com ou sem condição)? Sim se for livre, mediante notificação ou mediante autorização; Não se for vedada.", "tag", SIM_NAO),
    ia("W", "Cessão", "Notificação / Autorização", "alteracao_parte.cessao", regimeAlteracao("Cessão do contrato")),
    ia(
        "X",
        "Cessão",
        "Prazo antecedência",
        "alteracao_parte.cessao",
        "Com que antecedência a outra parte precisa ser notificada ou consultada antes da cessão.",
    ),
    ia(
        "Y",
        "Cessão",
        "Penalidade por não informar",
        "alteracao_parte.cessao",
        "O que acontece se a cessão for feita sem a notificação ou a autorização exigida: rescisão, multa (com o valor), ineficácia da cessão, perdas e danos.",
    ),
    ia(
        "Z",
        "Alteração Controle",
        "Sim / Não",
        "alteracao_parte.mudanca_controle",
        "O contrato trata de mudança de controle societário de alguma das partes (aquisição, fusão, troca do controlador)? Sim se tratar, mesmo que só para exigir notificação.",
        "tag",
        SIM_NAO,
    ),
    ia("AA", "Alteração Controle", "Notificação / Autorização", "alteracao_parte.mudanca_controle", regimeAlteracao("Mudança de controle") + " Diga também se o contrato define o que é 'controle'."),
    ia(
        "AB",
        "Alteração Controle",
        "Prazo antecedência",
        "alteracao_parte.mudanca_controle",
        "Com que antecedência a outra parte precisa ser notificada ou consultada antes (ou em quanto tempo depois) da mudança de controle.",
    ),
    ia(
        "AC",
        "Alteração Controle",
        "Penalidade por não informar",
        "alteracao_parte.mudanca_controle",
        "O que acontece se a mudança de controle não for comunicada ou autorizada: direito de rescisão da contraparte, multa (com o valor), perdas e danos.",
    ),
    ia(
        "AD",
        "Compartilhamento de dados",
        "Sim / Não",
        "dados_pessoais.compartilhamento",
        "Há tratamento ou compartilhamento de dados pessoais entre as partes por causa deste contrato (LGPD)?",
        "tag",
        SIM_NAO,
    ),
    ia(
        "AE",
        "Compartilhamento de dados",
        "Agente",
        "dados_pessoais.papel_avenia",
        "Papel da Avenia no tratamento de dados pessoais segundo a LGPD: controladora, operadora, controladora conjunta ou suboperadora. Se o contrato não disser, responda 'Não definido'.",
        "tag",
        ["Controladora", "Operadora", "Controladora conjunta", "Suboperadora", "Não definido", NAO_ENCONTRADO],
    ),
    ia(
        "AF",
        null,
        "Multa",
        "responsabilidade.multa_geral",
        "Multa por descumprimento de obrigação contratual (multa geral, não moratória e não rescisória): valor ou percentual, quem paga, em que hipóteses e se tem teto.",
    ),
    { letter: "AG", group: "Alteração de parte", name: "Cessão contratual", origin: "humano", field: "gestao.historico_alteracao_parte" },
    { letter: "AH", group: "Alteração de parte", name: "Alteração de Controle", origin: "humano", field: "gestao.historico_alteracao_parte" },
];

/** A tabular review column (upstream `columns_config` entry). */
export type TabularColumn = { index: number; name: string; prompt: string; format?: string; tags?: string[] };

/** The tabular header of a sheet column: the group and the name, so "Valor" of Pagamento differs from "Valor" of Multa rescisória. */
export function controleHeader(column: ControleColumn): string {
    return column.group ? `${column.group} · ${column.name}` : column.name;
}

/** The `ia` columns as a tabular review's columns, in the spreadsheet's order. */
export function controleColumnsConfig(): TabularColumn[] {
    return CONTROLE_COLUMNS.filter((column) => column.origin === "ia").map((column, index) => ({
        index,
        name: controleHeader(column),
        prompt: column.prompt!,
        format: column.format ?? "text",
        ...(column.tags ? { tags: column.tags } : {}),
    }));
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** "DD/MM/AAAA" or "AAAA-MM-DD" to a UTC date; anything else is no date. */
export function parseSheetDate(text: string | null | undefined): Date | null {
    // The model often trails the date with a period or a note in parentheses
    // ("01/07/2026.", "01/07/2026 (data do preâmbulo)"): the cell's leading date
    // counts, a date further into the text does not.
    const value = (text ?? "").trim();
    const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?![\d/])/.exec(value);
    const iso = /^(\d{4})-(\d{2})-(\d{2})(?![\d-])/.exec(value);
    const [y, m, d] = br ? [+br[3], +br[2], +br[1]] : iso ? [+iso[1], +iso[2], +iso[3]] : [NaN, NaN, NaN];
    if (!Number.isInteger(y)) return null;
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}

/** "12 meses", "2 anos", "90 dias corridos", "30 (trinta) dias úteis" to a duration; anything else is null. */
export function parseSheetDuration(text: string | null | undefined): { amount: number; unit: string; day_count: string } | null {
    const match = /(\d+(?:[.,]\d+)?)\s*(?:\([^)]*\)\s*)?(dias?|mes(?:es)?|m[eê]s|anos?)\b\s*(úteis|uteis|corridos)?/i.exec(text ?? "");
    if (!match) return null;
    const amount = Number(match[1].replace(",", "."));
    const word = match[2].toLowerCase();
    const unit = word.startsWith("dia") ? "dias" : word.startsWith("ano") ? "anos" : "meses";
    const count = (match[3] ?? "").toLowerCase();
    return { amount, unit, day_count: count.startsWith("u") || count.startsWith("ú") ? "uteis" : count ? "corridos" : "nao_especificado" };
}

/**
 * The computed column O: days from `today` to the end of the term. The end is
 * the written expiry (P); without it, signature (M) plus a fixed term (N).
 * Negative when already past; null when the contract gives no way to tell.
 */
export function diasParaVencimento(
    cells: { assinatura?: string | null; prazo?: string | null; vencimento?: string | null },
    today: Date,
): number | null {
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    let end = parseSheetDate(cells.vencimento);
    if (!end && !/indeterminad/i.test(cells.prazo ?? "")) {
        const signed = parseSheetDate(cells.assinatura);
        const term = parseSheetDuration(cells.prazo);
        if (signed && term) {
            end = new Date(signed);
            if (term.unit === "meses") end.setUTCMonth(end.getUTCMonth() + term.amount);
            else if (term.unit === "anos") end.setUTCFullYear(end.getUTCFullYear() + term.amount);
            else end = new Date(signed.getTime() + (durationDays(term) ?? 0) * MS_PER_DAY);
        }
    }
    return end ? Math.round((end.getTime() - start.getTime()) / MS_PER_DAY) : null;
}

/**
 * One spreadsheet row, in column order A..AH, from the tabular cells (keyed
 * by column letter, the `ia` ones) and what the Legal or the platform knows.
 * Column O is computed here; human columns stay empty unless given.
 */
export function controleRow(
    cells: Record<string, string | null | undefined>,
    known: { driveLink?: string | null; today: Date },
): (string | number | null)[] {
    const dias = diasParaVencimento({ assinatura: cells.M, prazo: cells.N, vencimento: cells.P }, known.today);
    return CONTROLE_COLUMNS.map((column) => {
        if (column.origin === "ia") return cells[column.letter] ?? null;
        if (column.letter === "O") return dias;
        if (column.letter === "D") return known.driveLink ?? null;
        return cells[column.letter] ?? null;
    });
}
