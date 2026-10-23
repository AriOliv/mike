"""Gera docs/product/contract-schema.v1.json (fonte: este script, mantido fora do repo)."""
import json
import sys

NULL = {"type": "null"}


def nullable(s):
    return {"anyOf": [s, NULL]}


def enum(*vals, null=True):
    return {"enum": list(vals) + ([None] if null else [])}


STR = {"type": "string", "minLength": 1}
BOOL = {"type": "boolean"}
INT0 = {"type": "integer", "minimum": 0}
PCT = {"type": "number", "minimum": 0, "maximum": 100, "description": "Percentual em pontos (2 = 2%)."}
DATE = {"$ref": "#/$defs/date"}
DUR = {"$ref": "#/$defs/duration"}
MONEY = {"$ref": "#/$defs/money"}
NOTIF = enum("email", "carta_ar", "cartorio", "plataforma", "qualquer_meio_escrito", "nao_especificada")
INDICE = enum("IPCA", "IGP-M", "INPC", "IGP-DI", "IPC-FIPE", "SELIC", "CDI", "TR", "outro", "nenhum")
PARTE = enum("avenia", "contraparte", "ambas")
PAPEL_LGPD = enum("controlador", "operador", "controlador_conjunto", "suboperador", "nao_definido")


def obj(props, required=None):
    return {
        "type": "object",
        "additionalProperties": False,
        "required": required if required is not None else list(props),
        "properties": props,
    }


def field(value_schema, desc, col=None, origem="ia", nucleo=False):
    """Campo extraido: envelope (status, valor, citacoes, confianca) + tipo do valor."""
    f = {
        "description": desc,
        "allOf": [{"$ref": "#/$defs/campo"}],
        "properties": {"value": value_schema if value_schema.get("enum") else nullable(value_schema)},
        "unevaluatedProperties": False,
        "x-origem": origem,
        "x-nucleo": nucleo,
    }
    if col:
        f["x-planilha"] = col
    return f


def section(desc, fields):
    return {
        "type": "object",
        "description": desc,
        "additionalProperties": False,
        "required": list(fields),
        "properties": fields,
    }


defs = {
    "date": {"type": "string", "format": "date", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
    "duration": {
        "description": "Prazo relativo como está no contrato. A IA preenche amount/unit/day_count; `days` é calculado pelo código (nunca pelo modelo).",
        **obj(
            {
                "amount": {"type": "number", "minimum": 0},
                "unit": {"enum": ["horas", "dias", "meses", "anos"]},
                "day_count": {
                    "enum": ["corridos", "uteis", "nao_especificado"],
                    "description": "Dias úteis x corridos. 'nao_especificado' é tratado como corridos no cálculo e sinalizado.",
                },
                "days": {"type": ["integer", "null"], "description": "Equivalente em dias corridos, preenchido pelo normalizador quando computável sem data-âncora (unidade dias/horas corridos)."},
            },
            ["amount", "unit", "day_count"],
        ),
    },
    "money": {
        **obj(
            {
                "amount": {"type": "string", "pattern": r"^-?\d+(\.\d{1,8})?$", "description": "Decimal como string (sem float). 'R$ 1.234,56' -> '1234.56'."},
                "currency": {"type": "string", "pattern": "^[A-Z]{3,5}$", "description": "ISO 4217 (BRL, USD, EUR) ou ticker (USDC, USDT, BRLA)."},
            }
        )
    },
    "citacao": {
        "description": "Trecho que embasa o valor. `quote` é VERBATIM; page/clause vêm do extrator; span/verified/match são preenchidos pelo verificador.",
        **obj(
            {
                "quote": {"type": "string", "minLength": 1, "maxLength": 1500},
                "page": {"type": ["integer", "null"], "minimum": 1},
                "clause": {"type": ["string", "null"], "description": "Ex.: '11.2', 'Cláusula Décima', 'Anexo II, item 3'."},
                "document_version_id": {"type": ["string", "null"]},
                "span": nullable(obj({"start": INT0, "end": INT0})),
                "verified": {"type": ["boolean", "null"]},
                "match": enum("exato", "normalizado", "aproximado", "nao_encontrado"),
            },
            ["quote", "page", "clause"],
        ),
    },
    "revisao": {
        "description": "Validação humana do campo.",
        **obj(
            {
                "state": {"enum": ["pendente", "confirmado", "corrigido"]},
                "by": {"type": ["string", "null"], "description": "E-mail de quem validou."},
                "at": {"type": ["string", "null"], "format": "date-time"},
                "comment": {"type": ["string", "null"]},
            },
            ["state"],
        ),
    },
    "campo": {
        "description": "Envelope de todo campo extraído. Nunca há valor sem status; 'não encontrado' é explícito.",
        "type": "object",
        "required": ["status", "value", "citations", "confidence", "origin"],
        "properties": {
            "status": {
                "enum": ["encontrado", "inferido", "ambiguo", "nao_encontrado", "nao_aplicavel"],
                "description": "encontrado: está no texto (citação obrigatória). inferido: conclusão sobre o conjunto (ex.: tipo de contrato), justificativa obrigatória. ambiguo: cláusulas conflitantes ou redação dúbia (citações + nota). nao_encontrado: o contrato não trata do tema. nao_aplicavel: o tema não cabe neste tipo de contrato.",
            },
            "value": {},
            "citations": {"type": "array", "items": {"$ref": "#/$defs/citacao"}},
            "confidence": enum("alta", "media", "baixa"),
            "notes": {"type": ["string", "null"]},
            "origin": {"enum": ["ia", "humano", "sistema"]},
            "ai_value": {"description": "Valor original da IA, preservado quando um humano corrige. Alimenta as métricas de qualidade."},
            "review": {"$ref": "#/$defs/revisao"},
        },
        "allOf": [
            {
                "if": {"properties": {"status": {"enum": ["encontrado", "ambiguo"]}, "origin": {"const": "ia"}}, "required": ["status", "origin"]},
                "then": {"properties": {"citations": {"minItems": 1}}},
            },
            {
                "if": {"properties": {"status": {"enum": ["encontrado", "inferido"]}}, "required": ["status"]},
                "then": {"properties": {"value": {"not": NULL}}},
            },
            {
                "if": {"properties": {"status": {"enum": ["nao_encontrado", "nao_aplicavel"]}}, "required": ["status"]},
                "then": {"properties": {"value": NULL}},
            },
            {
                "if": {"properties": {"status": {"enum": ["inferido", "ambiguo"]}}, "required": ["status"]},
                "then": {"required": ["notes"], "properties": {"notes": {"type": "string", "minLength": 1}}},
            },
        ],
    },
    "auditado": {
        "description": "Valor preenchido por humano ou sistema (não extraído), com trilha.",
        "type": "object",
        "required": ["value"],
        "properties": {
            "value": {},
            "updated_by": {"type": ["string", "null"]},
            "updated_at": {"type": ["string", "null"], "format": "date-time"},
        },
    },
    "achado": {
        "description": "Resultado de uma regra de risco (risk-rules.v1.yaml) sobre esta ficha.",
        **obj(
            {
                "rule_id": {"type": "string", "pattern": "^[A-Z]{3,4}-\\d{2}$"},
                "severidade": {"enum": ["critica", "alta", "media", "baixa", "info"]},
                "titulo": STR,
                "justificativa": STR,
                "acao_sugerida": {"type": ["string", "null"]},
                "campos": {"type": "array", "items": {"type": "string"}},
                "citations": {"type": "array", "items": {"$ref": "#/$defs/citacao"}},
                "avaliado_por": {"enum": ["motor", "ia"]},
                "depende_de_campo_nao_validado": BOOL,
                "estado": {"enum": ["aberto", "risco_aceito", "mitigado", "falso_positivo"]},
                "decidido_por": {"type": ["string", "null"]},
                "decidido_em": {"type": ["string", "null"], "format": "date-time"},
            },
            ["rule_id", "severidade", "titulo", "justificativa", "campos", "citations", "avaliado_por", "estado"],
        ),
    },
}


def audited(value_schema, desc, col=None, origem="humano"):
    s = {
        "description": desc,
        "allOf": [{"$ref": "#/$defs/auditado"}],
        "properties": {"value": value_schema if value_schema.get("enum") else nullable(value_schema)},
        "unevaluatedProperties": False,
        "x-origem": origem,
    }
    if col:
        s["x-planilha"] = col
    return s


ALTERACAO_PARTE = {
    "regime": enum("livre", "notificacao", "consentimento_previo", "vedada", "nao_regulada", null=False),
    "aplica_a": PARTE,
    "excecoes": {"type": "array", "items": {"enum": ["afiliadas", "reorganizacao_societaria", "sucessor_fusao_incorporacao", "outro"]}},
    "prazo_antecedencia": nullable(DUR),
    "penalidade": nullable(
        obj(
            {
                "tipo": {"enum": ["rescisao", "multa", "ineficacia_da_cessao", "perdas_e_danos", "outra"]},
                "descricao": {"type": ["string", "null"]},
                "valor": nullable(MONEY),
                "percentual": nullable(PCT),
            },
            ["tipo", "descricao"],
        )
    ),
}

props = {
    "schema_version": {"const": "1.0"},
    "contrato_id": {"type": "string", "description": "projects.id do card na esteira."},
    "documento": obj(
        {
            "document_id": STR,
            "document_version_id": STR,
            "nome": {"type": ["string", "null"]},
            "sha256": {"type": ["string", "null"], "pattern": "^[a-f0-9]{64}$"},
            "paginas": {"type": ["integer", "null"], "minimum": 1},
            "ocr": {"type": "boolean", "description": "Texto veio de OCR (qualidade menor; confiança máxima 'media')."},
        },
        ["document_id", "document_version_id", "ocr"],
    ),
    "extracao": obj(
        {
            "modelo": STR,
            "prompt_version": STR,
            "executado_em": {"type": "string", "format": "date-time"},
            "verificado_em": {"type": ["string", "null"], "format": "date-time"},
        },
        ["modelo", "prompt_version", "executado_em"],
    ),
    "identificacao": section(
        "Quem, o quê e que tipo de documento.",
        {
            "tipo_contrato": field(
                obj(
                    {
                        "categoria": enum(
                            "nda", "prestacao_servicos", "msa", "pedido_sow", "licenca_saas",
                            "parceria_comercial", "indicacao_rebate", "parceiro_bancario_baas",
                            "arranjo_psp_adquirencia", "liquidez_otc_cambio", "custodia_cripto",
                            "cliente_api_plataforma", "locacao", "prestador_pj", "mutuo_emprestimo",
                            "carta_intencao_mou", "procuracao", "outro", null=False,
                        ),
                        "descricao": {"type": ["string", "null"]},
                    }
                ),
                "Classificação do contrato. Pode ser 'inferido' (sem cláusula única) com justificativa em notes.",
                "A", nucleo=True,
            ),
            "contraparte": field(
                obj(
                    {
                        "nome": STR,
                        "documento": {"type": ["string", "null"], "description": "CNPJ/CPF só dígitos, ou tax id estrangeiro."},
                        "tipo_documento": enum("cnpj", "cpf", "estrangeiro"),
                        "pais": {"type": ["string", "null"], "pattern": "^[A-Z]{2}$"},
                    }
                ),
                "Razão social da outra parte, como qualificada no preâmbulo.", "B", nucleo=True,
            ),
            "entidade_avenia": field(
                obj({"nome": STR, "documento": {"type": ["string", "null"]}}),
                "Qual entidade do grupo assina (validar contra a lista canônica de entidades).", nucleo=True,
            ),
            "papel_avenia": field(
                enum("contratante", "contratada", "mutuo", "outro"),
                "Avenia paga/recebe o serviço? Define a direção de várias regras de risco.", nucleo=True,
            ),
            "objeto": field(STR, "Objeto em uma frase."),
            "natureza_documento": field(
                enum("contrato_principal", "aditivo", "distrato", "termo_adesao", "pedido_sow", "carta_intencao"),
                "Aditivo/distrato altera uma ficha existente em vez de criar outra.",
            ),
            "idioma": field(enum("pt", "en", "es", "outro"), "Idioma prevalente."),
            "anexos_referenciados": field(
                {"type": "array", "items": obj({"nome": STR, "referencia": {"type": ["string", "null"]}, "presente_no_documento": BOOL})},
                "Anexos/documentos incorporados por referência (ex.: DPA por URL, tabela de tarifas). presente_no_documento=false é lacuna de análise.",
            ),
        },
    ),
    "obrigacoes": field(
        {
            "type": "array",
            "items": obj(
                {
                    "descricao": STR,
                    "parte_obrigada": PARTE,
                    "tipo": {"enum": ["periodica", "pontual", "continua", "condicional"]},
                    "periodicidade": enum("diaria", "semanal", "mensal", "trimestral", "semestral", "anual", "outra"),
                    "prazo": nullable(DUR),
                    "data": nullable(DATE),
                    "gatilho": {"type": ["string", "null"], "description": "Evento que dispara o prazo (ex.: 'recebimento da fatura')."},
                    "citations": {"type": "array", "minItems": 1, "items": {"$ref": "#/$defs/citacao"}},
                },
                ["descricao", "parte_obrigada", "tipo", "periodicidade", "prazo", "data", "gatilho", "citations"],
            ),
        },
        "Obrigações periódicas/importantes de qualquer parte (relatórios, certidões, SLAs com prazo, entregas). Cada item com sua própria citação.",
        "F",
    ),
    "pagamento": section(
        "Preço e condições de pagamento.",
        {
            "prazo": field(
                obj(
                    {
                        "prazo": nullable(DUR),
                        "gatilho": enum("emissao_nf", "recebimento_fatura", "fim_do_periodo", "antecipado", "dia_fixo", "outro"),
                        "dia_fixo": {"type": ["integer", "null"], "minimum": 1, "maximum": 31},
                    }
                ),
                "Prazo de pagamento.", "G",
            ),
            "multa_moratoria": field(
                obj({"percentual": nullable(PCT), "valor": nullable(MONEY), "base": {"type": ["string", "null"]}}),
                "Multa por atraso de pagamento.", "H",
            ),
            "juros_mora": field(
                obj(
                    {
                        "percentual": nullable(PCT),
                        "periodo": enum("dia", "mes", "ano"),
                        "pro_rata_die": {"type": ["boolean", "null"]},
                        "capitalizacao": enum("simples", "composta", "nao_especificada"),
                    }
                ),
                "Juros de mora.", "I",
            ),
            "correcao_monetaria": field(
                obj({"indice": INDICE, "indice_substituto": INDICE, "aplica_a": enum("atraso", "preco", "ambos")}),
                "Correção monetária de valores em atraso (coluna J da planilha). Reajuste periódico de preço vai em `reajuste`.", "J",
            ),
            "reajuste": field(
                obj(
                    {
                        "indice": INDICE,
                        "periodicidade": nullable(DUR),
                        "data_base_regra": enum("aniversario_contrato", "data_fixa", "nao_especificada"),
                        "data_base": nullable(DATE),
                        "teto_percentual": nullable(PCT),
                    }
                ),
                "Reajuste periódico do preço.",
            ),
            "valor": field(
                obj(
                    {
                        "modelo": enum("fixo_unico", "recorrente", "por_transacao", "percentual", "tabela_anexa", "sem_contraprestacao", "misto", null=False),
                        "itens": {
                            "type": "array",
                            "items": obj(
                                {
                                    "descricao": STR,
                                    "valor": nullable(MONEY),
                                    "percentual": nullable(PCT),
                                    "bps": {"type": ["number", "null"], "minimum": 0},
                                    "periodicidade": enum("unico", "mensal", "anual", "por_transacao", "por_evento", "outra"),
                                    "minimo": nullable(MONEY),
                                }
                            ),
                        },
                        "valor_estimado_anual": nullable(MONEY),
                        "quem_paga": PARTE,
                    }
                ),
                "Contraprestação. Tarifas em bps/percentual são comuns em contratos de pagamento e cripto.", "K", nucleo=True,
            ),
            "tributos": field(
                obj(
                    {
                        "regime": enum("inclusos_no_preco", "acrescidos_ao_preco", "gross_up", "nao_especificado", null=False),
                        "retencoes": {"type": "array", "items": {"enum": ["ISS", "IRRF", "PIS", "COFINS", "CSLL", "INSS", "IOF", "CIDE", "outro"]}},
                    }
                ),
                "Tratamento de tributos.", "L",
            ),
            "moeda_conversao": field(
                obj({"moeda": {"type": "string", "pattern": "^[A-Z]{3,5}$"}, "regra_conversao": {"type": ["string", "null"], "description": "Ex.: 'PTAX venda do dia útil anterior ao pagamento'."}}),
                "Moeda do contrato e regra de conversão quando não for BRL.",
            ),
        },
    ),
    "vigencia": section(
        "Datas e renovação. A IA extrai o literal; vencimento atual e janelas de aviso são calculados em `derivados`.",
        {
            "data_assinatura": field(DATE, "Data de assinatura (em assinatura eletrônica, a da última assinatura).", "M", nucleo=True),
            "data_inicio": field(DATE, "Início da vigência, se diferente da assinatura."),
            "prazo": field(
                obj({"tipo": enum("determinado", "indeterminado", null=False), "duracao": nullable(DUR)}),
                "Prazo de vigência.", "N", nucleo=True,
            ),
            "data_vencimento": field(DATE, "Data de término SÓ quando escrita no contrato. Não calcular aqui.", "P", nucleo=True),
            "renovacao": field(
                obj(
                    {
                        "tipo": enum("automatica", "mediante_aditivo", "opcao_unilateral", "sem_renovacao", "nao_regulada", null=False),
                        "periodo": nullable(DUR),
                        "limite_renovacoes": {"type": ["integer", "null"], "minimum": 0},
                        "aviso_nao_renovacao": nullable(DUR),
                        "forma_notificacao": NOTIF,
                    }
                ),
                "Renovação e o aviso para impedi-la (distinto do aviso de rescisão imotivada).", "Q", nucleo=True,
            ),
        },
    ),
    "rescisao": section(
        "Saída do contrato.",
        {
            "imotivada": field(
                obj(
                    {
                        "permitida_para": enum("ambas", "somente_avenia", "somente_contraparte", "nenhuma", null=False),
                        "aviso_previo_avenia": nullable(DUR),
                        "aviso_previo_contraparte": nullable(DUR),
                        "forma_notificacao": NOTIF,
                    }
                ),
                "Rescisão antecipada sem justa causa (R) e aviso prévio (S, o da Avenia).", "R,S", nucleo=True,
            ),
            "multa_rescisoria": field(
                obj(
                    {
                        "existe": BOOL,
                        "tipo": enum("fixo", "percentual_valor_total", "percentual_saldo", "meses_remuneracao", "proporcional", "formula"),
                        "percentual": nullable(PCT),
                        "meses": {"type": ["number", "null"], "minimum": 0},
                        "valor": nullable(MONEY),
                        "descricao": {"type": ["string", "null"]},
                        "devida_por": PARTE,
                        "hipotese": enum("imotivada", "motivada", "ambas"),
                    }
                ),
                "Multa rescisória (T: existe; U: valor).", "T,U", nucleo=True,
            ),
        },
    ),
    "alteracao_parte": section(
        "Cessão e mudança de controle (relevante para captação, M&A e reorganização do grupo).",
        {
            "cessao": field(
                obj(ALTERACAO_PARTE),
                "Cessão da posição contratual. Planilha: V Sim/Não = regime != vedada; W = regime; X = prazo_antecedencia; Y = penalidade.",
                "V,W,X,Y", nucleo=True,
            ),
            "mudanca_controle": field(
                obj(
                    {
                        **ALTERACAO_PARTE,
                        "direito_rescisao_contraparte": {"type": ["boolean", "null"]},
                        "define_controle": {"type": ["boolean", "null"], "description": "O contrato define o que é 'controle' (percentual, poder de eleger administradores)?"},
                    }
                ),
                "Mudança de controle societário. Planilha: Z..AC, mesma leitura de cessão.",
                "Z,AA,AB,AC", nucleo=True,
            ),
        },
    ),
    "dados_pessoais": section(
        "LGPD e sigilo de dados.",
        {
            "compartilhamento": field(BOOL, "Há tratamento/compartilhamento de dados pessoais entre as partes.", "AD", nucleo=True),
            "papel_avenia": field(PAPEL_LGPD, "Agente de tratamento da Avenia.", "AE", nucleo=True),
            "papel_contraparte": field(PAPEL_LGPD, "Agente de tratamento da contraparte."),
            "dpa": field(enum("no_corpo", "anexo", "por_referencia", "ausente"), "Onde estão as cláusulas de tratamento de dados."),
            "transferencia_internacional": field(
                obj({"ocorre": BOOL, "mecanismo": {"type": ["string", "null"], "description": "Ex.: cláusulas-padrão ANPD, consentimento, adequação."}}),
                "Transferência internacional de dados.",
            ),
            "prazo_notificacao_incidente": field(DUR, "Prazo para a contraparte avisar a Avenia de incidente de segurança."),
            "sigilo_financeiro": field(BOOL, "Envolve dados cobertos por sigilo financeiro/bancário de clientes."),
        },
    ),
    "responsabilidade": section(
        "Exposição financeira além do preço.",
        {
            "limitacao": field(
                obj(
                    {
                        "existe": BOOL,
                        "protege": PARTE,
                        "tipo": enum("valor_fixo", "multiplo_remuneracao", "meses_remuneracao", "ilimitada"),
                        "valor": nullable(MONEY),
                        "meses": {"type": ["number", "null"], "minimum": 0},
                        "excecoes": {"type": "array", "items": {"enum": ["dolo", "culpa_grave", "dados_pessoais", "confidencialidade", "propriedade_intelectual", "trabalhista", "regulatoria_multas", "indenizacao_terceiros", "outro"]}},
                        "exclui_danos_indiretos": {"type": ["boolean", "null"]},
                    }
                ),
                "Limitação de responsabilidade.", nucleo=True,
            ),
            "multa_geral": field(
                obj(
                    {
                        "existe": BOOL,
                        "valor": nullable(MONEY),
                        "percentual": nullable(PCT),
                        "natureza": enum("compensatoria", "nao_compensatoria", "nao_especificada"),
                        "devida_por": PARTE,
                        "hipoteses": {"type": ["string", "null"]},
                        "limitada": {"type": ["boolean", "null"]},
                    }
                ),
                "Multa por descumprimento (não moratória, não rescisória).", "AF",
            ),
            "indenizacao_terceiros": field(
                obj({"existe": BOOL, "devida_por": PARTE, "escopo": {"type": ["string", "null"]}}),
                "Obrigação de indenizar/defender contra reclamações de terceiros.",
            ),
        },
    ),
    "regulatorio": section(
        "Cláusulas que importam para uma instituição regulada (IP/SPSAV, parceiros bancários).",
        {
            "pld_ft": field(BOOL, "Há declarações/obrigações de prevenção à lavagem de dinheiro e financiamento ao terrorismo."),
            "anticorrupcao": field(BOOL, "Há cláusula anticorrupção."),
            "confidencialidade": field(
                obj(
                    {
                        "existe": BOOL,
                        "prazo_sobrevivencia": nullable(DUR),
                        "sobrevivencia_indeterminada": {"type": ["boolean", "null"]},
                        "carve_out_autoridades": {"type": ["boolean", "null"], "description": "Permite divulgar a reguladores/autoridades (BCB, COAF, ordem judicial) sem violar o contrato."},
                        "exige_aviso_previo_a_contraparte": {"type": ["boolean", "null"], "description": "Exige avisar a contraparte antes de qualquer divulgação a autoridade."},
                    }
                ),
                "Confidencialidade.", nucleo=True,
            ),
            "acesso_regulador_auditoria": field(
                obj({"acesso_regulador": {"type": ["boolean", "null"]}, "auditoria_pela_avenia": {"type": ["boolean", "null"]}, "plano_saida": {"type": ["boolean", "null"]}}),
                "Acesso do regulador, auditoria e plano de saída (serviços terceirizados relevantes).",
            ),
            "alteracao_unilateral": field(
                obj(
                    {
                        "contraparte_pode_alterar": BOOL,
                        "escopo": enum("preco", "termos", "ambos"),
                        "aviso": nullable(DUR),
                        "direito_de_sair_sem_multa": {"type": ["boolean", "null"]},
                    }
                ),
                "A contraparte pode alterar preço ou termos por conta própria.", nucleo=True,
            ),
            "suspensao_servico": field(
                obj({"contraparte_pode_suspender": BOOL, "hipoteses": {"type": ["string", "null"]}, "aviso": nullable(DUR)}),
                "A contraparte pode suspender/bloquear o serviço (crítico com parceiro bancário).",
            ),
            "exclusividade": field(
                obj({"existe": BOOL, "obriga": PARTE, "escopo": {"type": ["string", "null"]}, "prazo": nullable(DUR)}),
                "Exclusividade, não concorrência ou não aliciamento.",
            ),
            "segregacao_ativos_clientes": field(
                obj({"aplicavel": BOOL, "prevista": {"type": ["boolean", "null"]}}),
                "Em custódia/liquidez de cripto ou recursos de clientes: há segregação patrimonial dos ativos dos clientes?",
            ),
        },
    ),
    "foro": section(
        "Lei e disputas.",
        {
            "lei_aplicavel": field(obj({"jurisdicao": {"type": "string", "description": "Ex.: 'BR', 'US-NY', 'GB'."}}), "Lei aplicável."),
            "solucao_disputas": field(
                obj({"meio": enum("judicial", "arbitragem", "mediacao_e_arbitragem", null=False), "foro_ou_camara": {"type": ["string", "null"]}, "sede": {"type": ["string", "null"]}}),
                "Foro ou arbitragem.",
            ),
        },
    ),
    "gestao": section(
        "Preenchido pelo Legal ou pelo sistema. Não é extraído do contrato.",
        {
            "area_responsavel": audited(enum("comercial", "operacoes", "produto", "tecnologia", "financeiro", "compliance", "pessoas", "marketing", "diretoria", "outro"), "Área dona da relação.", "C"),
            "dono_email": audited({"type": "string", "format": "email"}, "Pessoa responsável pela próxima ação. Padrão: assignee do card."),
            "link_drive": audited({"type": "string", "format": "uri"}, "Espelho no Drive.", "D", origem="sistema"),
            "status_contrato": audited(
                enum("em_negociacao", "vigente", "vencido", "rescindido", "suspenso"),
                "Situação. Sugerido por `derivados.ativo`; o humano confirma (rescisão não aparece no texto).", "E",
            ),
            "historico_alteracao_parte": audited(
                {
                    "type": "array",
                    "items": obj(
                        {
                            "tipo": {"enum": ["cessao", "mudanca_controle"]},
                            "data": nullable(DATE),
                            "descricao": STR,
                            "documento_ref": {"type": ["string", "null"]},
                        }
                    ),
                },
                "Eventos já ocorridos de cessão ou mudança de controle (colunas AG/AH, leitura a confirmar com o Legal).", "AG,AH",
            ),
            "antecedencia_alerta_dias": audited({"type": "integer", "minimum": 0}, "Sobrescreve o padrão de antecedência do alerta de renovação para este contrato."),
            "validacao": obj(
                {
                    "estado": {"enum": ["rascunho_ia", "em_validacao", "validado"]},
                    "validado_por": {"type": ["string", "null"]},
                    "validado_em": {"type": ["string", "null"], "format": "date-time"},
                },
                ["estado"],
            ),
        },
    ),
    "derivados": {
        "type": "object",
        "description": "Calculado pelo código a partir dos campos acima. Nunca pelo modelo. Recalculado a cada leitura/validação.",
        "additionalProperties": False,
        "x-origem": "derivado",
        "properties": {
            "vencimento_atual": {**nullable(DATE), "description": "Fim do período corrente: data_vencimento ou início+prazo; rola para frente a cada renovação automática."},
            "data_limite_aviso_calendario": {**nullable(DATE), "description": "vencimento_atual − aviso (nao_renovacao se renova automaticamente; senão aviso_previo_avenia)."},
            "data_limite_aviso_efetiva": {**nullable(DATE), "description": "Recuada para o último dia útil (feriados nacionais BR, ou do foro quando estrangeiro)."},
            "data_envio_recomendada": {**nullable(DATE), "description": "data_limite_aviso_efetiva − folga de entrega (carta/cartório)."},
            "data_alerta": {**nullable(DATE), "description": "data_envio_recomendada − antecedência de alerta."},
            "dias_para_vencimento": {"type": ["integer", "null"], "readOnly": True, "description": "Calculado na leitura (coluna O); não é persistido.", "x-planilha": "O"},
            "dias_ate_limite_aviso": {"type": ["integer", "null"], "readOnly": True, "description": "data_limite_aviso_efetiva − hoje. Calculado na leitura; usado por REN-02."},
            "ativo": {"type": ["boolean", "null"], "description": "Sugestão de vigência para a coluna E."},
            "proximo_reajuste": nullable(DATE),
            "proxima_acao": nullable(
                obj(
                    {
                        "tipo": {"enum": ["decidir_renovacao", "enviar_aviso", "reajuste", "obrigacao", "validar_ficha", "tratar_risco"]},
                        "data": nullable(DATE),
                        "descricao": STR,
                        "dono_email": {"type": ["string", "null"]},
                    }
                )
            ),
            "risco_geral": {"enum": ["critico", "atencao", "ok", None], "description": "Mesmo vocabulário de projects.risk_level."},
            "completude": obj({"nucleo_total": INT0, "nucleo_encontrados": INT0, "nucleo_validados": INT0}),
            "memoria_calculo": {"type": "array", "items": {"type": "string"}, "description": "Como cada data foi calculada, legível pelo Legal."},
        },
    },
    "achados": {"type": "array", "items": {"$ref": "#/$defs/achado"}, "description": "Saída do avaliador de risco. Persistido em tabela própria; aqui para export."},
}

schema = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://clm.avenia.tech/schemas/contract-schema.v1.json",
    "title": "Ficha do Contrato v1",
    "description": "Schema da ficha estruturada de um contrato (CLM Avenia). Ver docs/product/02-ficha-do-contrato.md. Palavras-chave x-* são anotações (x-planilha = coluna da planilha do Legal; x-origem = ia|humano|sistema|derivado; x-nucleo = campo núcleo).",
    "type": "object",
    "additionalProperties": False,
    "required": ["schema_version", "contrato_id", "documento", "extracao", "identificacao", "obrigacoes", "pagamento", "vigencia", "rescisao", "alteracao_parte", "dados_pessoais", "responsabilidade", "regulatorio", "foro", "gestao", "derivados"],
    "properties": props,
    "$defs": defs,
}

json.dump(schema, open(sys.argv[1], "w"), ensure_ascii=False, indent=2)
print("ok")
