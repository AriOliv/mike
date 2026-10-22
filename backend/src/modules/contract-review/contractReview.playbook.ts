// Playbook Avenia v1: the Legal team's standard positions, as a playbook in
// the upstream format (topics → rules with standard / fallback / unacceptable
// positions). It is ordinary playbook content: once seeded the Head of Legal
// edits it in the playbook editor like any other, and a review snapshots it.
//
// Each rule names the risk rules (docs/product/risk-rules.v1.yaml) that judge
// the same subject from the contract's Ficha, in `riskRules` below, so the
// review can show the rule that fired beside the playbook's assessment. The
// thresholds in the text match the YAML's `parametros`.

/** The playbook's name; the seed finds an existing copy by it. */
export const AVENIA_PLAYBOOK_NAME = "Playbook Avenia v1";

/** Rule id → the risk-rule ids that judge the same subject from the Ficha. */
export const RULE_RISK_RULES: Record<string, string[]> = {
    "avenia-cessao": ["ALT-03", "ALT-04"],
    "avenia-mudanca-controle": ["ALT-01", "ALT-02"],
    "avenia-lgpd-papeis": ["LGP-01", "LGP-02", "LGP-03", "LGP-04", "LGP-05"],
    "avenia-limitacao-responsabilidade": ["RSP-01", "RSP-02", "RSP-03"],
    "avenia-multa": ["RES-02", "RSP-04", "PAG-03"],
    "avenia-foro": ["FOR-01"],
    "avenia-renovacao-aviso": ["REN-01", "REN-02", "REN-03", "REN-04"],
    "avenia-rescisao": ["RES-01", "RES-03"],
    "avenia-confidencialidade-reguladores": ["REG-01", "REG-02"],
};

const position = (name: string, criteria: string, sample?: string) => ({
    name,
    criteria,
    sampleClauses: sample ? [{ text: sample, usage: "preferred" as const, sourceRefs: [] }] : [],
});

export const AVENIA_PLAYBOOK_CONTENT = {
    name: AVENIA_PLAYBOOK_NAME,
    description:
        "Posições padrão do Jurídico da Avenia para contratos comerciais (fornecedor, cliente, parceiro). Direito brasileiro. Editável pela head de Legal.",
    representedParty: "Avenia (entidade do grupo que assina o contrato)",
    documentTypes: [
        "Prestação de serviços",
        "MSA",
        "Licença SaaS",
        "Parceria comercial",
        "Parceiro bancário / BaaS",
        "Cliente de API / plataforma",
    ],
    jurisdictions: ["Brasil"],
    rules: [],
    topics: [
        {
            id: "avenia-alteracao-parte",
            name: "Cessão e mudança de controle",
            rules: [
                {
                    id: "avenia-cessao",
                    name: "Cessão do contrato",
                    concept:
                        "Cláusula que regula a cessão ou transferência do contrato, de direitos ou de obrigações a terceiros, por qualquer das partes.",
                    scope: "clause" as const,
                    required: true,
                    guidance:
                        "O grupo Avenia tem várias entidades (IP/SPSAV, LLC, holdings). Reorganizar onde o contrato fica não pode depender da contraparte. Verifique quem pode ceder (Avenia, contraparte, ambas), o regime (livre, notificação, consentimento, vedada) e as exceções.",
                    standard: position(
                        "Cessão recíproca com consentimento, livre para afiliadas",
                        "Nenhuma parte cede sem consentimento prévio e escrito da outra, que não será negado sem justo motivo; a Avenia pode ceder livremente a afiliadas e a sucessoras por reorganização societária, mediante notificação.",
                        "Nenhuma das Partes poderá ceder ou transferir este Contrato sem o prévio consentimento por escrito da outra Parte, que não será negado sem justo motivo, exceto a cessão a sociedades do mesmo grupo econômico ou a sucessoras por fusão, cisão ou incorporação, que poderá ser feita mediante simples notificação.",
                    ),
                    fallbacks: [
                        position(
                            "Notificação prévia para ambas as partes",
                            "Cessão livre para as duas partes mediante notificação com antecedência de pelo menos 30 dias, com direito de rescindir sem multa se a cessionária não for aceitável (KYB).",
                        ),
                    ],
                    unacceptable: [
                        position(
                            "Avenia não pode ceder nem para o grupo",
                            "Cessão vedada à Avenia, ou sujeita a consentimento, sem exceção para afiliadas e reorganizações (ALT-03).",
                        ),
                        position(
                            "Contraparte cede livremente",
                            "A contraparte pode ceder sem notificar nem dar saída à Avenia (ALT-04); grave em parceiro crítico, que não passou pelo KYB.",
                        ),
                    ],
                    conditions: [],
                    actions: [
                        {
                            scenario: "Parceiro crítico (BaaS, PSP, liquidez OTC, custódia)",
                            instruction: "Escalar para a head de Legal antes de aceitar qualquer desvio.",
                        },
                    ],
                    sourceRefs: [],
                },
                {
                    id: "avenia-mudanca-controle",
                    name: "Mudança de controle",
                    concept:
                        "Cláusula que trata de alteração do controle societário de uma das partes (change of control): exigência de aviso, anuência ou direito de rescisão.",
                    scope: "clause" as const,
                    required: false,
                    guidance:
                        "Rodada de investimento, M&A ou reorganização societária não podem exigir anuência da contraparte nem dar a ela direito de rescindir. Confira se o contrato define o que é controle.",
                    standard: position(
                        "Sem gatilho, ou só notificação",
                        "Mudança de controle da Avenia não exige anuência nem dá direito de rescisão; no máximo, notificação posterior. Se houver gatilho, 'controle' está definido (maioria do capital votante ou poder de eleger a maioria dos administradores) e reorganizações dentro do grupo e investimentos que não alterem o controle estão excluídos.",
                        "A alteração do controle societário de qualquer das Partes será comunicada à outra Parte em até 30 (trinta) dias, não constituindo hipótese de rescisão. Para este fim, 'controle' significa a titularidade da maioria do capital votante ou o poder de eleger a maioria dos administradores.",
                    ),
                    fallbacks: [
                        position(
                            "Direito de rescisão recíproco, sem multa",
                            "Mudança de controle dá às duas partes o direito de rescindir sem multa, com aviso de 90 dias, desde que a nova controladora seja concorrente direta.",
                        ),
                    ],
                    unacceptable: [
                        position(
                            "Anuência prévia ou rescisão unilateral da contraparte",
                            "Mudança de controle da Avenia depende de autorização da contraparte ou permite que só ela rescinda (ALT-01); crítico em parceiro crítico.",
                        ),
                        position(
                            "Gatilho sem definição de controle",
                            "O contrato prevê consequência para mudança de controle sem definir controle (ALT-02).",
                        ),
                    ],
                    conditions: [],
                    actions: [],
                    sourceRefs: [],
                },
            ],
        },
        {
            id: "avenia-dados",
            name: "Dados pessoais (LGPD) e confidencialidade",
            rules: [
                {
                    id: "avenia-lgpd-papeis",
                    name: "LGPD: papéis e obrigações",
                    concept:
                        "Cláusulas sobre tratamento de dados pessoais: papéis de controlador e operador, DPA, transferência internacional, aviso de incidente e sigilo bancário.",
                    scope: "agreement" as const,
                    required: true,
                    guidance:
                        "Se há compartilhamento de dados pessoais, o contrato precisa dizer quem é controlador e quem é operador, onde estão as regras de tratamento e em quanto tempo o operador avisa um incidente. Dados de clientes sob sigilo financeiro (LC 105/2001) exigem confidencialidade sem prazo de término.",
                    standard: position(
                        "Papéis definidos e anexo de tratamento",
                        "Papéis LGPD definidos no corpo ou em anexo; operador trata só conforme instruções, adota medidas de segurança e avisa incidente em até 48 horas; transferência internacional só com as cláusulas-padrão da ANPD; confidencialidade que cobre dados de clientes.",
                        "As Partes reconhecem que, para os fins da Lei nº 13.709/2018, a Avenia atua como controladora e a CONTRATADA como operadora dos dados pessoais tratados em razão deste Contrato, obrigando-se a CONTRATADA a comunicar à Avenia qualquer incidente de segurança em até 48 (quarenta e oito) horas de sua ciência.",
                    ),
                    fallbacks: [
                        position(
                            "Aviso de incidente em até 72 horas",
                            "Tudo como a posição padrão, mas aviso de incidente em até 72 horas, com relatório completo em 5 dias úteis.",
                        ),
                    ],
                    unacceptable: [
                        position(
                            "Compartilha dados sem papel definido",
                            "Há compartilhamento de dados pessoais e nenhum papel LGPD definido (LGP-01).",
                        ),
                        position(
                            "Regras de dados só por referência",
                            "O DPA é um documento externo 'disponível em URL', que pode mudar sem aditivo (LGP-02).",
                        ),
                        position(
                            "Transferência internacional sem mecanismo",
                            "Dados saem do Brasil sem cláusulas-padrão da ANPD ou outra hipótese do art. 33 (LGP-03).",
                        ),
                    ],
                    conditions: ["Aplica-se quando o contrato envolve tratamento de dados pessoais."],
                    actions: [],
                    sourceRefs: [],
                },
                {
                    id: "avenia-confidencialidade-reguladores",
                    name: "Confidencialidade e reguladores",
                    concept:
                        "Cláusula de confidencialidade, com atenção às exceções para Banco Central, COAF, CVM, autoridades e ordem judicial.",
                    scope: "clause" as const,
                    required: false,
                    guidance:
                        "Como instituição regulada, a Avenia precisa poder entregar informação a reguladores e autoridades sem avisar a contraparte antes, porque a comunicação ao COAF não pode ser revelada.",
                    standard: position(
                        "Exceção ampla para autoridades, sem aviso prévio",
                        "A confidencialidade não se aplica a informações exigidas por lei, regulação, BCB, COAF, CVM ou ordem judicial, e a Avenia não precisa avisar a contraparte quando a lei proibir.",
                    ),
                    fallbacks: [],
                    unacceptable: [
                        position(
                            "Sem exceção para autoridades",
                            "A confidencialidade impede informar reguladores e autoridades (REG-01).",
                        ),
                        position(
                            "Exige avisar a contraparte antes de informar autoridade",
                            "A Avenia teria de avisar a contraparte antes de cumprir requisição de autoridade, o que conflita com o dever de sigilo das comunicações ao COAF (REG-02).",
                        ),
                    ],
                    conditions: [],
                    actions: [
                        {
                            scenario: "Exige aviso à contraparte antes de informar autoridade",
                            instruction: "Escalar para a head de Legal: é crítico e não se aceita sem decisão registrada.",
                        },
                    ],
                    sourceRefs: [],
                },
            ],
        },
        {
            id: "avenia-responsabilidade",
            name: "Responsabilidade e multas",
            rules: [
                {
                    id: "avenia-limitacao-responsabilidade",
                    name: "Limitação de responsabilidade",
                    concept:
                        "Cláusula que limita (ou não) a responsabilidade das partes por perdas e danos: teto, exclusão de danos indiretos e exceções ao limite.",
                    scope: "clause" as const,
                    required: true,
                    guidance:
                        "Quando a Avenia presta o serviço, a responsabilidade dela precisa de teto. Quando contrata parceiro crítico, o teto dele não pode ser baixo demais. Exceções amplas (dados, confidencialidade, multas regulatórias) podem esvaziar o limite.",
                    standard: position(
                        "Teto recíproco de 12 meses e sem danos indiretos",
                        "Responsabilidade de cada parte limitada ao valor pago ou devido nos 12 meses anteriores ao evento, excluídos lucros cessantes e danos indiretos; exceções só para dolo e culpa grave.",
                        "A responsabilidade total de cada Parte por quaisquer perdas e danos decorrentes deste Contrato fica limitada ao valor efetivamente pago ou devido nos 12 (doze) meses anteriores ao evento, excluídos lucros cessantes e danos indiretos, salvo dolo ou culpa grave.",
                    ),
                    fallbacks: [
                        position(
                            "Supercap para dados e confidencialidade",
                            "Teto geral de 12 meses, com teto específico de 2 a 3 vezes o geral para incidente de dados e quebra de confidencialidade.",
                        ),
                    ],
                    unacceptable: [
                        position(
                            "Responsabilidade da Avenia sem limite",
                            "Não há limite para a responsabilidade da Avenia, ou o limite só protege a contraparte (RSP-01).",
                        ),
                        position(
                            "Parceiro crítico com teto baixo",
                            "Parceiro crítico limita a própria responsabilidade a menos de 12 meses (RSP-03).",
                        ),
                    ],
                    conditions: [],
                    actions: [],
                    sourceRefs: [],
                },
                {
                    id: "avenia-multa",
                    name: "Multas (rescisória, moratória e por descumprimento)",
                    concept:
                        "Cláusulas penais: multa rescisória, multa e juros de mora e multa por descumprimento de obrigação.",
                    scope: "agreement" as const,
                    required: false,
                    guidance:
                        "Multa rescisória sobre o valor total (e não sobre o saldo) ou acima de 20% / 3 meses de remuneração torna a saída mais cara que continuar. Mora acima de 1% a.m. de juros ou 2% de multa foge do padrão. Multa por evento precisa de teto.",
                    standard: position(
                        "Multas proporcionais e com teto",
                        "Multa rescisória proporcional ao saldo remanescente, até 20% ou 3 meses de remuneração; mora de 2% de multa e juros de 1% a.m. pro rata die, com correção pelo IPCA; multas por descumprimento com teto agregado e natureza compensatória.",
                        "Em caso de atraso, incidirão multa de 2% (dois por cento), juros de mora de 1% (um por cento) ao mês pro rata die e correção monetária pelo IPCA.",
                    ),
                    fallbacks: [
                        position(
                            "Multa rescisória fixa e decrescente",
                            "Multa rescisória fixa que diminui ao longo da vigência e zera no último terço do prazo.",
                        ),
                    ],
                    unacceptable: [
                        position(
                            "Multa rescisória da Avenia acima do limite",
                            "Multa devida pela Avenia sobre o valor total do contrato, ou acima de 20% / 3 meses (RES-02).",
                        ),
                        position(
                            "Multa por descumprimento sem teto",
                            "Multa por evento devida pela Avenia sem limite agregado (RSP-04).",
                        ),
                    ],
                    conditions: [],
                    actions: [],
                    sourceRefs: [],
                },
            ],
        },
        {
            id: "avenia-vigencia",
            name: "Vigência, renovação e rescisão",
            rules: [
                {
                    id: "avenia-renovacao-aviso",
                    name: "Renovação e aviso prévio",
                    concept:
                        "Prazo de vigência, renovação (automática ou por aditivo) e o aviso prévio para não renovar.",
                    scope: "clause" as const,
                    required: true,
                    guidance:
                        "Prazo e aviso alimentam o radar de prazos: registre sempre o literal (ex.: '30 dias úteis'). Com renovação automática, o aviso para não renovar precisa ser de no mínimo 60 dias, para a decisão sair antes do ciclo de aprovação interna.",
                    standard: position(
                        "Prazo determinado, renovação por aditivo ou automática com aviso de 60 a 90 dias",
                        "Vigência determinada; renovação mediante aditivo, ou automática por períodos iguais com aviso de não renovação de 60 a 90 dias, por escrito (e-mail vale).",
                        "Este Contrato vigorará por 12 (doze) meses e será renovado automaticamente por iguais períodos, salvo manifestação em contrário de qualquer das Partes, por escrito, com antecedência mínima de 60 (sessenta) dias do término da vigência.",
                    ),
                    fallbacks: [
                        position(
                            "Aviso de 30 dias com lembrete",
                            "Aviso de 30 a 59 dias é aceitável em contrato de baixo valor, desde que o prazo vá para o radar com alerta de 90 dias.",
                        ),
                    ],
                    unacceptable: [
                        position(
                            "Renovação automática com aviso curto",
                            "Renovação automática com aviso de não renovação menor que 60 dias (REN-01).",
                        ),
                        position(
                            "Prazo indeterminado sem saída para a Avenia",
                            "Vigência indeterminada e a Avenia sem direito de rescisão imotivada (REN-03).",
                        ),
                    ],
                    conditions: [],
                    actions: [],
                    sourceRefs: [],
                },
                {
                    id: "avenia-rescisao",
                    name: "Rescisão sem justa causa",
                    concept: "Direito de rescindir o contrato sem justa causa (imotivada), quem tem e com qual aviso prévio.",
                    scope: "clause" as const,
                    required: true,
                    guidance:
                        "A saída precisa ser recíproca. Parceiro crítico (BaaS, PSP, liquidez OTC, custódia) que encerra com aviso curto deixa a operação parada: migrar leva meses.",
                    standard: position(
                        "Rescisão recíproca com o mesmo aviso",
                        "Qualquer parte rescinde sem justa causa com aviso de 30 a 90 dias, sem multa; parceiro crítico, com no mínimo 90 a 180 dias e dever de cooperar na transição.",
                        "Qualquer das Partes poderá rescindir este Contrato, sem justa causa e sem ônus, mediante aviso prévio por escrito de 60 (sessenta) dias.",
                    ),
                    fallbacks: [],
                    unacceptable: [
                        position(
                            "Só a contraparte rescinde",
                            "Só a contraparte pode rescindir sem justa causa (RES-01).",
                        ),
                        position(
                            "Parceiro crítico encerra com aviso curto",
                            "Parceiro crítico pode encerrar com aviso menor que 90 dias (RES-03).",
                        ),
                    ],
                    conditions: [],
                    actions: [],
                    sourceRefs: [],
                },
            ],
        },
        {
            id: "avenia-disputas",
            name: "Lei aplicável e foro",
            rules: [
                {
                    id: "avenia-foro",
                    name: "Lei aplicável e foro",
                    concept: "Cláusula de lei aplicável e de solução de disputas (foro judicial ou arbitragem).",
                    scope: "clause" as const,
                    required: true,
                    guidance:
                        "Lei estrangeira ou foro fora do Brasil tornam a disputa cara e lenta, e o contrato precisa de revisão por advogado da jurisdição.",
                    standard: position(
                        "Lei brasileira e foro de São Paulo",
                        "Lei brasileira e foro da Comarca de São Paulo/SP, ou arbitragem em câmara brasileira reconhecida para contratos de valor alto.",
                        "Este Contrato é regido pelas leis da República Federativa do Brasil. Fica eleito o foro da Comarca de São Paulo/SP para dirimir quaisquer controvérsias, com renúncia a qualquer outro, por mais privilegiado que seja.",
                    ),
                    fallbacks: [
                        position(
                            "Arbitragem internacional com sede neutra",
                            "Em contrato cross-border com a entidade estrangeira do grupo, arbitragem internacional (ICC ou similar) com sede neutra.",
                        ),
                    ],
                    unacceptable: [
                        position(
                            "Lei ou foro estrangeiro para a entidade brasileira",
                            "A entidade brasileira da Avenia fica sujeita a lei ou foro estrangeiro (FOR-01).",
                        ),
                    ],
                    conditions: [],
                    actions: [],
                    sourceRefs: [],
                },
            ],
        },
    ],
};
