# infra/: rascunhos (NÃO executados)

Rascunhos do doc [`../04-arquitetura-plataforma.md`](../04-arquitetura-plataforma.md).
**Nada aqui foi executado.** Nada aponta para a VM de produção, para `clm.avenia.tech`
ou para os volumes `mike_db_data`/`mike_storage_data`. Os rascunhos só funcionam depois
de ir para o fork (`AriOliv/mike`), num PR revisado, e de o maestro dar OK para criar a VM
de staging.

| Pasta | O que é | Vai para (no fork) |
|---|---|---|
| `github/ci.yml` | CI de PR: lint, typecheck, testes, build | `.github/workflows/ci.yml` |
| `github/preview.yml` | prévia efêmera por PR (`pr-<n>.preview.clm.avenia.tech`) + teardown | `.github/workflows/preview.yml` |
| `github/staging.yml` | deploy de staging a cada push em `main` do fork | `.github/workflows/staging.yml` |
| `staging/docker-compose.preview.yml` | stack sem portas publicadas, parametrizada por `COMPOSE_PROJECT_NAME` | `deploy/preview/` |
| `staging/preview-up.sh`, `preview-down.sh`, `preview-gc.sh` | sobe, derruba e coleta lixo das stacks na VM `mike-staging` | `deploy/preview/` |
| `staging/Caddyfile.preview` + `cloudflared.yml` | roteamento por host atrás do Cloudflare Tunnel | `deploy/preview/` |
| `seed/seed.sql` + `seed/seed-users.sh` | dados sintéticos (contratos fictícios, prazos, usuários demo) | `deploy/preview/seed/` |
| `feedback/` | migração + rota `POST /feedback` + widget React | `backend/…`, `frontend/…` |
| `agents/20261021_01_agents_audit.sql` | `agent_runs`, `card_events`, `notifications`, `mcp_service_tokens` (com `org_id`) | `backend/migrations/` |
| `agents/triggers.draft.ts` | regras etapa → agente (declarativas) | `backend/src/agents/` |
| `mcp/mikeMcpServer.draft.ts` | esqueleto do MCP server (contrato §3.3) | `backend/src/mcp-server/` |
| `hermes/docbot-mcp.snippet.yaml` | trecho do `config.yaml` do docbot | `hermes-gcp-deploy/docbot/config.yaml` (PR lá) |

## Segredos e variáveis (só nomes; valores no GitHub ou no Secret Manager)
- **GitHub (repo do fork):**
  - variáveis `WIF_PROVIDER`, `DEPLOYER_SA` (Workload Identity, mesmo padrão do Hermes),
    `STAGING_VM`, `STAGING_ZONE`, `GCP_PROJECT`, `AR_REPO`
  - segredos `PREVIEW_DEMO_PASSWORD`, `FEEDBACK_GITHUB_APP_ID`,
    `FEEDBACK_GITHUB_APP_KEY`
- **VM de staging** (Secret Manager → `/opt/mike-preview/.env.shared`, lido pelo
  `preview-up.sh`): `JWT_SECRET_PREVIEW`, `CUSTOM_OPENAI_API_KEY_PREVIEW` (virtual key da
  LiteLLM **com orçamento baixo**, ex.: US$ 20/mês), `GOOGLE_OAUTH_*_STAGING` (client
  próprio de staging).
- **Nunca** reutilizar segredos de prod em staging/prévia.

## Pré-requisitos (decisões do maestro/Ari)
1. Código de `recover/publish-clm` reconciliado no fork (branch `clm/main`).
2. Criar a VM `mike-staging` (`e2-standard-4`, sa-east1) + o tunnel Cloudflare `mike-preview`.
   Nenhum dos dois toca prod.
3. Registros DNS `staging.clm.avenia.tech` e `*.preview.clm.avenia.tech` → tunnel (CNAME
   proxied). Isso **não muda** o registro de `clm.avenia.tech`, que continua DNS-only para a
   VM de prod.
4. Aplicação do Cloudflare Access nesses hosts: Google, `@avenia.io`.
