# Sync do fork com o upstream — outubro/2026

**Status:** PR draft aberto, nada em `main` e nada em produção.
**PR:** https://github.com/AriOliv/mike/pull/2 (base `main`, branch `sync/upstream-2026-10`)
**Repo de trabalho:** `/Users/arioliveira/Avenia/Projects/mike-fork`

## Resumo

O fork estava 828 commits atrás de `open-legal-products/mike`. Fiz **merge** (sem rebase) do `upstream/main` numa branch nova a partir de `main`. Antes do merge, portei o código que só existia no checkout de produção (`/Users/arioliveira/Avenia/Projects/mike`) em commits separados. Depois do merge, todo o código do CLM foi movido para a arquitetura nova do upstream.

| Commit | O quê |
|---|---|
| `7f1507d8` | feat(terms): classificação do tipo de contrato na extração de termos |
| `c03f4a55` | feat(pipeline): campos de tarefa no card (status, responsável, prioridade, prazo, conclusão) + migration |
| `90e14045` | feat(notion): espelho task-shaped no Notion + `docs/notion-cards-tasks-sync.md` |
| `e829bc33` | feat(pipeline): board mostra e edita os campos de tarefa |
| `d496dca7` | feat(login): botão Google Workspace (o merge substituiu por outra solução, veja abaixo) |
| `9fb51ab0` | **Merge upstream/main (828 commits)** |
| `799387d3` | ci(sync): rotina semanal de sync (GitHub Action) |
| `89091e7b` | docs(sync): dica de subnet e roteiro de smoke test |

## Conflitos e decisões

1. **`backend/src/routes/*` → `backend/src/modules/contracts/`.** O upstream proíbe `src/routes` (teste `architecture.test.ts`) e organiza o backend em módulos com uma fachada `*.service.ts`. Pipeline, obrigações (radar), dossiê, preview, termos, acervo e integrações agora vivem em `modules/contracts/`. As URLs públicas não mudaram: `/pipeline`, `/obligations`, `/acervo`, `/integrations` e `/projects/:id/{dossier,preview,terms}`.
2. **Permissões.** A coluna `projects.shared_with` deixou de existir; o upstream usa grants por projeto e organizações. Todo o CLM agora passa por `checkProjectAccess`: viewer lê, editor/owner escreve, e um projeto inacessível retorna 404. O pipeline e o acervo listam só os projetos acessíveis. Com isso o CLM passa a ser multi-usuário de verdade e respeita o compartilhamento do upstream.
3. **Modelos de IA.** Nosso BYOK customizado (`lib/llm/custom.ts`, rota `/user/models`, página account/models) foi **removido** em favor do registro de providers do upstream. Em produção os modelos são declarados em `MIKE_MODEL_CONFIG_JSON` (há exemplo em `backend/.env.example`). Sem modelo escolhido, termos e acervo respondem `model_required` em vez de adivinhar um.
4. **Login Google.** Ficou a página de login do upstream. O domínio restrito (`hd=avenia.io`) passou a ser configurado no backend pela variável `GOOGLE_OAUTH_HOSTED_DOMAIN`, que tem teste.
5. **Espelhos Notion/Drive/Calendar.** Antes eram iniciados no `index.ts`; agora sobem pelo runtime de workers (`startContractMirrors`), como os demais jobs do upstream. A inicialização é idempotente e cada espelho continua desligado se faltar a env correspondente.
6. **Migration de task fields.** O arquivo `20260901_01` colidia com um slot do upstream e foi renomeado para `20261020_02_task_fields.sql`. Ele é idempotente e já está aplicado em produção.
7. **`schema.sql`, `docker-compose.yml`, `.gitignore`, `.env.example`.** Mantive as mudanças dos dois lados, incluindo nosso volume `backend/secrets` e as tabelas `obligations`, `dossiers`, `contract_terms` e `app_settings`.
8. **Frontend.** Sidebar, abas e páginas do upstream, mais Pipeline, Radar, Acervo e as abas Revisão/Análise do projeto. `mikeApi.ts` agora usa `apiFetch` com cookie httpOnly, como o resto do upstream.
9. **Sentry.** Os novos segmentos de rota entraram no vocabulário de privacidade. Há duas cópias (frontend e backend) e elas precisam ser idênticas.

## Sobreposições com o upstream — o que manter

| Nosso | Upstream | Recomendação |
|---|---|---|
| **Dossiê** (ficha do contrato com análise de IA) | **Playbooks + review** (regras do time aplicadas a um documento, com achados) | **Manter os dois e convergir.** O dossiê é a *visão* do contrato (a ficha que o Legal lê). Playbooks é um *motor* de revisão por regras, que é exatamente o que `risk-rules.v1.yaml` quer ser. Próximo passo: transformar nossas regras de risco num playbook e fazer o dossiê exibir os achados do playbook, em vez de manter um prompt próprio. Não vale apagar o dossiê agora. |
| **Acervo** (pergunta em linguagem natural sobre todos os contratos; baixa os PDFs e faz o ranking em memória) | **Busca em documentos** (texto indexado no banco: `read_document_text`, migration `20261015_01_document_text_search`) | **Manter o Acervo como UX e trocar o motor.** O Acervo deve passar a usar o texto já indexado pelo upstream em vez de baixar PDFs a cada pergunta. É mais rápido, mais barato e respeita os mesmos grants. |
| **Espelho Drive** (service account copia documentos para uma pasta compartilhada) | **Google Drive/Workspace** (OAuth por usuário, leitura no chat) | **Manter os dois.** Os propósitos são diferentes: o nosso arquiva, o deles consulta. |

## Status de testes e build

| Etapa | Resultado |
|---|---|
| Backend `tsc` + `typecheck:test` | OK |
| Backend vitest | 279 arquivos, 4348 testes passando (99 skipped)\* |
| Backend build | OK |
| Frontend typecheck | OK |
| Frontend lint | 0 erros (31 warnings pré-existentes do upstream) |
| Frontend vitest | 371 arquivos, 3818 testes passando |
| Frontend `next build` | OK (as páginas /pipeline, /radar, /acervo e as abas dossier/review compilam) |
| Testes novos | `modules/contracts/__tests__/contracts.test.ts` (10 testes: acesso, validação, model_required, escopo do acervo) e teste do `hd` no auth |
| Stack local | Projeto Compose `mikesync`, portas 31xx/54xx, **sem tocar** em `mike_db_data`/`mike_storage_data` (verificados intactos ao final). Fluxo testado: signup, confirmação via Mailpit, login, listar e mover card com campos de tarefa, salvar dossiê, criar obrigação e ver status das integrações. Termos e acervo retornaram `model_required`, como esperado sem modelo configurado. Ao final, `down -v` apenas do `mikesync`. |

\* Três testes de `providers.catalog` falham quando o shell exporta `ANTHROPIC_BASE_URL`, como faz o Claude Code com proxy. É um problema do ambiente, não do código: rodando com `env -u ANTHROPIC_BASE_URL`, todos passam.

## Riscos para migrar o banco de produção

1. **A produção não tem ledger de migrations.** O deploy da VM não tem `db-init` nem a tabela `schema_migrations`; as migrations foram aplicadas à mão. São **105 migrations novas** do upstream desde o merge-base.
2. **Migrations pesadas ou destrutivas:**
   - `20260813_01_user_id_foreign_keys` converte `user_id` de text para uuid e cria FKs. **Falha se houver `user_id` órfão ou inválido.** É preciso rodar antes uma query de verificação de órfãos.
   - `20260904_02_migrate_legacy_sharing` migra `projects.shared_with` para grants e **remove a coluna**. Verificar antes que todo compartilhamento atual foi migrado.
   - `20260914_01_document_lifecycle`: sem ela, **o backend se recusa a subir** (lifecycle guard).
   - As migrations de ciclo de vida de organização (`20261014_03`, `20261014_07`).
3. **Nossas tabelas** `obligations`, `dossiers` e `contract_terms` continuam com `user_id text` sem FK. Funcionam, mas ficaram fora do padrão do upstream. Pendência: migration própria para uuid + FK.
4. **Envs novas obrigatórias em produção:** `MIKE_MODEL_CONFIG_JSON` (senão nenhum modelo aparece) e `GOOGLE_OAUTH_HOSTED_DOMAIN=avenia.io`. Os modelos que os usuários já tinham escolhido precisam existir no novo config com o mesmo id (`custom/<modelo>`).
5. **Sentry:** o upstream liga o Sentry da comunidade por padrão. Em produção, definir `SENTRY_DISABLED=true` ou apontar `SENTRY_DSN` para um projeto nosso. Atenção: o `docker-compose.yml` do upstream não repassa `SENTRY_DISABLED` ao backend, então é preciso colocá-lo no `env_file`.

**Sequência recomendada**, a ser feita por quem tem acesso à VM, não por este squad:

1. Backup do volume.
2. Restaurar numa cópia e ensaiar o processo nela.
3. Aplicar as migrations pendentes em ordem de nome.
4. `backend/scripts/migrate.sh baseline <último arquivo aplicado>`.
5. `migrate.sh up`.
6. Subir o backend com as envs novas.
7. Smoke test do roteiro em `docs/upstream-sync.md`.

## Rotina para manter o fork atualizado

- **`.github/workflows/upstream-sync.yml`** roda toda segunda às 06:00 BRT e também sob demanda.
  - Se não houver conflito, cria `sync/upstream-<data>` e abre um **PR draft** listando as migrations novas que a produção vai precisar.
  - Se houver conflito, abre uma **issue** com os arquivos conflitados.
  - Não faz nada se o fork já estiver em dia ou se já houver um PR de sync aberto.
- **Ponto de atenção:** um PR criado pelo `GITHUB_TOKEN` não dispara o CI. Para isso, criar um secret `SYNC_TOKEN` (fine-grained, com contents, PRs e issues) ou fechar e reabrir o PR.
- **Regra para que os próximos syncs fiquem pequenos:** todo código do CLM fica em `modules/contracts/`, nos espelhos em `lib/` e nas páginas próprias. Quanto menos editarmos arquivos do upstream, menos conflitos.
- O manual está em `docs/upstream-sync.md` no fork.

## Pendências

- [ ] Revisar e ensaiar a migração do banco de produção (seção acima) **antes** de fazer merge do PR.
- [ ] Configurar `SYNC_TOKEN` no repo, ou aceitar reabrir o PR para rodar o CI.
- [ ] Migration de `user_id` uuid + FK nas tabelas do CLM.
- [ ] Converter `risk-rules.v1.yaml` em playbook; o dossiê passa a consumir os achados do playbook.
- [ ] Acervo passa a usar o texto indexado do upstream.
