# 07 · Pedidos, orquestração e Spaces

> Autor: Relay · 2026-10-20 · branch `feat/intake-orquestracao` (empilhada sobre `feat/card-events`, PR #6 do Beacon)
> Base: [`03-ux-spec.md`](03-ux-spec.md) §4.2–4.4 e [`04-arquitetura-plataforma.md`](04-arquitetura-plataforma.md) §2–3.

## Resumo

Qualquer pessoa da empresa pede ao Legal em 30 segundos. O pedido recebe:
- um ID legível (**LEG-0001**);
- prazo por tipo, que pausa enquanto o Legal espera resposta;
- um card na **Entrada** da esteira;
- uma triagem de agente que a liderança **aceita, edita ou rejeita** num clique.

Quem pede acompanha só os próprios pedidos, numa página simples. Um escritório externo pode ser convidado para **um** pedido, com prazo de expiração. Tudo vira e-mail nos momentos que importam e entra no feed de atividade do card.

## Decisões (e por quê)

| # | Decisão | Por quê | Alternativa rejeitada |
|---|---|---|---|
| 1 | **Pedido é uma tabela própria** (`legal_requests`) ligada 1:1 a um card (`projects` com `lane='entrada'`) | O card é do time: documentos, chat e revisões. O pedido é o contrato com quem pediu: status, perguntas e entrega. Separar os dois permite mostrar ao solicitante só o recorte seguro | Dar ao solicitante acesso ao projeto, o que exporia rascunho interno, atividade e documentos |
| 2 | **Time do Legal = uma `organizations` do upstream**, registrada em `legal_teams` | Reaproveita membros, papéis (owner/admin = liderança) e a regra de acesso a projetos (`checkProjectAccess`). Sem papel novo nem tabela de permissões paralela | Papel "Solicitante" como enum novo no usuário |
| 3 | **Solicitante e convidado externo nunca entram na org nem ganham grant do card** | A org dá acesso à carteira, e o grant direto não vale para projeto de org (`lib/access.ts`). O convidado vive em `legal_request_participants`: um pedido, por e-mail, expira em 90 dias, revogável | Convidar o escritório para a org, o que liberaria todos os contratos |
| 4 | **Triagem é um job `db_jobs`** (`request.triage`) que grava sugestão, `agent_runs` e `card_events` e **não decide**. A liderança aceita, edita ou rejeita. `auto_assign` no time aplica só o responsável | "Agente sugere, humano decide". O job roda fora do request HTTP, com retry e sem custo duplicado (dedupe por pedido) | Atribuir sempre direto |
| 5 | **Responsável sugerido por regra determinística**, não pelo LLM: menor carga aberta; no empate, quem fez o último pedido do mesmo tipo; depois ordem alfabética | Explicável numa frase ("Duda: 0 pedidos abertos (Téo tem 2)"), igual em todo retry e testável | Pedir ao modelo para escolher |
| 6 | **LLM só pelo registro do upstream**: `LEGAL_TRIAGE_MODEL` (um id do `MIKE_MODEL_CONFIG_JSON`) ou, na falta, o modelo de tabular/último chat do owner do time. Sem modelo, ou com falha, a triagem roda **por regras** (selo "sem IA") e o pedido nunca trava | Não bloquear o Legal por causa de provedor | Falhar o pedido |
| 7 | **E-mail por outbox** (`legal_request_notifications`, dedupe por evento) + job `request.notify` + `lib/mailer.ts` (nodemailer, `SMTP_URL`; Mailpit no local). Sem SMTP, a linha vira `skipped` | Falha de e-mail não desfaz a mudança e não manda duas vezes. O upstream não tinha mailer de app (só o GoTrue usa SMTP) | Enviar dentro do request |
| 8 | **Pergunta ao solicitante pausa o prazo** (`paused_at` / `paused_seconds`) e põe o card em Bloqueado. A resposta retoma o prazo e soma a pausa | Prazo justo e medível. O solicitante vê "prazo pausado até você responder" | Prazo corrido |
| 9 | **Anexo**: o solicitante sobe pela sessão "standalone" do upstream; ao criar o pedido, o backend move para o card só arquivos **dele**, soltos e pessoais (ou já do workspace do Legal) | Reusa o upload do upstream (conversão, PDF, texto) sem rota nova de bytes | Upload direto para o projeto, que o solicitante não acessa |
| 10 | **Serviço pronto para o MCP**: `createRequest` (aceita `source` + `idempotency_key`; repetir a chave devolve o mesmo pedido), `getRequest`, `listRequests({mine})` | Contrato do doc 04 §3.3 (`mike_request_analysis`, `mike_get_request_status`, `mike_list_my_requests`). Falta só o servidor MCP e a auth por token | — |

## Telas (rotas)

- **`/pedidos`, para o time**: 4 contadores que filtram ("Sem dono", "Prazo estourando", "Aguardando solicitante", "Entregues na semana"). Abas **Abertos · Meus pedidos (N) · Todos**, busca, tabela `ID · Pedido · Solicitante · Canal · Prazo · Status · Responsável`. O responsável aparece como pessoa ou como sugestão roxa do agente. Atalhos: `j/k`, `Enter`, `n` (novo pedido).
- **Painel do pedido** (`?pedido=<id>`, sobre a lista): status, prazo, responsável trocável, solicitante, canal e urgência; resumo da IA e pedido original. Embaixo:
  - **cartão de triagem** (Aceitar `a` · Editar `e` · Rejeitar `r`, com motivo opcional);
  - **Plano** (`AgentPlan`: agentes e pessoas numa lista, cada passo com estado);
  - **Conversa** ("Perguntar ao solicitante" pausa o prazo, "Enviar recado" não);
  - **Quem mais acompanha** (convidar escritório ou área, remover acesso);
  - **Entrega** (devolutiva que sai por e-mail, "pede ok antes");
  - **Atividade** (`ActivityFeed` do Beacon com os verbos novos).
- **`/pedidos`, para quem não é do time** ("Meus pedidos"): lista com os 4 passos (Recebido → Em análise → Assinatura → Concluído), quem cuida e o aviso "o Legal fez uma pergunta". Estado vazio: "Precisa do Legal?" com o botão.
- **`/pedidos/[id]`** (solicitante ou convidado): passos, quem cuida, prazo, aviso de pergunta pendente, entrega com arquivos, "como o Legal entendeu" e a conversa. Quem é do time é redirecionado ao painel.
- **Formulário "Pedir ao Legal"** (modal): 6 tipos em linguagem de quem pede, "Com quem?", contexto, urgência, "Precisa até" e até 5 anexos. Nenhum campo jurídico.

## Modelo de dados (migration `20261020_93_legal_requests.sql`, na branch `feat/intake-orquestracao`)

`legal_teams(org_id, sla_days, auto_assign)` · `legal_requests(number→LEG, org_id, project_id, requester_*, kind, title, counterparty, context, urgency, needed_by, due_at, status, paused_*, assignee_id, summary, triage jsonb, delivery jsonb, source jsonb, idempotency_key)` · `legal_request_participants(email, role external|viewer, label, expires_at, revoked_at)` · `legal_request_messages(kind question|answer|note)` · `legal_request_notifications(template, recipient, dedupe_key, status)`.

O fluxo grava `card_events`, incluindo `request.created`, `request.triaged`, `assignee.suggested|changed`, `triage.accepted|edited|rejected`, `request.question|answered|delivered` e `participant.invited|revoked`. A triagem também grava `agent_runs`.

**SLA padrão** (dias úteis; `legal_teams.sla_days` sobrescreve): NDA 1 · parecer 2 · revisão 3 · aditivo 3 · contrato novo 5 · outro 3. Urgência alta = ⅔ do prazo, urgente = ⅓ (mínimo de 1 dia). Se quem pede precisa antes, vale a data dele.

## Ativar (staging/prévia)

1. Aplicar a migration (`migrate.sh`).
2. `insert into legal_teams(org_id) values ('<org do Legal>')`. Head = owner/admin da org; analistas = membros.
3. Backend: `SMTP_URL`, `MAIL_FROM`, `APP_BASE_URL`. Opcionais: `LEGAL_TRIAGE_MODEL` e `LEGAL_TEAM_ORG_ID`.

## Testes

- **Backend**: 26 testes no módulo. Cobrem regras puras, o serviço contra um banco em memória (acesso time, solicitante, convidado e estranho; triagem com e sem LLM; auto-assign; pausa do prazo; entrega; convite com expiração; outbox) e as rotas HTTP. Também passam `lib/mailer`, arquitetura e ledger.
- **Frontend**: `lib/requests.ts` com 100% de cobertura, `activityFeed` com os verbos novos, `mikeApi` com os endpoints e os testes de `AgentPlan`, `TriageSuggestion`, `RequestSteps` e `RequestConversation`.
- Typecheck e lint limpos nos dois.

## Pendências e o que validar com o Legal

- **Screenshots e teste ponta a ponta na stack local**: a stack (`mike-intake`, portas próprias) foi derrubada pelo sistema por falta de memória durante o build. Precisa rodar de novo antes de tirar o PR de rascunho.
- **Head entra na distribuição?** Hoje a sugestão considera todos os membros da org, inclusive a liderança. Pode virar uma lista "quem recebe pedidos".
- **SLAs por tipo**: validar os números (mesma pergunta do 03 §8).
- **Mensagens de erro** usam o `notifyError` do upstream, que tem título em inglês ("Couldn't …"). A tradução é transversal, fica para o Prism/menu PT.
- **Menu PT** (7 itens + Mais ▾) não foi feito aqui: só entrou "Pedidos" na sidebar.
- **`AgentSuggestion` do Quill**: o cartão de triagem é local (`components/requests/TriageSuggestion.tsx`), com o visual da §4.7. Trocar quando o componente for publicado.
- **Depois**: servidor MCP (Hermes/docbot), resposta na thread do Slack, e-mail `legal@` → pedido, Jira (só link).
