# Mike no GKE (staging e prévia de integração)

Cluster `mike-gke` (Autopilot, southamerica-east1, nós privados, kubectl só pelo
DNS endpoint). Dados **só sintéticos**; produção continua na VM `mike-clm`.

| Ambiente | Namespace | URL | O que roda | Atualiza com |
|---|---|---|---|---|
| staging | `staging` | https://staging.clm.avenia.tech (provisório: https://34-120-191-197.nip.io) | `infra/gke-staging` | `scripts/deploy.sh staging` |
| prévia de integração | `preview` | https://preview.34-120-191-197.nip.io | `integration/harvey` = sync + PRs abertos | `scripts/update-preview.sh` |

Os dois passam pelo mesmo HTTPS LB (Gateway `staging/mike-edge`, IP
`mike-staging-ip`) e pelo mesmo IAP: só contas `@avenia.io` entram. O preview
não tem Gateway próprio. As rotas dele se penduram no do staging com
`hostnames: [preview…]`, e o listener aceita rotas de namespaces com o label
`app.kubernetes.io/part-of: mike`.

## Acesso de pessoas

1. Abra a URL e entre com o Google `@avenia.io` (IAP).
2. No Mike, entre com uma conta demo:
   - `legal.demo@avenia.io`: time do Legal (owner da org "Avenia Legal (demo)");
   - `solicitante.demo@avenia.io`: quem pede.
   A senha está no Secret do namespace e nunca vai para o git:
   `kubectl -n <ns> get secret mike-secrets -o jsonpath='{.data.DEMO_PASSWORD}' | base64 -d`

## Acesso de agentes (Playwright/curl atrás do IAP)

A service account `mike-preview-e2e@ari-teste-492120.iam.gserviceaccount.com`:
- não tem chave;
- tem `roles/iap.httpsResourceAccessor` só nos backend services do Mike (`scripts/grant-iap.sh`).

Quem roda o teste gera um token curto (1 h) por impersonação. Para isso precisa
de `roles/iam.serviceAccountTokenCreator` na SA. Peça ao Ari; hoje só ele tem.

```bash
URL=https://preview.34-120-191-197.nip.io
export IAP_TOKEN=$(deploy/gke/scripts/iap-token.sh $URL)   # JWT assinado pela SA, aud = $URL/*
curl -s -o /dev/null -w '%{http_code}\n' -H "Proxy-Authorization: Bearer $IAP_TOKEN" $URL/login   # 200
```

Os dois headers funcionam: o IAP valida e **remove** tanto `Proxy-Authorization`
quanto `Authorization`, então o backend do Mike nunca vê o token, e a sessão
continua no cookie. Use:
- `Proxy-Authorization` no curl e em clientes HTTP;
- `Authorization` no browser, porque o Chrome bloqueia `Proxy-Authorization`.

O token só vale para o host do `aud`: um token do preview não abre o staging.

Playwright (`playwright.config.ts`). O header vai só para o host do Mike, nunca para terceiros:

```ts
const BASE = process.env.MIKE_URL ?? "https://preview.34-120-191-197.nip.io";
export default defineConfig({ use: { baseURL: BASE } });

// em um fixture/beforeEach:
await context.route("**/*", (route) => {
  const req = route.request();
  if (new URL(req.url()).host !== new URL(BASE).host) return route.continue();
  return route.continue({ headers: { ...req.headers(), authorization: `Bearer ${process.env.IAP_TOKEN}` } });
});
```

Depois faça o login no Mike normalmente, pela tela `/login`, com uma conta demo
(`DEMO_PASSWORD` no env do teste, lida do Secret como acima). O token expira em
1 h: gere um novo por rodada, nunca o salve em arquivo versionado.

## Prévia de integração: um comando

```bash
deploy/gke/scripts/update-preview.sh
```

1. Recria `integration/harvey` a partir de `origin/sync/upstream-2026-10` com merge, em ordem:
   - `infra/gke-staging`
   - `feat/card-events`
   - `feat/ui-verdict`
   - `feat/ui-agent-suggestion`
   - `feat/intake-orquestracao`
   - `feat/radar-regulatorio`
   - `feat/inicio-contract-intelligence`
   - `feat/revisao-playbook`

   Usa sempre a branch do `origin`; se ela não estiver pushada, pula. A exceção
   é quem estiver em `LOCAL_OK` (hoje só `feat/radar-regulatorio`), que entra
   pelos commits locais com aviso.
2. Resolve sozinho só os conflitos de acréscimo, sempre com diff3:
   - `backend/schema.sql`, `app.ts`, `jobs/registry.ts`, `mikeApi.ts` e `mikeApi.contracts.test.ts`: os dois lados. O ledger de migrações sai reordenado;
   - `sentryPrivacy.ts` (back e front) e `scriptedDb.ts`: união das palavras (`union-words.pl`);
   - `navItems.ts` e o teste dele: união dos itens do menu na ordem do doc 05, Início · Pedidos · Esteira · Contratos · Prazos · Radar regulatório · Perguntar (`union-nav.py`);
   - `AppSidebar.tsx`: por trecho, fica o lado que contém o outro (`superset.pl`).

   Uma branch com outro conflito, ou cujas migrações criam uma tabela que outra
   branch já cria, **fica de fora** e é nomeada no fim. As demais entram, e o
   dono rebaseia na `integration/harvey`.
3. Faz push de `integration/harvey`, que é gerada e nunca editada à mão.
4. Faz o Cloud Build do commit, o apply no namespace `preview` e roda as migrações
   (db-init), o rollout e o seed.

Conflito real que fica fora dessas regras não é resolvido aqui: a branch fica de
fora e o dono rebaseia na `integration/harvey`.

Variáveis: `RESET_DB=1` recria o banco do preview (sintético, re-seed), para quando uma branch reescreveu uma migração já aplicada; `BRANCHES="..."` troca a lista, `SKIP_MERGE=1` redeploya a branch como
está, `SKIP_BUILD=1` reaproveita a imagem do commit.

## Seed

- `seed/`, nos dois ambientes:
  - 2 usuários demo;
  - 12 cards nas 6 lanes;
  - termos de contratos vigentes;
  - 7 prazos com data relativa a hoje.
- `seed/integration/`, só no preview. Cada arquivo declara na linha 1 as tabelas de que precisa e é pulado se o PR dele ficou fora do build:
  - org do time do Legal;
  - 6 pedidos LEG-0001..0006 em todos os status;
  - 2 varreduras do radar e 4 achados (alto/médio/baixo, cruzados com os cards);
  - `agent_runs` e o log `card_events`;
  - Início (`extra-inicio.sql`, do Beacon): 1 pasta monitorada, 6 documentos e 6 revisões em todos os estados.

Tudo fictício, com ids fixos e idempotente. Os atos regulatórios são inventados
e as URLs apontam para `example.invalid`.

## Segredos

`scripts/bootstrap-secrets.sh <ns>` gera os segredos de cada namespace (JWT do
Supabase, senha do Postgres, chaves de assinatura do backend, senha demo). Os
valores ficam só no Secret do namespace: nada em git, nada impresso. `ROTATE=1`
regenera e derruba as sessões.
