# 02 · Ficha do Contrato (schema v1, regras de risco e agentes de análise)

> Autor: agente "cérebro de análise" · 2026-10-20 · Status: proposta para validação do Legal
> Arquivos: `contract-schema.v1.json` (JSON Schema 2020-12, gerado por `ficha-tools/gen_schema.py`) · `risk-rules.v1.yaml` (41 regras) · `ficha-tools/` (gerador + validadores)
> Base: planilha "Controle de Contratos - tabela base.xlsx" (34 colunas, A..AH), `backend/src/lib/contractTerms.ts`,
> dossiê do fork, prompts do Ada Legal (`avn-clm/api/app/prompts.py`), skills `commercial-legal` (renewal-tracker, escalation-flagger, vendor review).

## 1. Decisões (resumo)

1. **Uma ficha por contrato, em JSON versionado**: tabela nova `contract_fichas` com uma coluna `jsonb`, mais cópias desnormalizadas (só os campos usados em filtros e no radar). Não são 60 colunas: o schema vai mudar muito nos primeiros meses.
2. **Todo campo extraído vem num envelope**: `status`, `value`, `citations[]`, `confidence`, `origin`. "Não encontrado" é um status explícito, não um `null`. O schema **rejeita** valor encontrado sem citação, e também "não encontrado" com valor.
3. **A IA extrai o literal, o código calcula.** O modelo nunca calcula datas, dias até o vencimento nem a data limite de aviso. Ele devolve "30 dias úteis" e "vigência de 12 meses". Os campos `derivados` fazem a conta com calendário de dias úteis do Brasil.
4. **Citação verificada por código.** O verificador procura cada trecho citado no texto do contrato e preenche a página real, a posição e o tipo de correspondência. Uma citação não localizada derruba a confiança e gera um aviso de qualidade (DOC-04).
5. **Humano valida campo a campo.** Uma correção humana nunca é sobrescrita por nova extração. O valor original da IA fica guardado em `ai_value`, e isso alimenta as métricas.
6. **Regras de risco são dados (YAML), não prompt.** 39 das 41 regras rodam por código, sem IA: são determinísticas, testáveis e explicáveis. Só 2 usam IA, para perguntas de interpretação. A head de Legal ajusta os parâmetros (60 dias, 20%, etc.) sem deploy.
7. **Alertas saem do valor da IA na hora, marcados "a confirmar".** Um alerta a mais custa menos que uma renovação perdida. Depois da validação, o alerta perde a marca.
8. **O dossiê continua**: ele é a análise narrativa (redlines, pontos favoráveis). A partir de agora, o dossiê recebe a ficha e os achados como contexto, em vez de reler o contrato do zero.

## 2. O envelope de cada campo

```jsonc
"renovacao": {
  "status": "encontrado",            // encontrado | inferido | ambiguo | nao_encontrado | nao_aplicavel
  "value": { "tipo": "automatica", "periodo": {"amount": 12, "unit": "meses", "day_count": "nao_especificado"},
             "aviso_nao_renovacao": {"amount": 30, "unit": "dias", "day_count": "corridos", "days": 30},
             "limite_renovacoes": null, "forma_notificacao": "email" },
  "citations": [{ "quote": "renovado automaticamente por iguais períodos de 12 meses, salvo manifestação…",
                  "page": 3, "clause": "12.1",
                  "span": {"start": 18233, "end": 18402}, "verified": true, "match": "exato" }],
  "confidence": "alta",              // alta | media | baixa
  "origin": "ia",                    // ia | humano | sistema
  "notes": null,
  "ai_value": null,                  // preenchido quando humano corrige
  "review": { "state": "pendente" }  // pendente | confirmado | corrigido (+ by, at, comment)
}
```

| Status | Quando | Exige |
|---|---|---|
| `encontrado` | o texto diz | valor + ao menos 1 citação |
| `inferido` | conclusão sobre o todo (ex.: tipo de contrato, papel LGPD implícito) | valor + `notes` com a justificativa |
| `ambiguo` | cláusulas conflitantes ou redação dúbia (comum após aditivo) | citações das duas + `notes`; gera DOC-03 |
| `nao_encontrado` | o contrato não trata do tema | `value = null` |
| `nao_aplicavel` | o tema não cabe no tipo (ex.: reajuste num NDA) | `value = null` |

**Confiança** (regra fixa, não "sensação" do modelo): `alta` quando o trecho é explícito e o valor está literalmente nele; `media` quando exige leitura combinada de cláusulas ou o texto veio de OCR; `baixa` quando a redação é vaga. O verificador pode **rebaixar** a confiança, mas nunca subir.

## 3. Da planilha para a ficha (34 colunas)

Legenda de origem: **IA** = extraído · **H** = preenchido/validado por humano · **S** = sistema · **D** = derivado (código).

| Col | Planilha | Caminho na ficha | Tipo / valores | Origem |
|---|---|---|---|---|
| A | Tipo de Contrato | `identificacao.tipo_contrato.value.categoria` | enum de 18 tipos (inclui `parceiro_bancario_baas`, `arranjo_psp_adquirencia`, `liquidez_otc_cambio`, `custodia_cripto`, `cliente_api_plataforma`) | IA (inferido) |
| B | Contraparte | `identificacao.contraparte` | nome, CNPJ/CPF (dígitos), país ISO | IA |
| C | Área responsável | `gestao.area_responsavel` | enum de áreas | H |
| D | Link do drive | `gestao.link_drive` | URI | S (espelho do Drive) |
| E | Ativo? | `gestao.status_contrato` (sugestão em `derivados.ativo`) | em_negociacao / vigente / vencido / rescindido / suspenso | D sugere, H confirma |
| F | Obrigações periódicas/importantes | `obrigacoes[]` | lista: descrição, parte obrigada, periodicidade, prazo, data, gatilho, citação própria | IA |
| G | Pagamento · Prazo | `pagamento.prazo` | duração + gatilho (NF, fatura, dia fixo) | IA |
| H | Multa | `pagamento.multa_moratoria` | % ou valor | IA |
| I | Juros | `pagamento.juros_mora` | % + período (dia/mês/ano) + pro rata | IA |
| J | Correção Monetária | `pagamento.correcao_monetaria` | índice (IPCA, IGP-M, INPC, IGP-DI, IPC-FIPE, SELIC, CDI, TR, outro, nenhum) + substituto | IA |
| K | Valor | `pagamento.valor` | modelo (fixo, recorrente, por transação, %, tabela anexa…) + itens com dinheiro/%/bps | IA |
| L | Tributos | `pagamento.tributos` | inclusos / acrescidos / gross-up + retenções | IA |
| M | Data Assinatura | `vigencia.data_assinatura` | data ISO | IA |
| N | Prazo de vigência | `vigencia.prazo` | determinado/indeterminado + duração | IA |
| O | Dias para vencimento/renovação | `derivados.dias_para_vencimento` | inteiro, calculado na leitura (não é salvo) | D |
| P | Data de vencimento | `vigencia.data_vencimento` (literal) e `derivados.vencimento_atual` (calculado) | data | IA + D |
| Q | Renovação Automática | `vigencia.renovacao.value.tipo` | automática / aditivo / opção unilateral / sem / não regulada | IA |
| R | Rescisão antecipada | `rescisao.imotivada.value.permitida_para` | ambas / só Avenia / só contraparte / nenhuma | IA |
| S | Prazo do aviso prévio | `rescisao.imotivada.value.aviso_previo_avenia` (+ `_contraparte`) | duração | IA |
| T | Multa rescisória · Sim/Não | `rescisao.multa_rescisoria.value.existe` | bool | IA |
| U | Multa rescisória · Valor | `rescisao.multa_rescisoria.value` (tipo, %, meses, valor, devida_por, hipótese) | estruturado | IA |
| V | Cessão · Sim/Não | `alteracao_parte.cessao.value.regime` ≠ `vedada` | ver pendência P1 | IA |
| W | Cessão · Notificação/Autorização | `alteracao_parte.cessao.value.regime` | livre / notificação / consentimento prévio / vedada / não regulada | IA |
| X | Cessão · Prazo antecedência | `alteracao_parte.cessao.value.prazo_antecedencia` | duração | IA |
| Y | Cessão · Penalidade | `alteracao_parte.cessao.value.penalidade` | rescisão / multa / ineficácia / perdas e danos | IA |
| Z–AC | Alteração de Controle (mesmas 4) | `alteracao_parte.mudanca_controle` (+ `direito_rescisao_contraparte`, `define_controle`) | idem | IA |
| AD | Compartilhamento de dados · Sim/Não | `dados_pessoais.compartilhamento` | bool | IA |
| AE | Agente | `dados_pessoais.papel_avenia` | controlador / operador / controlador conjunto / suboperador / não definido | IA |
| AF | Multa (geral) | `responsabilidade.multa_geral` | %/valor, natureza, quem paga, limitada? | IA |
| AG | Alteração de parte · Cessão contratual | `gestao.historico_alteracao_parte[]` (tipo `cessao`) | eventos ocorridos (ver P2) | H |
| AH | Alteração de parte · Alteração de Controle | idem (tipo `mudanca_controle`) | idem | H |

**Separação de prazos que a planilha mistura.** A coluna S ("Prazo do aviso prévio") cobre dois prazos diferentes: o aviso para **não renovar** e o aviso para **rescindir sem justa causa**. Às vezes são o mesmo prazo, muitas vezes não. A ficha guarda os dois (`vigencia.renovacao.aviso_nao_renovacao` e `rescisao.imotivada.aviso_previo_*`). A data limite usa o primeiro quando a renovação é automática.

### Campos além da planilha (e por quê)

| Campo | Motivo |
|---|---|
| `identificacao.papel_avenia` (contratante/contratada) | Metade das regras depende de quem paga: "sem reajuste" é risco quando a Avenia recebe, não quando paga. |
| `identificacao.entidade_avenia` | O grupo tem várias entidades (IP/SPSAV, LLC, holdings). Isso define a cessão para afiliadas e as obrigações regulatórias. |
| `identificacao.natureza_documento`, `anexos_referenciados` | Um aditivo altera uma ficha existente. Um anexo ausente (ex.: DPA "disponível em URL") significa termos que ninguém analisou. |
| `vigencia.data_inicio`, `renovacao.periodo/limite/forma_notificacao` | Sem esses dados não dá para rolar a renovação nem calcular a data de envio da notificação. |
| `pagamento.reajuste` (separado da correção monetária) | Reajuste anual de preço é diferente de atualizar um valor em atraso; a planilha junta os dois. |
| `pagamento.moeda_conversao` | Contratos em USD/USDC/EUR: sem regra de conversão, cada fatura vira discussão. |
| `responsabilidade.limitacao`, `indenizacao_terceiros` | Pedido explícito da missão (regra "sem limitação de responsabilidade"); já existia em `contractTerms.ts`. |
| `regulatorio.*` (PLD/FT, anticorrupção, confidencialidade com exceção para reguladores, acesso do BCB/plano de saída, suspensão de serviço, exclusividade, segregação de ativos) | Específico de uma fintech regulada. É o eixo "carve-outs BCB/COAF/PLD" do playbook do Jurídico. |
| `dados_pessoais.dpa / transferencia_internacional / prazo_notificacao_incidente / sigilo_financeiro` | A planilha só pergunta "compartilha? qual agente?". O risco real está nesses quatro pontos. |
| `foro.*` | Lei estrangeira muda quem revisa e o custo de uma disputa. |
| `gestao.dono_email`, `antecedencia_alerta_dias`, `validacao` | Quem recebe o alerta, com quanta antecedência e se a ficha já foi revisada. |

## 4. Normalização (código, depois da extração)

| Tipo | Regra |
|---|---|
| **Datas** | Sempre `YYYY-MM-DD`. "1º de fevereiro de 2026", "01/02/2026" e "01.02.26" → `2026-02-01`. Formato brasileiro (dia/mês) por padrão; em contrato em inglês com lei dos EUA, mês/dia **só** se o dia for > 12 ou se o texto deixar claro; senão o campo fica `ambiguo`. Assinatura eletrônica: vale a data da **última** assinatura (lida do certificado/rodapé quando houver). |
| **Durações** | O modelo devolve `{amount, unit, day_count}` exatamente como escrito ("30 (trinta) dias úteis" → `30, dias, uteis`). Extenso × numeral divergentes ("30 (quarenta)") → `ambiguo`. Sem a palavra "úteis/corridos": `nao_especificado`, calculado como **corridos** e sinalizado (DOC-05). Por que corridos: o Código Civil (art. 132) conta prazos em dias corridos quando o contrato não diz o contrário [CONFIRMAR com o Legal]. `days` só é preenchido quando dá para converter sem uma data de referência. |
| **Dinheiro** | `{amount: "1234.56", currency: "BRL"}`, com o decimal **como string** (nunca float). "R$ 1.234,56" → `1234.56`. "US$ 10k" → `10000.00 USD`. Cripto pelo ticker (USDC, USDT, BRLA). Valor por extenso divergente do numeral → `ambiguo`. |
| **Percentuais e bps** | Em pontos percentuais (2% → `2`); bps em campo próprio. "1% ao mês" → `percentual 1, periodo mes`. |
| **Índices** | Enum fechado. "IGPM", "IGP-M/FGV" → `IGP-M`. "IPCA/IBGE" → `IPCA`. Índice substituto ("na falta deste, o IPCA") → `indice_substituto`. Índice não listado → `outro`, com o nome em `notes`. |
| **Documentos** | CNPJ/CPF só com dígitos; o código valida os dígitos verificadores; se forem inválidos, a confiança cai para `baixa`. |
| **Contraparte** | Razão social como está no preâmbulo; a ligação com o cadastro (planilha "Contratos — Registro", Pipedrive) fica para depois. |

## 5. Campos derivados (código, recalculados sempre)

```
inicio            = data_inicio ?? data_assinatura
vencimento_atual  = data_vencimento ?? (inicio + prazo.duracao)          # em meses: mesma data no mês, ajustada ao fim do mês
se renovacao = automatica e vencimento_atual < hoje:
    rolar vencimento_atual += renovacao.periodo até ≥ hoje (respeitando limite_renovacoes)
aviso             = renovacao.aviso_nao_renovacao  se renovacao = automatica
                    senão rescisao.imotivada.aviso_previo_avenia
data_limite_aviso_calendario = vencimento_atual − aviso                  # dias úteis: retrocede só em dias úteis
data_limite_aviso_efetiva    = último dia útil ≤ calendario             # feriados nacionais + carnaval (bancos fechados)
data_envio_recomendada       = efetiva − folga(forma_notificacao)        # email 0 · carta AR 5 úteis · cartório 10 úteis
data_alerta                  = envio − (gestao.antecedencia_alerta_dias ?? 90)
dias_para_vencimento         = vencimento_atual − hoje                   # coluna O, calculada na leitura
dias_ate_limite_aviso        = data_limite_aviso_efetiva − hoje          # usado por REN-02
ativo                        = vencimento_atual ≥ hoje (ou prazo indeterminado) e status ≠ rescindido
proximo_reajuste             = próximo aniversário da data-base, se houver reajuste
```

Cada passo é registrado em `derivados.memoria_calculo` em linguagem legível. Exemplo: "Vencimento 2027-03-01 = assinatura 2026-03-01 + 12 meses; aviso de 30 dias corridos → 2027-01-30 (sábado) → recuado para 2027-01-29 (sexta)". O Legal confere a conta sem abrir código. Isso segue o renewal-tracker do commercial-legal: o alerta parte da data de **envio** efetiva, não da data do calendário.

**Próxima ação** (`derivados.proxima_acao`) é a mais urgente entre:
`tratar_risco` (achado crítico aberto) → `validar_ficha` (ficha não validada e com data em menos de 120 dias) → `enviar_aviso` / `decidir_renovacao` → `reajuste` → próxima `obrigacao` com data.
**Dono**: `gestao.dono_email` → assignee do card → (padrão por área, a definir com o Legal).

**Risco geral** (`derivados.risco_geral`): o pior entre os achados abertos (`critica` → `critico`; `alta`/`media` → `atencao`; senão `ok`). Usa o vocabulário que `projects.risk_level` já tem hoje. Ele **sugere** o valor do card. Se alguém marcou o risco à mão, prevalece o manual.

## 6. Regras de risco (resumo de `risk-rules.v1.yaml`)

41 regras em 9 grupos. Severidades: **crítica 5 · alta 15 · média 14 · baixa 2 · info 5**. 39 rodam por código; 2 usam IA (RSP-02, REG-08).

| Grupo | Regras-chave | Severidade |
|---|---|---|
| Renovação | REN-01 renovação automática com aviso < 60 dias · REN-02 janela de aviso fechando em < 30 dias (reavaliada diariamente) · REN-03 prazo indeterminado sem saída para a Avenia · REN-04 renovação ilimitada com reajuste sem teto | alta · **crítica** · alta · média |
| Rescisão | RES-01 só a contraparte rescinde (crítica se parceiro crítico) · RES-02 multa rescisória da Avenia > 20% / 3 meses / sobre o valor total · RES-03 parceiro crítico encerra com aviso < 90 dias | alta · alta · **crítica** |
| Mudança de controle e cessão | ALT-01 mudança de controle da Avenia exige anuência ou dá direito de rescisão (crítica se parceiro crítico; relevante para captação e M&A) · ALT-02 sem definição de "controle" · ALT-03 cessão vedada até para afiliadas · ALT-04 contraparte cede livremente | alta · média · média · média |
| Pagamento | PAG-01 contrato longo sem reajuste (Avenia recebe) · PAG-02 sem correção monetária no atraso · PAG-03 juros/multa de mora acima de 1% a.m./2% · PAG-04 moeda estrangeira/cripto sem regra de conversão · PAG-05 gross-up · PAG-06 contraparte altera preço/termos sozinha | média · baixa · média · média · média · alta |
| Responsabilidade | RSP-01 responsabilidade da Avenia sem limite · RSP-02 exceções que esvaziam o limite (IA) · RSP-03 parceiro crítico com limite < 12 meses · RSP-04 multa sem teto | alta · média · alta · média |
| LGPD | LGP-01 compartilhamento sem papel definido · LGP-02 DPA só por referência · LGP-03 transferência internacional sem mecanismo · LGP-04 aviso de incidente > 48h ou ausente · LGP-05 sigilo financeiro sem confidencialidade | alta · média · alta · média · alta |
| Regulatório | REG-01 confidencialidade sem exceção para BCB/COAF/ordem judicial · **REG-02 exige avisar a contraparte antes de informar autoridade (conflita com o dever de não revelar comunicação ao COAF)** · REG-03 parceiro crítico suspende sem aviso · REG-04 terceirização relevante sem acesso do BCB/plano de saída · REG-05 cripto sem segregação de ativos de clientes · REG-06 parceiro que movimenta recursos sem PLD/FT · REG-07 sem anticorrupção · REG-08 exclusividade que obriga a Avenia (IA) | alta · **crítica** · **crítica** · alta · **crítica** · alta · baixa · alta |
| Foro | FOR-01 lei ou foro estrangeiro | média |
| Qualidade do dado | DOC-01 anexo ausente · DOC-02 campo núcleo faltando/baixa confiança · DOC-03 cláusulas conflitantes · DOC-04 citação não localizada · DOC-05 dias sem "úteis/corridos" · DOC-06 OCR | info (DOC-03 média) |

**Parceiro crítico** é um parâmetro (`tipos_criticos`: parceiro bancário/BaaS, arranjo PSP/adquirência, liquidez OTC/câmbio, custódia cripto). Vários riscos sobem de severidade quando a contraparte é desse tipo, porque a Avenia para de operar sem ela.

**Efeito no fluxo**: um achado `crítico` aberto impede que o card vá para "Pronto para assinar" sem uma decisão registrada da head de Legal (`risco_aceito` com justificativa ou `mitigado`). Cada achado tem estado (`aberto`, `risco_aceito`, `mitigado`, `falso_positivo`) e quem decidiu. O `falso_positivo` alimenta a calibração das regras.

**Referências normativas** marcadas `[CONFIRMAR]` no YAML (Lei 9.613 art. 11, Res. BCB 85/2021, Res. CD/ANPD 15/2024, art. 406 do CC/Lei 14.905, Lei 14.478) só aparecem para o usuário depois que o Legal confirmar. Regra herdada do Ada Legal: nunca citar dispositivo inventado.

## 7. Arquitetura dos agentes de análise

```
 upload/novo aditivo
        │
 [0] Preparação (código) ── escolhe documento principal + anexos + aditivos, texto com [Página n]
        │                    (PDF: pdfjs · DOCX: mammoth · flag OCR) — SEM corte de meio
 [1] Extrator (LLM) ──────── 1 chamada, saída estruturada (tool use / JSON schema "visão de extração")
        │
 [2] Normalizador (código) ─ datas, dinheiro, durações, enums, CNPJ; inválido → ambiguo/baixa
        │
 [3] Verificador ─────────── (a) código: acha cada citação no texto (exato → normalizado → aproximado ≥ 0,9)
        │                        e corrige página/posição
        │                    (b) código: valor aparece na citação? (o "30" de 30 dias, a data, o %)
        │                    (c) LLM barato, só p/ campos núcleo que falharam em (b) ou com confiança baixa:
        │                        "este trecho sustenta este valor? sim / parcial / não"
        │                    → rebaixa confiança, marca DOC-04; nunca altera o valor
 [4] Derivados (código) ──── datas, próxima ação, risco geral, memória de cálculo
        │
 [5] Avaliador de risco ──── motor YAML (39 regras, código) + 2 perguntas à IA com só as cláusulas citadas
        │                    → achados com citação; risco geral → sugestão para projects.risk_level
 [6] Alertas de prazo ────── job diário: recalcula derivados, reavalia REN-02, sincroniza obligations
                             (origin='ficha'), notifica dono (e-mail/Slack/Google Calendar já existentes)
        │
 [7] Validação humana (UI) ─ Legal confirma/corrige campo a campo, clicando na citação para ver o trecho
                             destacado no visualizador → reexecuta [4]–[6]
```

Decisões de arquitetura:

- **Uma chamada de extração, não uma por campo.** Uma chamada por campo custaria cerca de 60 vezes mais e perderia o contexto entre cláusulas (aditivo que altera cláusula). A precisão vem do verificador e da validação humana, não de chamadas fatiadas. Se o golden set mostrar que um grupo erra muito (ex.: regulatório), esse grupo ganha uma segunda passada própria.
- **Texto inteiro, sem cortar o meio.** O código atual manda só o começo (14 mil caracteres) e o fim (12 mil). Cessão, mudança de controle, LGPD e confidencialidade costumam estar **no meio**. Um contrato de 60 páginas cabe no contexto dos modelos atuais. Acima do limite, dividir por cláusula e juntar.
- **Modelo fixo da organização**, não o `tabular_model` de cada usuário: sem isso as métricas não são comparáveis. `prompt_version` e `modelo` ficam gravados em toda ficha.
- **Aditivos**: com `natureza_documento = aditivo`, a extração roda com a ficha atual como contexto e só altera os campos que o aditivo muda, com a citação do aditivo. O histórico fica nas citações (`document_version_id`).
- **Reextração respeita o humano**: campo `origin=humano` ou `review.state ∈ {confirmado, corrigido}` não é sobrescrito. Se a IA chegar a um valor diferente, ele vai para `ai_value` e o campo ganha a nota "a IA leu diferente na nova versão".
- **Hermes/Slack (futuro)**: a ficha validada é a fonte para responder "quando vence o contrato com X?" sem reler PDF. As respostas citam o mesmo trecho.

## 8. Como medir a qualidade

**Golden set v0, com ~10 contratos reais anotados pelo Legal:**

| # | Tipo | Por quê |
|---|---|---|
| 2 | parceiro bancário/BaaS ou arranjo PSP | regras críticas (RES-03, REG-03, ALT-01) |
| 1 | liquidez OTC / câmbio, ou custódia cripto | REG-05, PAG-04 (moeda/cripto) |
| 2 | prestação de serviços / SaaS (Avenia contrata) | LGPD como operador, limitação de responsabilidade |
| 1 | cliente de API/plataforma (Avenia contratada) | papel invertido, reajuste |
| 1 | NDA | muitos campos `nao_aplicavel` (testa alucinação) |
| 1 | aditivo de um dos anteriores | fluxo de aditivo, `ambiguo` |
| 1 | contrato em inglês, lei estrangeira | datas US, FOR-01 |
| 1 | PDF escaneado | OCR, DOC-06 |

Anotação: o Legal preenche a ficha na própria tela de validação, com as citações. Isso gera o gabarito e testa a UX ao mesmo tempo. Três contratos são anotados por duas pessoas, para medir a concordância entre elas: se dois humanos discordam num campo, o campo está mal definido, não a IA errada. Os contratos ficam no storage; no repositório ficam só as anotações, por id.

**Métricas por campo** (script `eval:ficha`, roda a cada mudança de prompt ou modelo):

| Métrica | Definição | Meta v1 (campos núcleo) |
|---|---|---|
| Detecção | precisão/recall de "tem valor" × "não encontrado" | ≥ 95% / ≥ 90% |
| Exatidão | valor igual ao gabarito após normalização (enum/bool/data/duração/dinheiro exatos; texto livre por juiz-LLM + amostragem humana) | ≥ 90% |
| **Alucinação** | valor preenchido onde o gabarito é `nao_encontrado`/`nao_aplicavel` | **0** em datas, avisos e valores |
| Citação verificada | `match ≠ nao_encontrado` | ≥ 98% |
| Citação correta | citação sobrepõe o trecho do gabarito | ≥ 90% |
| Calibração | acerto quando `confidence = alta` | ≥ 95% |
| Data limite de aviso | `data_limite_aviso_efetiva` exata | 100% quando as entradas estão certas (teste unitário com casos de fim de semana, feriado, dias úteis e fim de mês) |
| Regras | precisão/recall dos achados × achados esperados pelo Legal | precisão ≥ 80%, recall ≥ 90% em crítica/alta |

**Em produção**: a taxa de correção humana por campo (`ai_value` × valor final) é o termômetro contínuo. Um campo com mais de 15% de correção entra na fila de ajuste de prompt. Achados marcados `falso_positivo` recalibram os parâmetros das regras.

## 9. Delta em relação ao `contractTerms.ts` atual

**O que existe hoje** (`backend/src/lib/contractTerms.ts`, 276 linhas; tabela `contract_terms`): 10 campos planos (`auto_renewal`, `term_end`, `notice_days`, `notice_deadline`, `penalty_value`, `penalty_recurrence`, `liability_cap`, `unilateral_amendment`, `amendment_notes`, `price_regulatory_impact`), mais `contract_type` gravado em `projects`, `sources` como mapa campo → trecho, e 2 obrigações `origin='renewal'`.

**Problemas que a v1 resolve:**

| # | Hoje | Consequência | v1 |
|---|---|---|---|
| 1 | Manda só o começo (14 mil caracteres) e o fim (12 mil) do texto | Cessão, mudança de controle e LGPD (meio do contrato) somem | Texto inteiro com marcação de página |
| 2 | `contractText` ordena as versões de **todos** os documentos do card por `version_number` e pega uma | Com contrato + anexo + aditivo, analisa um documento qualquer | Documento principal explícito; anexos e aditivos tratados como tais |
| 3 | `null` significa ao mesmo tempo "não consta" e "não extraído" | Impossível distinguir lacuna de omissão; não dá para medir | Envelope com `status` |
| 4 | `sources` é só um trecho, sem página/cláusula e sem verificação | Citação inventada passa | Citações com página/cláusula, verificadas por código |
| 5 | `term_end` vem pronto do modelo | O modelo faz a conta (e erra); não rola renovações | Modelo extrai o literal; código calcula `vencimento_atual` |
| 6 | `notice_days` único, sem úteis/corridos | Mistura aviso de renovação com aviso de rescisão; erra a data quando os dias são úteis | Duas durações com `day_count`; recuo para dia útil |
| 7 | `penalty_value`, `liability_cap` como texto | Nenhuma regra numérica possível | Estruturados (%, meses, dinheiro) |
| 8 | Reextração faz upsert de tudo | Apagaria correções humanas (se existissem) | Merge que preserva `origin=humano` / confirmados |
| 9 | Risco só pelo dossiê (narrativo) | Não reprodutível | Motor de regras determinístico + achados com estado |
| 10 | Antecedência do alerta global (`RENEWAL_ALERT_LEAD_DAYS`) | Igual para NDA e parceiro bancário | Por contrato (`gestao.antecedencia_alerta_dias`), padrão 90 |
| 11 | Modelo = `tabular_model` de quem clicou | Resultados mudam com o usuário | Modelo fixo da org + `prompt_version` |

**Mudanças no código (proposta de PR, por fases):**

1. **Migration** `YYYYMMDD_9x_contract_fichas.sql` (slot `_9x` reservado ao fork; ver `docs/upstream-sync.md`):
   ```sql
   create table public.contract_fichas (
     project_id uuid primary key references public.projects(id) on delete cascade,
     schema_version text not null default '1.0',
     ficha jsonb not null,
     document_version_id uuid,
     validation_state text not null default 'rascunho_ia',   -- rascunho_ia | em_validacao | validado
     -- desnormalizados p/ radar, Notion e filtros (fonte = ficha.derivados)
     term_end date, notice_deadline date, send_by date, next_action_date date, risk_overall text,
     extracted_at timestamptz, validated_by text, validated_at timestamptz,
     created_at timestamptz not null default now(), updated_at timestamptz not null default now()
   );
   create table public.contract_findings (
     id uuid primary key default gen_random_uuid(),
     project_id uuid not null references public.projects(id) on delete cascade,
     rule_id text not null, rules_version text not null, severity text not null,
     state text not null default 'aberto', payload jsonb not null,
     decided_by text, decided_at timestamptz, decision_note text,
     created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
     unique (project_id, rule_id)
   );
   create table public.contract_field_reviews (          -- trilha de auditoria + dado de avaliação
     id uuid primary key default gen_random_uuid(),
     project_id uuid not null references public.projects(id) on delete cascade,
     path text not null, action text not null,           -- confirmado | corrigido
     ai_value jsonb, final_value jsonb, reviewer text not null, comment text,
     created_at timestamptz not null default now()
   );
   update public.obligations set origin = 'ficha' where origin = 'renewal';
   ```
   `contract_terms` fica só de leitura por uma versão, para compatibilidade, e é removida depois. Não precisa migrar dados: reextrair tudo é barato e já gera a ficha nova.
2. **`lib/contractTerms.ts` → `lib/ficha/`**: `text.ts` (documento principal + texto inteiro + DOCX), `extract.ts` (prompt v1 + visão de extração), `normalize.ts`, `verify.ts`, `derive.ts` + `holidaysBR.ts`, `rules.ts` (carrega o YAML e avalia), `alerts.ts` (sincroniza obrigações), `merge.ts` (reextração que preserva humano), `schema.ts` (validação em runtime com `zod`, que já é dependência). Dependência nova: `yaml` (parser). `extractMissingContractTerms` vira `extractMissingFichas`, com a mesma rota em `integrations.ts`.
3. **Rotas** (`routes/terms.ts` → `routes/ficha.ts`): `GET /projects/:id/ficha`, `POST /ficha/extract`, `PATCH /ficha/fields` (confirmar/corrigir um caminho), `POST /ficha/validate`, `GET/PATCH /ficha/findings/:ruleId`. `GET /terms` continua por uma versão como adaptador (mapeia ficha → shape antigo) para não quebrar `mikeApi.ts`.
4. **`notion.ts`**: `renewal_date` passa a ler `contract_fichas.notice_deadline` (a data efetiva). Opcional: adicionar as propriedades "Próxima ação" e "Dono".
5. **Frontend**: aba "Ficha" no card (seções colapsáveis; cada campo com valor, selo de status/confiança, citação clicável que destaca o trecho no visualizador já existente em `/review`, botões confirmar/corrigir). No board, o card mostra risco e próxima ação. Esta parte é com o agente de UX.
6. **Dossiê**: o prompt recebe a ficha validada e os achados; para de reextrair prazos e multas.
7. **Testes** (vitest): `derive.test.ts` (calendário), `verify.test.ts` (fuzzy match), `rules.test.ts` (uma ficha mínima por regra, disparando e não disparando), validação das fichas de exemplo contra `contract-schema.v1.json`.

**Fases sugeridas** (valor em semanas):

| Semana | Entrega | Legal consegue testar |
|---|---|---|
| 1 | Migration + extrator + normalizador + verificador + derivados; aba Ficha só leitura com citações | Ver a ficha de contratos reais e apontar erros |
| 2 | Validação campo a campo + alertas a partir da ficha (substitui `origin=renewal`) | Validar fichas; receber alertas de prazo |
| 3 | Motor de regras + achados no card e no dossiê + bloqueio de "Pronto para assinar" com crítico aberto | Ver riscos e registrar decisões |
| em paralelo | Golden set anotado pelo Legal + `eval:ficha` | Métricas por campo antes de escalar |

## 10. Pendências (decisões do Legal antes do código)

| # | Pergunta | Proposta padrão |
|---|---|---|
| P1 | Nas colunas V e Z, "Sim/Não" quer dizer "o contrato **permite**" ou "o contrato **trata do tema**"? | "permite" (regime ≠ vedada); a ficha guarda o regime completo, então qualquer leitura sai dela |
| P2 | "Alteração de parte" (AG/AH): é o registro de cessões/mudanças de controle **já ocorridas** ou outra coisa? | registro de eventos, preenchido por humano |
| P3 | Coluna S: o aviso que importa é o de rescisão ou o de não renovação? | a ficha guarda os dois; a planilha exportada mostra o de rescisão em S e o de não renovação junto de Q |
| P4 | Parâmetros: aviso mínimo 60 d, janela urgente 30 d, multa rescisória 20% / 3 meses, limite de responsabilidade de 12 meses, incidente em 48 h, juros 1% a.m. e multa 2% | usar estes e calibrar com o golden set |
| P5 | Lista de "parceiros críticos" | BaaS, PSP/adquirência, liquidez OTC, custódia cripto |
| P6 | Quem pode marcar `risco_aceito` em achado crítico? | só a head de Legal |
| P7 | Dono padrão por área (quando o card não tem assignee) | head da área; lista a definir |
| P8 | Confirmar os dispositivos legais marcados `[CONFIRMAR]` no YAML | — |
| P9 | Escolher os 10 contratos do golden set e quem anota (2 pessoas em 3 contratos) | — |
| P10 | Lista canônica das entidades Avenia (já existe no Ada Legal, `fillmap`) | reaproveitar |

## 11. Relação com o upstream

O upstream do Mike ganhou **playbooks** (`backend/src/modules/playbooks`: regras com posição padrão, alternativas aceitáveis, posições inaceitáveis e ações de escalonamento, aplicadas ao texto pela IA). Isso é complementar à ficha: o playbook avalia **redação** contra uma posição; as regras daqui avaliam **dados estruturados**, de forma determinística. Quando o fork alinhar com o upstream, o playbook do Jurídico (hoje texto livre no Ada Legal, com a "Parte D — Limiar de Escalonamento") deve virar um playbook do upstream. As regras REG-* e ALT-* ficam aqui, porque precisam dos campos da ficha e do tipo de parceiro.
