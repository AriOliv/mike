// The deterministic risk rules (docs/product/risk-rules.v1.yaml, avaliacao:
// motor) that read only the review's Ficha fields. Code, not a prompt: the
// same Ficha always yields the same findings, and each one says which rule
// fired and on which quoted clause. Parameters mirror the YAML's
// `parametros`; a test keeps the ids and parameters in step with the YAML.

import type { Duration, Ficha, FichaPath } from "./contractReview.ficha";

export const RULES_VERSION = "1.0";

export const RISK_PARAMS = {
    aviso_minimo_dias: 60,
    rescisao_contraparte_minimo_dias: 90,
    multa_rescisoria_max_percentual: 20,
    multa_rescisoria_max_meses: 3,
    cap_minimo_meses: 12,
    tipos_criticos: ["parceiro_bancario_baas", "arranjo_psp_adquirencia", "liquidez_otc_cambio", "custodia_cripto"],
} as const;

export type Severity = "critica" | "alta" | "media" | "baixa" | "info";

export type RiskFinding = {
    rule_id: string;
    rules_version: string;
    titulo: string;
    severidade: Severity;
    justificativa: string;
    acao_sugerida: string;
    campos: FichaPath[];
    /** Some field the rule read is still the model's unconfirmed reading. */
    depende_de_campo_nao_validado: boolean;
};

type Rule = {
    id: string;
    titulo: string;
    severidade: Severity;
    campos: FichaPath[];
    papel?: ("contratante" | "contratada" | "mutuo")[];
    soCriticos?: boolean;
    /** Raises the severity when the counterparty is a critical partner. */
    agravanteCritico?: Severity;
    /**
     * Fields that must be in the contract for the rule to apply; defaults to
     * all of `campos`. A rule about a missing clause (RSP-01, LGP-01) lists
     * fewer, so the absence itself can fire it.
     */
    requer?: FichaPath[];
    quando: (read: Reader) => boolean;
    justificativa: string;
    acao_sugerida: string;
};

type Reader = <T = Record<string, unknown>>(path: FichaPath) => T | null;

/** Calendar-day equivalent, conservative, for comparing with thresholds only. */
export function durationDays(duration: unknown): number | null {
    if (!duration || typeof duration !== "object") return null;
    const { amount, unit, day_count } = duration as Duration;
    if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
    switch (unit) {
        case "horas":
            return Math.ceil(amount / 24);
        case "dias":
            return day_count === "uteis" ? Math.floor((amount * 7) / 5) : amount;
        case "meses":
            return amount * 30;
        case "anos":
            return amount * 365;
        default:
            return null;
    }
}

const lessThan = (duration: unknown, days: number) => {
    const value = durationDays(duration);
    return value !== null && value < days;
};
const has = (list: unknown, item: string) => Array.isArray(list) && list.includes(item);
const among = (value: unknown, options: readonly string[]) => typeof value === "string" && options.includes(value);

export const RULES: Rule[] = [
    {
        id: "REN-01",
        titulo: "Renovação automática com aviso prévio curto",
        severidade: "alta",
        campos: ["vigencia.renovacao"],
        quando: (read) => {
            const ren = read("vigencia.renovacao");
            return ren?.tipo === "automatica" && lessThan(ren.aviso_nao_renovacao, RISK_PARAMS.aviso_minimo_dias);
        },
        justificativa:
            "Com aviso menor que 60 dias, a decisão de não renovar precisa sair antes do ciclo orçamentário e de aprovação interna. É o caminho mais comum para renovar sem querer.",
        acao_sugerida: "Negociar aviso de 60 a 90 dias ou renovação mediante aditivo.",
    },
    {
        id: "REN-03",
        titulo: "Prazo indeterminado sem saída imotivada para a Avenia",
        severidade: "alta",
        campos: ["vigencia.prazo", "rescisao.imotivada"],
        quando: (read) =>
            read("vigencia.prazo")?.tipo === "indeterminado" &&
            among(read("rescisao.imotivada")?.permitida_para, ["somente_contraparte", "nenhuma"]),
        justificativa: "A Avenia fica presa ao contrato sem data de término nem forma de sair.",
        acao_sugerida: "Incluir rescisão imotivada para ambas as partes com aviso prévio.",
    },
    {
        id: "RES-01",
        titulo: "Só a contraparte pode rescindir sem justa causa",
        severidade: "alta",
        agravanteCritico: "critica",
        campos: ["rescisao.imotivada"],
        quando: (read) => read("rescisao.imotivada")?.permitida_para === "somente_contraparte",
        justificativa:
            "Assimetria de saída. A Avenia arca com o contrato enquanto a contraparte pode sair quando quiser.",
        acao_sugerida: "Rescisão imotivada recíproca, com o mesmo aviso.",
    },
    {
        id: "RES-02",
        titulo: "Multa rescisória devida pela Avenia acima do limite",
        severidade: "alta",
        campos: ["rescisao.multa_rescisoria"],
        quando: (read) => {
            const multa = read<{ existe?: boolean; devida_por?: string; percentual?: number; meses?: number; tipo?: string }>(
                "rescisao.multa_rescisoria",
            );
            if (!multa?.existe || !among(multa.devida_por, ["avenia", "ambas"])) return false;
            return (
                (typeof multa.percentual === "number" && multa.percentual > RISK_PARAMS.multa_rescisoria_max_percentual) ||
                (typeof multa.meses === "number" && multa.meses > RISK_PARAMS.multa_rescisoria_max_meses) ||
                multa.tipo === "percentual_valor_total"
            );
        },
        justificativa:
            "Multa sobre o valor total (e não sobre o saldo) ou acima de 20% / 3 meses torna a saída mais cara que continuar, mesmo com o serviço ruim.",
        acao_sugerida: "Multa proporcional ao saldo remanescente, com teto.",
    },
    {
        id: "RES-03",
        titulo: "Parceiro crítico pode encerrar com aviso curto",
        severidade: "critica",
        soCriticos: true,
        campos: ["rescisao.imotivada"],
        quando: (read) =>
            lessThan(read("rescisao.imotivada")?.aviso_previo_contraparte, RISK_PARAMS.rescisao_contraparte_minimo_dias),
        justificativa:
            "Migrar conta, Pix, adquirência ou liquidez para outro parceiro leva meses. Aviso curto significa operação parada e clientes sem serviço.",
        acao_sugerida: "Aviso de no mínimo 90 a 180 dias e obrigação de cooperar na transição.",
    },
    {
        id: "ALT-01",
        titulo: "Mudança de controle da Avenia depende de autorização ou permite rescisão",
        severidade: "alta",
        agravanteCritico: "critica",
        campos: ["alteracao_parte.mudanca_controle"],
        quando: (read) => {
            const mc = read("alteracao_parte.mudanca_controle");
            return (
                among(mc?.aplica_a, ["avenia", "ambas"]) &&
                (among(mc?.regime, ["consentimento_previo", "vedada"]) || mc?.direito_rescisao_contraparte === true)
            );
        },
        justificativa:
            "Rodada de investimento, M&A ou reorganização societária pode exigir anuência da contraparte ou dar a ela o direito de rescindir. Entra na due diligence de qualquer transação.",
        acao_sugerida:
            "Trocar consentimento por notificação; excluir reorganizações dentro do grupo e investimentos que não alterem o controle; definir \"controle\".",
    },
    {
        id: "ALT-02",
        titulo: "Gatilho de mudança de controle sem definição de controle",
        severidade: "media",
        campos: ["alteracao_parte.mudanca_controle"],
        quando: (read) => {
            const mc = read("alteracao_parte.mudanca_controle");
            return among(mc?.regime, ["notificacao", "consentimento_previo", "vedada"]) && mc?.define_controle !== true;
        },
        justificativa: "Sem definição, qualquer entrada de sócio pode ser lida como mudança de controle.",
        acao_sugerida:
            "Definir controle (maioria do capital votante ou poder de eleger a maioria dos administradores).",
    },
    {
        id: "ALT-03",
        titulo: "Avenia não pode ceder nem para empresas do grupo",
        severidade: "media",
        campos: ["alteracao_parte.cessao"],
        quando: (read) => {
            const cessao = read("alteracao_parte.cessao");
            return (
                among(cessao?.aplica_a, ["avenia", "ambas"]) &&
                among(cessao?.regime, ["consentimento_previo", "vedada"]) &&
                !has(cessao?.excecoes, "afiliadas")
            );
        },
        justificativa:
            "O grupo tem várias entidades (IP, SPSAV, LLC, holdings). Reorganizar onde o contrato fica passa a depender da contraparte.",
        acao_sugerida: "Exceção para cessão a afiliadas e sucessoras por reorganização societária.",
    },
    {
        id: "ALT-04",
        titulo: "Contraparte pode ceder livremente",
        severidade: "media",
        agravanteCritico: "alta",
        campos: ["alteracao_parte.cessao"],
        quando: (read) => {
            const cessao = read("alteracao_parte.cessao");
            return cessao?.regime === "livre" && among(cessao?.aplica_a, ["contraparte", "ambas"]);
        },
        justificativa: "A Avenia pode passar a contratar com uma empresa que nunca avaliou.",
        acao_sugerida:
            "Exigir notificação prévia e direito de rescindir sem multa se a cessionária não for aceitável.",
    },
    {
        id: "RSP-01",
        titulo: "Responsabilidade da Avenia sem limite",
        severidade: "alta",
        papel: ["contratada", "mutuo"],
        campos: ["responsabilidade.limitacao"],
        requer: [],
        quando: (read) => {
            const lim = read("responsabilidade.limitacao");
            return lim === null || lim.tipo === "ilimitada" || lim.protege === "contraparte";
        },
        justificativa: "Sem limitação, um incidente pode custar mais do que o contrato inteiro vale.",
        acao_sugerida: "Limite de 12 meses de remuneração, com exclusão de danos indiretos.",
    },
    {
        id: "RSP-03",
        titulo: "Parceiro crítico com limite de responsabilidade baixo",
        severidade: "alta",
        papel: ["contratante"],
        soCriticos: true,
        campos: ["responsabilidade.limitacao"],
        quando: (read) => {
            const lim = read<{ protege?: string; meses?: number }>("responsabilidade.limitacao");
            return (
                among(lim?.protege, ["contraparte", "ambas"]) &&
                typeof lim?.meses === "number" &&
                lim.meses < RISK_PARAMS.cap_minimo_meses
            );
        },
        justificativa: "Falha do parceiro afeta clientes da Avenia; o ressarcimento fica limitado a pouco.",
        acao_sugerida:
            "Limite mínimo de 12 meses e exceção para falhas que gerem sanção regulatória à Avenia.",
    },
    {
        id: "RSP-04",
        titulo: "Multa por descumprimento devida pela Avenia sem teto",
        severidade: "media",
        campos: ["responsabilidade.multa_geral"],
        quando: (read) => {
            const multa = read("responsabilidade.multa_geral");
            return multa?.existe === true && among(multa.devida_por, ["avenia", "ambas"]) && multa.limitada !== true;
        },
        justificativa: "Multa por evento sem limite acumula sem teto.",
        acao_sugerida: "Teto agregado e natureza compensatória (abate de perdas e danos).",
    },
    {
        id: "LGP-01",
        titulo: "Compartilhamento de dados sem papel LGPD definido",
        severidade: "alta",
        campos: ["dados_pessoais.compartilhamento", "dados_pessoais.papel_avenia"],
        requer: ["dados_pessoais.compartilhamento"],
        quando: (read) =>
            read<boolean>("dados_pessoais.compartilhamento") === true &&
            [null, "nao_definido"].includes(read<string>("dados_pessoais.papel_avenia")),
        justificativa:
            "Sem definir controlador e operador, não fica claro quem responde ao titular e à ANPD nem quem notifica incidente.",
        acao_sugerida: "Cláusula ou anexo de tratamento de dados com papéis, finalidade e obrigações.",
    },
    {
        id: "LGP-02",
        titulo: "Termos de dados só por referência, fora do documento",
        severidade: "media",
        campos: ["dados_pessoais.dpa"],
        quando: (read) => read<string>("dados_pessoais.dpa") === "por_referencia",
        justificativa:
            "As regras reais de tratamento de dados estão num documento que não foi analisado e pode mudar.",
        acao_sugerida: "Anexar a versão vigente do documento ao contrato e analisá-la.",
    },
    {
        id: "LGP-03",
        titulo: "Transferência internacional de dados sem mecanismo",
        severidade: "alta",
        campos: ["dados_pessoais.transferencia_internacional"],
        quando: (read) => {
            const ti = read("dados_pessoais.transferencia_internacional");
            return ti?.ocorre === true && (ti.mecanismo ?? null) === null;
        },
        justificativa:
            "A LGPD (art. 33) só permite transferência internacional nas hipóteses previstas, como cláusulas-padrão da ANPD.",
        acao_sugerida: "Adotar as cláusulas-padrão contratuais da ANPD.",
    },
    {
        id: "REG-01",
        titulo: "Confidencialidade impede informar reguladores e autoridades",
        severidade: "alta",
        campos: ["regulatorio.confidencialidade"],
        quando: (read) => {
            const conf = read("regulatorio.confidencialidade");
            return conf?.existe === true && conf.carve_out_autoridades !== true;
        },
        justificativa:
            "A Avenia precisa poder entregar informação ao BCB, ao COAF e a ordens judiciais sem violar o contrato.",
        acao_sugerida: "Exceção expressa para divulgação exigida por lei, regulador ou ordem judicial.",
    },
    {
        id: "REG-02",
        titulo: "Contrato exige avisar a contraparte antes de informar autoridade",
        severidade: "critica",
        campos: ["regulatorio.confidencialidade"],
        quando: (read) => read("regulatorio.confidencialidade")?.exige_aviso_previo_a_contraparte === true,
        justificativa:
            "Comunicações ao COAF não podem ser reveladas a quem elas se referem. Aviso prévio obrigatório conflita com esse dever.",
        acao_sugerida: "Ressalvar que o aviso não se aplica quando vedado por lei ou pela autoridade.",
    },
    {
        id: "FOR-01",
        titulo: "Lei estrangeira ou foro fora do Brasil",
        severidade: "media",
        campos: ["foro.lei_aplicavel"],
        quando: (read) => {
            const lei = read<{ jurisdicao?: string }>("foro.lei_aplicavel");
            return typeof lei?.jurisdicao === "string" && lei.jurisdicao.trim().toUpperCase() !== "BR";
        },
        justificativa: "Disputa cara e lenta; contrato precisa de revisão por advogado da jurisdição.",
        acao_sugerida: "Avaliar arbitragem internacional ou lei brasileira para a entidade brasileira.",
    },
];

function readerFor(ficha: Ficha): Reader {
    return <T,>(path: FichaPath) => {
        const field = ficha[path];
        if (!field || field.status === "nao_encontrado" || field.status === "nao_aplicavel") return null;
        return (field.value ?? null) as T | null;
    };
}

/** Runs every rule on the Ficha. A rule never fires on a theme the contract does not treat. */
export function evaluateRules(ficha: Ficha): RiskFinding[] {
    const read = readerFor(ficha);
    const papel = read<string>("identificacao.papel_avenia");
    const categoria = read<{ categoria?: string }>("identificacao.tipo_contrato")?.categoria;
    const critico = among(categoria, RISK_PARAMS.tipos_criticos);
    const findings: RiskFinding[] = [];
    for (const rule of RULES) {
        if (rule.papel && !among(papel, rule.papel)) continue;
        if (rule.soCriticos && !critico) continue;
        const applies =
            (rule.requer ?? rule.campos).every((path) => read(path) !== null) &&
            rule.campos.every((path) => ficha[path] && ficha[path]!.status !== "nao_aplicavel");
        if (!applies || !rule.quando(read)) continue;
        findings.push({
            rule_id: rule.id,
            rules_version: RULES_VERSION,
            titulo: rule.titulo,
            severidade: critico && rule.agravanteCritico ? rule.agravanteCritico : rule.severidade,
            justificativa: rule.justificativa,
            acao_sugerida: rule.acao_sugerida,
            campos: rule.campos,
            depende_de_campo_nao_validado: rule.campos.some(
                (path) => (ficha[path]?.review.state ?? "pendente") === "pendente",
            ),
        });
    }
    return findings;
}

const SEVERITY_ORDER: Severity[] = ["critica", "alta", "media", "baixa", "info"];

/** The card's risk: the worst open finding, in the vocabulary projects.risk_level uses. */
export function overallRisk(findings: RiskFinding[]): "critico" | "atencao" | "ok" {
    const worst = Math.min(...findings.map((f) => SEVERITY_ORDER.indexOf(f.severidade)), 99);
    if (worst === 0) return "critico";
    if (worst <= 2) return "atencao";
    return "ok";
}
