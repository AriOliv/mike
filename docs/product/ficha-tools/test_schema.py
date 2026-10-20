import copy
import json
import sys

import jsonschema
from jsonschema import Draft202012Validator, FormatChecker

schema = json.load(open(sys.argv[1]))
V = Draft202012Validator(schema, format_checker=FormatChecker())

NF = {"status": "nao_encontrado", "value": None, "citations": [], "confidence": None, "origin": "ia"}


def cit(q, page=1, clause=None):
    return {"quote": q, "page": page, "clause": clause}


def found(value, quote, clause=None, conf="alta"):
    return {"status": "encontrado", "value": value, "citations": [cit(quote, 3, clause)], "confidence": conf, "origin": "ia"}


def all_nf(section_name):
    return {k: dict(NF) for k in schema["properties"][section_name]["properties"]}


ficha = {
    "schema_version": "1.0",
    "contrato_id": "8b0c-uuid",
    "documento": {"document_id": "d1", "document_version_id": "v1", "nome": "contrato.pdf", "ocr": False},
    "extracao": {"modelo": "claude-sonnet-5-5", "prompt_version": "ficha-v1.0", "executado_em": "2026-10-20T12:00:00Z"},
    "identificacao": all_nf("identificacao"),
    "obrigacoes": dict(NF),
    "pagamento": all_nf("pagamento"),
    "vigencia": all_nf("vigencia"),
    "rescisao": all_nf("rescisao"),
    "alteracao_parte": all_nf("alteracao_parte"),
    "dados_pessoais": all_nf("dados_pessoais"),
    "responsabilidade": all_nf("responsabilidade"),
    "regulatorio": all_nf("regulatorio"),
    "foro": all_nf("foro"),
    "gestao": {
        "area_responsavel": {"value": "comercial", "updated_by": "legal@avenia.io", "updated_at": "2026-10-20T12:00:00Z"},
        "dono_email": {"value": None},
        "link_drive": {"value": "https://drive.google.com/x"},
        "status_contrato": {"value": "vigente"},
        "historico_alteracao_parte": {"value": []},
        "antecedencia_alerta_dias": {"value": None},
        "validacao": {"estado": "rascunho_ia"},
    },
    "derivados": {"vencimento_atual": "2027-03-01", "risco_geral": "atencao", "completude": {"nucleo_total": 22, "nucleo_encontrados": 3, "nucleo_validados": 0}},
    "achados": [],
}
ficha["identificacao"]["tipo_contrato"] = {
    "status": "inferido", "value": {"categoria": "parceiro_bancario_baas", "descricao": "Banking as a service"},
    "citations": [], "confidence": "media", "origin": "ia", "notes": "Objeto descreve conta e Pix como serviço.",
}
ficha["vigencia"]["renovacao"] = found(
    {"tipo": "automatica", "periodo": {"amount": 12, "unit": "meses", "day_count": "nao_especificado"}, "limite_renovacoes": None,
     "aviso_nao_renovacao": {"amount": 30, "unit": "dias", "day_count": "corridos", "days": 30}, "forma_notificacao": "email"},
    "renovado automaticamente por iguais períodos de 12 meses, salvo manifestação em contrário com 30 dias", "12.1")
ficha["pagamento"]["valor"] = found(
    {"modelo": "por_transacao", "itens": [{"descricao": "Pix out", "valor": {"amount": "0.15", "currency": "BRL"}, "percentual": None, "bps": None, "periodicidade": "por_transacao", "minimo": None}],
     "valor_estimado_anual": None, "quem_paga": "avenia"}, "R$ 0,15 por transação Pix", "Anexo I")
ficha["alteracao_parte"]["mudanca_controle"] = found(
    {"regime": "consentimento_previo", "aplica_a": "avenia", "excecoes": [], "prazo_antecedencia": {"amount": 30, "unit": "dias", "day_count": "uteis"},
     "penalidade": {"tipo": "rescisao", "descricao": "rescisão imediata"}, "direito_rescisao_contraparte": True, "define_controle": False},
    "qualquer alteração do controle societário dependerá de prévia anuência", "15.3")
ficha["achados"].append({
    "rule_id": "REN-01", "severidade": "alta", "titulo": "Renovação automática com aviso curto",
    "justificativa": "30 dias < 60", "campos": ["vigencia.renovacao"], "citations": [cit("salvo manifestação em contrário com 30 dias", 3, "12.1")],
    "avaliado_por": "motor", "estado": "aberto"})

errs = list(V.iter_errors(ficha))
assert not errs, [(list(e.absolute_path), e.message) for e in errs]
print("ficha valida: OK")


def expect_invalid(label, mutate):
    f = copy.deepcopy(ficha)
    mutate(f)
    assert list(V.iter_errors(f)), f"deveria falhar: {label}"
    print("rejeita:", label)


expect_invalid("encontrado sem citação", lambda f: f["vigencia"]["renovacao"].update(citations=[]))
expect_invalid("nao_encontrado com valor", lambda f: f["vigencia"]["data_assinatura"].update(value="2026-01-01"))
expect_invalid("encontrado com valor null", lambda f: f["vigencia"]["data_assinatura"].update(status="encontrado", citations=[cit("x")]))
expect_invalid("inferido sem notes", lambda f: f["identificacao"]["tipo_contrato"].pop("notes"))
expect_invalid("data mal formatada", lambda f: f["vigencia"].__setitem__("data_assinatura", found("01/02/2026", "1 de fevereiro")))
expect_invalid("dinheiro como float", lambda f: f["pagamento"]["valor"]["value"]["itens"][0]["valor"].__setitem__("amount", 0.15))
expect_invalid("enum fora da lista", lambda f: f["alteracao_parte"]["mudanca_controle"]["value"].__setitem__("regime", "talvez"))
expect_invalid("campo extra no valor", lambda f: f["vigencia"]["renovacao"]["value"].__setitem__("foo", 1))
expect_invalid("campo extra no envelope", lambda f: f["vigencia"]["renovacao"].__setitem__("foo", 1))
expect_invalid("seção faltando campo", lambda f: f["vigencia"].pop("prazo"))
expect_invalid("dias úteis inválido", lambda f: f["vigencia"]["renovacao"]["value"]["aviso_nao_renovacao"].__setitem__("day_count", "uteis_bancarios"))

# correção humana: origem humano dispensa citação, preserva ai_value
f = copy.deepcopy(ficha)
f["vigencia"]["data_assinatura"] = {"status": "encontrado", "value": "2026-02-01", "citations": [], "confidence": "alta", "origin": "humano",
                                    "ai_value": None, "review": {"state": "corrigido", "by": "legal@avenia.io", "at": "2026-10-21T10:00:00Z"}}
errs = list(V.iter_errors(f))
assert not errs, [(list(e.absolute_path), e.message) for e in errs]
print("correção humana sem citação: OK")
