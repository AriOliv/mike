# 03 · UX spec do Mike para o Legal

> Autor: Prism (squad de produto do Mike) · 2026-10-20 · status: proposta para validar com o Legal
> Protótipo navegável: [`prototype/index.html`](prototype/index.html). Abre direto no navegador, sem build.
> Insumos: fork `mike-fork` (Pipeline, Radar, Acervo, Dossiê, Tabular Review), wireframe do Ada Legal
> (`avn-clm/Wireframes Legal AI (offline).html`), `docs/notion-cards-tasks-sync.md`, e a pesquisa do
> Sonar (documento interno, fora deste repositório). Os padrões do Sonar aparecem
> marcados como **[Sonar n]**.

## Resumo em uma frase

A **esteira** continua sendo o centro: todo pedido vira um **card** na Entrada e anda pelas 6
etapas até Arquivado, quando passa a ser **contrato vigente**, com a ficha da planilha do Legal
preenchida e cada valor ligado ao trecho do documento. Por cima disso, o Mike abre no que precisa
da sua atenção hoje, e quem é de outra área pede pelo Slack sem aprender a ferramenta.

## 0. O que muda em relação à esteira atual

Não há fluxo novo. A espinha é a mesma do fork e do avn-clm:
`PIPELINE_LANES = entrada → triagem → revisão → negociação → assinatura → arquivado`, mais o eixo
de task independente (Progresso: A fazer / Em andamento / Bloqueado / Concluído; Responsável;
Prioridade; Prazo) espelhado no board **"Pipeline · Mike"** do Notion.

| # | Hoje (fork) | Proposta | Esforço |
|---|---|---|---|
| 1 | Menu com 8 itens em inglês; **Pipeline** é um entre eles e a home é o Assistant | Menu em PT com 5 itens. **Esteira** é o 2º item e a **Início** mostra a mini-esteira (contagem por etapa) | baixo (só front) |
| 2 | Kanban é a única visão da esteira | Duas visões do **mesmo dado**: *Esteira* (kanban das 6 etapas, como hoje) e *Inbox* = recorte **Entrada + Triagem** em lista, com SLA, solicitante e canal | baixo |
| 3 | Clicar no card abre `/projects/:id/review` (dossiê); a ficha (`ContractTermsCard`) e os prazos ficam em outras telas | Clicar no card abre a **Página do card**, que é a mesma em qualquer etapa: cabeçalho com o stepper das 6 etapas + Progresso/Responsável/Prioridade/Prazo editáveis. O corpo muda conforme a etapa: **Entrada/Triagem** mostra o pedido, a thread do Slack e a triagem da IA. **Revisão em diante** mostra o documento + Ficha/Riscos/Prazos/Atividade | médio |
| 4 | Card não tem SLA nem canal de origem | Card ganha **SLA** (por tipo, pausa em Bloqueado) e **canal** (Slack #doc-agent / formulário / e-mail). O `requester_name` que já existe vira o solicitante visível | baixo (2 colunas) |
| 5 | "Arquivado" é o fim | **Arquivado = contrato vigente.** Esses cards saem do kanban (só um atalho "+N vigentes") e vivem em **Contratos** (portfólio). Renovação/renegociação abre um **card novo na Entrada ligado ao contrato** | baixo |
| 6 | Termos comerciais (`ContractTerms`, ~10 campos) | **Ficha** com o schema da planilha do Legal (~24 campos), cada campo com cláusula de origem e estado **A conferir / Verificado / Sinalizado** | médio (extração) |
| 7 | Radar ordena por data da obrigação | Prazos ordenados pela **data limite do aviso** (`notice_deadline`, que o fork já calcula), com ações Renovar / Não renovar / Renegociar / Adiar | baixo |
| 8 | Acervo é página separada | **Perguntar** vira gaveta global (tecla `?`), com escopo e "ver como tabela / transformar em coluna" | médio |

O que **não** muda: as 6 etapas e seus nomes, o eixo Progresso separado da Etapa, o espelho no
Notion (os campos ↕ continuam editáveis nos dois lados), o sync do Slack #doc-agent para a Entrada,
o dossiê da IA (vira a aba Riscos), o calendário + Google Calendar do Radar.

## 1. O que existe hoje (inventário)

| Peça | Onde está | Vira o quê |
|---|---|---|
| Esteira (`PIPELINE_LANES`, `PipelineCard` com status/assignee/priority/deadline/contract_type) | fork + este repo `/pipeline` | **Esteira** (kanban) e **Inbox** (Entrada + Triagem) |
| Espelho Notion "Pipeline · Mike" | `backend/src/lib/notion.ts`, `docs/notion-cards-tasks-sync.md` | Igual. O link "espelhado no Notion ↗" aparece no card |
| Slack #doc-agent → card | avn-clm | Canal principal de entrada. A thread aparece espelhada no card |
| Radar (`Obligation`: recorrente/critico/tarefa) | fork `/radar` | **Prazos**, ordenado por data limite do aviso |
| Acervo (`askAcervo` → `sources[]`) | fork `/acervo` | **Perguntar** (gaveta) |
| Dossiê (`DossierPayload`) | fork `DossierView` | Aba **Riscos** do card |
| Termos (`ContractTerms` + `sources`) | fork `ContractTermsCard` | Semente da **Ficha** |
| Tabular Review (`TRTable`, citação por célula, `exportToExcel`) | fork/upstream | Motor do **Portfólio** |
| Workspaces, sharing, History | upstream (828 commits à frente) | Base de papéis e atividade no sync |
| Wireframe Ada Legal (1a Esteira, 1b Radar, 1c Copiloto; 2a–2f) | avn-clm | Referência visual. A Início = 1b + briefing do 1c + mini-esteira do 1a |

## 2. Personas e jobs

| Persona | Job ("quando… quero… para…") | Frequência | Onde vive |
|---|---|---|---|
| **Head de Legal** | Quando abro o dia, quero ver só o que exige decisão minha (renovações, riscos altos, cards sem dono, bloqueados), **para delegar e não perder prazo**. | diária, 5–10 min | Início → Esteira → Prazos |
| **Analista de Legal** | Quando pego um card, quero o contrato já lido, com a ficha preenchida e os riscos apontados, **para só conferir e corrigir**. | contínua | Início (meus cards) → Página do card |
| **Solicitante** (outra área) | Quando preciso de um contrato ou parecer, quero pedir **em 30 s onde já estou (Slack)** e saber em que pé está sem perguntar. | 1–4×/mês | Slack #doc-agent / formulário → "Meus pedidos" |
| **Founder / CFO** | Quando surge uma dúvida ("temos contrato com X? quando vence?"), quero **resposta citada em segundos**. | pontual | Perguntar (Slack ou gaveta) |

Regra para todos: **o Legal não digita o que a IA consegue extrair.** O trabalho humano é
conferir, corrigir e decidir, e cada conferência fica registrada com nome e data.

## 3. Arquitetura de informação

```
Início · Esteira · Contratos · Prazos            [Perguntar à base]  (tecla ?)
          ├ Esteira (6 etapas, kanban)
          └ Inbox (Entrada + Triagem, lista com SLA)
Página do card: /card/:id   (o mesmo objeto do card da esteira; no código, `projects`)
"Mais ▾": Library, Workflows, Tabular Review avulso, Configurações
```

| Item | Conteúdo |
|---|---|
| **Início** | "O que precisa de você hoje", adaptada ao papel (4.1) |
| **Esteira** | Kanban das 6 etapas + Inbox (Entrada + Triagem) |
| **Contratos** | Portfólio = cards em Arquivado = a planilha do Legal viva |
| **Prazos** | Lista "exige decisão" + calendário (o Radar atual) |
| **Perguntar** | Gaveta global, também no Slack (Hermes) |

O solicitante vê só **Início** e **Meus pedidos**. As 6 etapas aparecem para ele como 4 passos:
Recebido (Entrada/Triagem) → Em análise (Revisão/Negociação) → Assinatura → Concluído (Arquivado).

## 4. Fluxos e telas

### 4.1 Início, "o que precisa de você hoje"  [Sonar 1]
Head:
1. **Briefing** de duas frases escritas pela IA (o que mudou desde ontem).
2. **Contadores** (contratos vigentes, cards em andamento, SLA estourado, % campos verificados) e a
   **mini-esteira** (quantos cards em cada etapa; clique abre a Esteira).
3. **Exige você** (até 5): *decidir renovação* (com Renovar / Não renovar / Renegociar / Adiar),
   *atribuir card sem dono*, *card bloqueado*, *revisar risco alto*.
4. **Entrada e Triagem** com SLA. **Prazos de aviso** (90 dias, selo D-xx). **Carga do time**.

Analista: briefing, Exige você, **Meus cards** por SLA, **Campos para conferir**, meus prazos.
Solicitante: botão **Pedir ao Legal** + Meus pedidos com o stepper de 4 passos.
Founder/CFO: caixa Perguntar em destaque, perguntas prontas, vencimentos do trimestre, contratos por tipo.

### 4.2 Entrada: como o pedido chega  [Sonar 2, 3, 4]
1. **Slack #doc-agent** (o que o avn-clm já faz): o solicitante menciona **@Mike**. O card nasce na
   **Entrada**, e o bot pergunta **na própria thread** só o que falta (contraparte, tipo, prazo,
   anexo). Toda mudança de etapa ou de Progresso volta para a mesma thread.
2. **Formulário web de 30 s** (o mesmo modal no Slack e na web): o que precisa · contraparte ·
   contexto em texto livre · quando · anexo. Nenhum campo jurídico.
3. **E-mail** encaminhado para legal@ vira card (fase 2).
4. Dúvida recorrente ("qual NDA eu uso?") é respondida pela política sem virar card (fase 2).

**SLA** por tipo (a validar com a Head): NDA 1 dia útil · fornecedor 3 · cliente 5 · parecer 2.
Pausa quando o Progresso é **Bloqueado** (ex.: "Aguardando o solicitante").

### 4.3 Inbox (Entrada + Triagem)
Lista: card · solicitante/área · canal · etapa · **SLA restante** · responsável · progresso ·
[Assumir]. Filtros: abertos · sem responsável · meus · SLA estourando.
**Assumir** põe a pessoa como Responsável, move de Entrada para Triagem e passa o Progresso para
Em andamento. **Mandar para Revisão →** é o passo seguinte.

### 4.4 Página do card (mesma URL em todas as etapas)
Cabeçalho fixo: **stepper das 6 etapas** (clicável para quem edita) + barra **Progresso ·
Responsável · Prioridade · Prazo** (os campos ↕ do Notion) + "espelhado no Notion ↗".

**Entrada / Triagem** (pedido):
- Esquerda: o texto do pedido, a **thread do Slack espelhada**, os documentos.
- Direita, aba Triagem: **triagem da IA** (tipo, risco preliminar, playbook, recomendação), SLA, e
  as ações Assumir · Pedir informação ao solicitante · Mandar para Revisão · **Aprovar NDA padrão**
  (quando não há desvio). Aba Atividade.
- Se o card é sobre um contrato que já existe (aditivo, renovação, parecer), ele aparece ligado.

**Revisão → Arquivado** (documento):
```
┌ stepper 6 etapas ─────────────────────────────────────────────────────────────────────┐
│ Progresso ▾ · Responsável ▾ · Prioridade ▾ · Prazo                                   │
├ DOCUMENTO (58%) ────────────────────┬ [Ficha] [Riscos] [Prazos] [Atividade] (42%) ────┤
│ cláusulas numeradas; o trecho do    │ 14 de 24 campos verificados ▓▓▓▓░░ [Verificar…]│
│ campo selecionado fica destacado    │ Vigência ▸ Vencimento 10/01/2027  ✓ Duda · 16/10│
│                                     │ Alt. controle ▸ Penalidade  ● IA · a conferir · cl. 7.1 │
└─────────────────────────────────────┴────────────────────────────────────────────────┘
```
- **Ficha** = schema da planilha do Legal, agrupado (Identificação · Vigência · Pagamento ·
  Rescisão · Cessão · Alteração de controle · Dados · Obrigações).  [Sonar 5]
- Cada campo tem estado e autoria: **● IA · a conferir · cl. X** → **✓ verificado · quem · quando**
  → **✎ editado · quem** (valor anterior no histórico) ou **⚑ sinalizado** (algo errado, pede outra
  pessoa). Clicar no campo destaca o trecho no documento. **Sem citação, o campo fica vazio.**
  **Reprocessar o contrato nunca sobrescreve um campo verificado.**
- Ações por campo: Verificar (1 clique) · Sinalizar · Editar. Em lote: "Verificar os X a conferir".
- **Mapeamento para o `contract-schema.v1.json`** (envelope `campo`):

  | Na tela | `review.state` | Observação |
  |---|---|---|
  | ● IA · a conferir | `pendente` | com `confidence` baixa, o selo fica âmbar |
  | ✓ verificado · quem · quando | `confirmado` (+ `by`, `at`) | |
  | ✎ editado · quem | `corrigido` (+ `ai_value` preservado) | o valor da IA aparece no histórico |
  | ⚑ sinalizado | **não existe no schema** | proposta: adicionar `sinalizado` ao enum de `review.state`, com `comment` obrigatório |

  O `status` da extração também aparece: `nao_encontrado` mostra "o contrato não trata disso"
  (nunca um campo vazio mudo), `ambiguo` mostra as duas citações e a nota, `inferido` mostra a
  justificativa no lugar da cláusula, e `nao_aplicavel` esconde o campo naquele tipo de contrato.
  O selo de citação usa `citations[].match` do Verificador: `nao_encontrado` vira alerta vermelho no campo.
- **Riscos** = o dossiê atual (crítico / atenção / favorável), com cláusula, sugestão de redação e
  "ver no documento". Fase 2: semáforo contra o playbook, com aceitar = tracked change.  [Sonar 6]
- **Prazos** do contrato com dono e alertas. **Atividade**: linha do tempo (criado, etapa mudou,
  campo verificado) + **comentários com @menção** (notifica no Slack e por e-mail).

### 4.5 Esteira (kanban)
As 6 colunas de hoje, com o card mostrando: título · solicitante · canal · Progresso · Prioridade ·
Responsável · SLA. Arrastar muda a etapa, registra na atividade, espelha no Notion e avisa o
solicitante na thread. Arquivado mostra só os recém-arquivados e o atalho "+N contratos vigentes".

### 4.6 Contratos (portfólio = a planilha do Legal viva)  [Sonar 7, 8]
- Linha = contrato vigente (card em Arquivado). Colunas = schema da planilha, com cabeçalho em dois
  níveis (grupo › campo), primeira coluna fixa e a coluna **D-** (dias até o aviso) colorida.
- **Visões salvas**: Todos · Vencendo em 90 dias · Mudança de controle · Compartilham dados · Não
  verificados · Minhas.
- **Filtrar ou perguntar**: o texto vira **chips de filtro visíveis e editáveis**, para conferir se
  a IA entendeu.
- **+ Coluna**: uma pergunta ("qual é o foro?", "tem cap de responsabilidade?") vira coluna
  respondida em todos os contratos, com as células "a conferir".
- Edição inline (duplo clique). Célula não verificada tem sublinhado pontilhado roxo.
- **Exportar .xlsx** no layout da planilha original.
- Implementação: o motor do **Tabular Review** com o preset de colunas da planilha.
- Primeira carga em **amostra**: extrair ~10 contratos, o Legal ajusta as definições dos campos e
  só então roda o lote.

### 4.7 Prazos e alertas  [Sonar 9]
- A data que importa é a **data limite do aviso** (vencimento − aviso prévio).
- Alertas ao **responsável do card**: D-90 e D-60 por e-mail, D-30 e D-7 por e-mail + Slack DM.
  Resumo semanal para a Head às segundas, 9h. Os dias são configuráveis.
- O alerta traz contraparte, valor, tipo de renovação e um resumo de 5 linhas, com os botões
  **Renovar · Não renovar · Renegociar · Adiar 7d**. *Renegociar* abre um card na Entrada ligado ao
  contrato. *Não renovar* gera a minuta da notificação. Tudo fica na atividade.
- É onde os concorrentes são fracos (Sonar): é a nossa cunha.

### 4.8 Perguntar (chat com a base)  [Sonar 10]
- Gaveta lateral (tecla `?`) e, depois, no Slack (Hermes). **Chips de escopo** antes de perguntar:
  Todos · Visão atual · Cliente · Fornecedor.
- Toda resposta traz **contrato · cláusula · trecho exato**, que abre o card com o trecho destacado.
  Sem citação, não é resposta.
- Resposta em lista: **Ver como tabela** (Portfólio filtrado) · **Transformar em coluna** ·
  **Exportar** · Criar alerta disso.

### 4.9 Ações do agente: "vou fazer X, ok?"  [Sonar 11]
Toda ação que sai do Mike (postar no Slack, mandar e-mail, gerar minuta para a contraparte, escrever
no Drive) mostra antes um cartão com a lista do que vai acontecer e os botões **Pode fazer /
Cancelar**, com a opção "não perguntar de novo para este tipo" (ex.: NDA padrão sem desvio). Tudo
entra na atividade do card.

## 5. Colaboração multi-usuário

| Papel | Quem | Vê | Faz |
|---|---|---|---|
| **Admin Legal** | Head | tudo, inclusive confidenciais | tudo + SLA, playbook, papéis |
| **Legal** | analistas | cards e contratos não confidenciais + os compartilhados | mover etapa, editar task e ficha, verificar, comentar, atribuir |
| **Leitor** | Founders, CFO, Compliance | Contratos e Prazos (sem confidenciais), Perguntar | comentar e perguntar |
| **Solicitante** | qualquer @avenia.io (SSO) | só os próprios pedidos | pedir, responder, comentar no próprio card |

- **Confidencial** por card: só o Admin e as pessoas nomeadas, inclusive nas respostas do Perguntar.
  **A permissão vale no backend (busca e chat), não só na tela.**
- **Compartilhar** por card: pessoa + pode ver / comentar / editar.
- **Quem verificou cada campo**: estado por campo + trilha imutável (quem, quando, antes → depois,
  origem IA/humano).
- **Responsável** é o mesmo campo ↕ do Notion. Card sem responsável aparece na Início da Head.
- Papéis e workspaces existem no **upstream**. Recomendação: no MVP, um papel simples por usuário;
  migrar para os workspaces do upstream no sync, sem bloquear o MVP por isso.

## 6. MVP de 2 semanas vs. depois

Critério: o Legal **abre todo dia** e **para de atualizar a planilha à mão**.

### Semana 1: o card certo e a planilha viva
1. Menu em PT (Início · Esteira · Contratos · Prazos) e "Mais" para o resto.
2. **Página do card** única com o stepper + barra de task (os campos já existem desde a Fase 1 do
   sync com o Notion).
3. **Ficha** com o schema da planilha (estender `ContractTerms` para ~24 campos com `source`),
   estados a conferir / verificado / sinalizado, e reprocessar os contratos que já estão no volume.
4. **Contratos** sobre o Tabular Review: colunas da planilha, chips, 4 visões fixas, edição inline,
   **export .xlsx**.

### Semana 2: o dia a dia
5. **Início** (Head e Analista) com Exige você, mini-esteira, prazos de aviso.
6. **Inbox** (Entrada + Triagem) com SLA e canal. Formulário de 30 s criando card na Entrada.
   Status de volta na thread do #doc-agent.
7. **Alertas** D-60/30/7 por e-mail e Slack ao responsável, com link para o card.
8. **Atividade + comentários** (@menção por e-mail). Papel simples e flag Confidencial.

### Depois (ordem sugerida)
- Bot pergunta na thread o que falta; status no Slack para tudo; Hermes também no WhatsApp.
- Perguntar como gaveta com escopo, "transformar em coluna" e "+ Coluna" por pergunta.
- Botões de renovação dentro do e-mail/Slack, Renewal Brief, cartão "vou fazer X, ok?".
- Semáforo contra playbook, redline e aprendizado de playbook (fluxo 2a do wireframe).
- Importação em amostra, e-mail → card, respostas automáticas por política.
- Contexto do cliente no card (Pipedrive + warehouse, ver `avn-clm/ROADMAP.md`).
- Fase 2 do sync com o Notion (a volta ↕), workspaces e permissões finas do upstream.

### Não fazer  [Sonar]
Setup de semanas · citação só por documento (tem que ser por trecho) · workflow que precisa
reiniciar para trocar o responsável · template que só o suporte edita · tela nova para quem pede.

## 7. Métricas (4 semanas após o MVP)
- A planilha do Legal passa a ser **exportada do Mike**, não editada à mão.
- ≥ 80% dos campos da ficha **verificados** nos contratos vigentes.
- 100% dos contratos vigentes com responsável e data limite do aviso conhecida. Zero renovação perdida.
- ≥ 70% dos pedidos entrando pelo #doc-agent ou pelo formulário, com SLA medido.
- Tempo médio de Entrada → Revisão visível na Início.

## 8. Perguntas para validar com o Legal
1. Os SLAs por tipo (NDA 1d · fornecedor 3d · cliente 5d · parecer 2d) fazem sentido?
2. Quais campos da planilha são **obrigatórios** para um card ir para Arquivado?
3. Alertas vão para o Responsável do card ou para a área responsável? Quem recebe o resumo semanal?
4. O que é confidencial por padrão (societário, trabalhista)?
5. Founder/CFO só lê e pergunta, ou também edita?
6. Os cards de contratos que já existem antes do Mike entram direto em Arquivado (importação em amostra)?

## 9. Sobre o protótipo
`prototype/index.html`: HTML/CSS/JS estático, um arquivo, dados fictícios (empresas inventadas),
tokens visuais Avenia do wireframe, tema claro/escuro, funciona no celular. Não persiste nada.
- **Ver como** (topo): Head · Analista · Solicitante · CFO. A Início muda por papel.
- **Esteira**: arraste cards entre as 6 etapas; troque para **Inbox** (Entrada + Triagem).
- **Card de pedido** (ex.: NDA Polaris): thread do Slack espelhada, triagem da IA, Assumir, Pedir
  informação e Aprovar NDA padrão (com o cartão "vou fazer X, ok?").
- **Card de contrato** (ex.: Trópico, em Contratos): clique num campo da Ficha e veja a cláusula
  destacada. Verificar, Sinalizar, Editar. Riscos, Prazos, Atividade com @menção.
- **Contratos**: visões, "filtrar ou perguntar" (tente "clientes com mudança de controle"), **+ Coluna**, exportar.
- **Início** → *Renegociar* num alerta de renovação cria um card novo na Entrada.
- **Perguntar** (botão ou `?`): escopo, fontes com trecho, Ver como tabela, Transformar em coluna.
