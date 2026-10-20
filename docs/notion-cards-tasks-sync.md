# Cards do Mike ↔ Notion — task-shaped, bidirecional

Espelhar cada card da esteira (contrato) para um board do Notion com a **forma de
uma task** (Status, Responsável, Prioridade, Prazo, Conclusão), para o time Legal
acompanhar e gerenciar o progresso no Notion. Fonte da verdade compartilhada por
campo: os campos de gestão são editáveis nos dois lados; os campos derivados do
contrato descem só do Mike.

## Decisões (fechadas)

1. **Atributos:** forma de task adaptada ao Legal — sem os campos de engenharia
   (Área de tech, Classificação Tech, Claude Difficulty).
2. **Sync:** bidirecional (a Duda edita no Notion e volta pro Mike).
3. **Status vs Etapa:** dois eixos separados. Etapa = fase do contrato (as 6
   lanes); Status = progresso da task (A fazer / Em andamento / Bloqueado /
   Concluído), independente.
4. **Autoridade dos campos:** task editável (↕), contrato read-only (↓).
5. **Onde:** evoluir o board-espelho existente ("Pipeline — Mike"), keyed por
   `ProjectId`. Sem novo DB, sem migração de board.
6. **Tipo de contrato:** o Mike passa a classificar na análise (campo derivado,
   como o Risco).

## Schema do board (Notion)

↕ = edita nos dois lados · ↓ = só Mike→Notion (read-only no Notion)

| Propriedade | Tipo Notion | Direção | Origem no Mike |
|---|---|---|---|
| Name | title | ↓ | `projects.name` |
| Etapa | select (6 lanes) | ↕ | `projects.lane` |
| Progresso | select (A fazer/Em andamento/Bloqueado/Concluído) | ↕ | `projects.status` (novo) |
| Responsável | people | ↕ | `projects.assignee_email` (novo) + mapa e-mail↔usuário Notion |
| Prioridade | select (Baixa/Média/Alta) | ↕ | `projects.priority` (novo) |
| Prazo | date | ↕ | `projects.deadline` (novo) |
| Data de conclusão | date | ↕ | `projects.completed_at` (novo) |
| Contraparte | rich_text | ↓ | `projects.counterparty` |
| Risco | select | ↓ | `projects.risk_level` |
| Renovação | date | ↓ | `contract_terms.notice_deadline` |
| Tipo | select | ↓ | `projects.contract_type` (novo, classificado na análise) |
| ProjectId | rich_text | — | `projects.id` (chave de upsert) |

## Schema do Mike (colunas novas em `projects`)

`status`, `assignee_email`, `priority`, `deadline` (date), `completed_at` (date),
`contract_type`. Backfill: Status default derivado da lane (arquivado→Concluído,
demais→Em andamento); Prioridade default nula.

## Mecânica do sync

O backend já roda um sync agendado do Notion (`NOTION_SYNC_SECONDS`) — hoje só
empurra. Passa a fazer os dois sentidos no mesmo loop:

- **↓ (push):** para cada card, o Mike escreve os campos ↓ sempre (sobrescreve o
  Notion). Os campos ↕ também são empurrados quando mudam no Mike.
- **↕ (pull):** consulta o board por `last_edited_time` > cursor; para cada campo
  ↕, se o valor no Notion difere do valor no Mike **e** é mais novo, grava no
  Mike.
- **Anti-loop:** guarda por card `notion_last_synced` (o `last_edited_time` que já
  processamos) e compara valores. Escrita do próprio Mike não é lida como edição
  da Duda (atualiza o cursor após o push).
- **Conflito:** last-write-wins por timestamp, por campo.
- **Responsável (people):** mapa `e-mail ↔ notion_user_id`, semeado com o time
  Legal (Ari, Duda, Bruno) e completado pela API de usuários do Notion.

## Fases

- **Fase 1 — mão única + schema.** Migração (colunas novas), classificação do
  Tipo na análise, UI dos campos no card, e o espelho enriquecido (todos os
  campos descem). A Duda **vê** Status/Responsável/Prioridade/Prazo/Conclusão no
  Notion. Baixo risco.
- **Fase 2 — a volta (↕).** Estende o loop para puxar as edições da Duda, com
  anti-loop e conflito. É a parte que exige cuidado.

## Operação

Produção = VM GCP (clm.avenia.tech). Cada fase é: migração no banco da VM +
rebuild do backend (e frontend, se UI) + `docker compose up`. Não é local.

## Nota de implementação

O eixo de progresso vira uma propriedade **"Progresso" (select)**, não "Status":
o board já traz uma propriedade "Status" nativa do tipo `status`, cujas opções não
podem ser criadas/editadas via API. Um select próprio, com nome distinto, deixa o
mirror gerenciar os quatro estados (inclusive "Bloqueado"). A propriedade "Status"
nativa fica sem uso.

## Aberto / a decidir depois

- Vocabulário de `contract_type` (lista de tipos) — definir com a Duda.
- Quem pode ser Responsável (só o time Legal, ou qualquer usuário @avenia.io).
- Fase 2: polling vs webhook (v1 = polling).
