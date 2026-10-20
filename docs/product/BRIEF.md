# Mike — workstation do Legal (CLM multi-agent) · Briefing do time

> Fonte única de contexto para todos os agentes. Escrito pelo maestro ("Legal Manager") em 2026-10-20.
> Entregáveis de cada agente vão em `docs/product/` deste diretório
> (`/Users/arioliveira/Avenia/Projects/mike/docs/product/`).

## Objetivo
Produtizar o **Mike** (fork de `open-legal-products/mike`, "OSS Legal AI Platform") como a
**workstation do time Legal** — primeiro cliente: **Avenia** (head de Legal + time; o Ari é o
dono do produto). O cerne é um **CLM**: o Legal acompanha os principais tópicos de cada
contrato, prazos com notificação, conversa com toda a base de contratos, identifica riscos.
Além disso: atender as **pessoas dos outros times** que pedem análise de contrato
(intake → análise → devolutiva), como um **analista sênior de contratos** que poupa tempo.

Princípios: **UX acima de tudo** (intuitivo, muito fácil); **multi-usuário/colaborativo**
(compartilhar, comentar, atribuir); **iteração rápida com prévia sempre atualizada** para o
Legal testar e validar; **pragmático** — entregar valor em semanas, não meses.
Futuro: acoplar um **Hermes Agent** como canal de interação (Slack/WhatsApp).

## Estado atual (levantado em 2026-10-20)
- **Fork**: `github.com/AriOliv/mike` — 13 commits nossos (pipeline/esteira de 6 etapas,
  radar de prazos + calendário + Google Calendar, dossiê de análise IA, espelho no Drive,
  espelho no Notion, acervo = perguntar à base inteira, termos comerciais, endpoint
  OpenAI-compatible custom). **828 commits atrás do upstream** (merge-base 2026-08-06).
  Upstream ganhou: playbooks/reviews, workspaces + sharing, document search, History,
  Word add-in, desktop, StorageAdapter, Gmail/Drive mínimos, e2e Playwright, etc.
- **Clone de trabalho do fork**: `~/Avenia/Projects/mike-fork` (remote `upstream` configurado).
- **Este diretório** (`~/Avenia/Projects/mike`, branch `recover/publish-clm`, SEM remote):
  orquestração de deploy reconstruída + código recuperado das imagens. Contém trabalho
  que **não está no fork**: `backend/src/lib/notion.ts`, `routes/pipeline.ts`,
  `lib/contractTerms.ts`, `frontend/.../pipeline/page.tsx`, `mikeApi.ts`, `login/page.tsx`,
  migration `20260901_01_task_fields.sql` (no fork: `backend/migrations/20261020_90_task_fields.sql`), doc
  `docs/notion-cards-tasks-sync.md`. Deploy: `deploy/` (VM GCP + Caddy + SSO Google).
- **Prévia em produção**: https://clm.avenia.tech (200, atrás de SSO Google). Tem dados
  reais em volumes (`mike_db_data`, `mike_storage_data`) — **não destruir**.
- **Tentativas irmãs** (aprender, não duplicar):
  - `~/Avenia/Projects/avn-clm` — "Ada Legal": triagem → dossiê → doc-fill .docx, sync Slack
    #doc-agent → card, Drive, playbook, roadmap Pipedrive + warehouse (ver `ROADMAP.md`,
    `Wireframes Legal AI (offline).html`).
  - `~/Avenia/Projects/avenia-contracts` — Next+Prisma, Kanban de esteira de revisão.
  - `~/Avenia/Projects/claude-for-legal` — skills/agentes de referência da Anthropic
    (commercial-legal etc.).
  - `~/Avenia/Projects/hermes-gcp-deploy` — Hermes Agent da Avenia (bots Slack/WhatsApp,
    docbot, mcp-oauth-proxy). Base para o canal Hermes.
  - Skill `anthropic-skills:contract-tracker` (planilha "Contratos — Registro").

## Planilha de referência do Legal ("Controle de Contratos - tabela base.xlsx")
Template (sem dados) — cada contrato = 1 linha. É o **schema mínimo de extração**:
| Grupo | Campos |
|---|---|
| Identificação | Tipo de Contrato · Contraparte · Área responsável · Link do drive · Ativo? |
| Obrigações | Obrigações periódicas/importantes |
| Pagamento | Prazo · Multa · Juros · Correção Monetária · Valor · Tributos |
| Vigência | Data Assinatura · Prazo de vigência · Dias p/ vencimento/renovação · Data de vencimento · Renovação Automática |
| Rescisão | Rescisão antecipada · Prazo do aviso prévio |
| Multa rescisória | Sim/Não · Valor |
| Cessão | Sim/Não · Notificação/Autorização · Prazo antecedência · Penalidade por não informar |
| Alteração de Controle | Sim/Não · Notificação/Autorização · Prazo antecedência · Penalidade por não informar |
| Compartilhamento de dados | Sim/Não · Agente (controlador/operador) |
| Multa | (geral) |
| Alteração de parte | Cessão contratual · Alteração de Controle |
Cópia do arquivo: `/private/tmp/claude-501/-Users-arioliveira-Avenia-Projects-mike/fd8b1265-d20a-4f01-a214-5834e43caa9c/scratchpad/xlsx/base.xlsx`

## Regras do time
- Português nos docs de produto; código/commits seguindo o estilo do repo.
- **Nunca** push em `main` do fork, deploy em clm.avenia.tech, ou mexer nos volumes de dados
  sem OK explícito do maestro (que confirma com o Ari). Branches + PRs no fork são ok.
- Não colar segredos (`.env`, chaves) em docs, notas ou commits.
- Ao terminar, reporte ao maestro: `maestri ask "Legal Manager" "<resultado>"`.
