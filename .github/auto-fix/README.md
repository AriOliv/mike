# Auto-fix: o lado público

Este diretório só **recebe** um `repro.md` já aprovado e tenta abrir um PR. Ele nunca vê o relato original: a triagem e a reescrita ficam no repositório privado de feedback.

O dispatch traz duas chaves, `rel` (`REL-nnnn`) e `repro`. Qualquer outra coisa é recusada antes de chegar ao agente.

## Três jobs, cada um num runner limpo

| Job | Tem | Faz | Passa adiante |
|---|---|---|---|
| `agent` | só a chave do gateway | o agente lê e edita arquivos em `backend/src` e `frontend/src`; **sem terminal**; configuração fixada pelo workflow | o **patch** (texto) e o `repro.md` |
| `verify` | **nenhum segredo** | recalcula as guardas sobre o patch, aplica num checkout novo de `main`, roda `npm ci --ignore-scripts` e os testes (aqui roda o código do agente) | só o resultado do job |
| `publish` | o token do App (1 h) | checkout novo de `main`, **recalcula** `numstat` e `summary` do patch com o git, roda as guardas, e só então pega o token, aplica, commita (`--no-verify`, sem hooks) e abre o PR em rascunho | o PR |

Nada que `publish` lê vem pronto de um job que rodou código do agente: o diff é recalculado do patch, o repro é revalidado, e o `.git` do agente nunca é aberto (o patch sai de um repositório **novo** que o próprio workflow cria).

## As guardas (`guard.mjs`)

Rodam com o código de `main`, em checkout separado:

- `parsePayload`: só `rel` e `repro`; 40 a 6.000 caracteres; sem HTML, link, imagem, URL, e-mail, @menção nem caractere invisível (controles, largura zero, bidi, tags U+E0000, BOM).
- `checkDiff`: **allowlist**, só `backend/src/**` e `frontend/src/**` (`.ts .tsx .json .css`), e, dentro delas, nenhuma área de segurança (`egressProxy`, `blockedDestination`, `lib/mcp`, `lib/llm`, `lib/access`, `permissions`, `authSession`, `middleware`, `modules/auth`, `modules/mcp`, `modules/models`, `modules/feedback`, `user.apiKeyStore`, `sentryPrivacy`, `app.ts`, `index.ts`, `worker*`). No máximo 15 arquivos e 600 linhas. Recusa binário, renomeação, cópia, mudança de tipo ou de modo, e caminho com aspas, barra invertida, quebra de linha, invisível, absoluto, `..` ou `.git`.
- `changesFromPatch`: o diff, lido de `git apply --numstat -z` e `--summary -z` (campos por NUL).
- `checkPatch`: o patch bruto. Nada em `.git`, cabeçalho com aspas, link simbólico (120000), submódulo (160000), executável (100755), mudança de modo, binário nem invisível.
- `leaksSecret` e `looksLikeSecret`: o valor da chave do gateway e padrões de chave (inclusive chave privada) não podem estar numa linha adicionada.
- `prText`: o título e o corpo do PR saem daqui. `#123`, `Fixes/Closes #n` e `@menção` são neutralizados.
- `logSafe`: o que vem do agente e vai para o log perde `::` e quebras de linha.

## Regras do fluxo

1. O agente só lê e edita. Não tem terminal, rede, tarefas, MCP, comandos nem leitura de `.git`, `.claude`, `.github`, `/proc`.
2. O Claude Code é instalado **antes** de a chave existir, com `--ignore-scripts`, e roda com `--bare` e `--setting-sources ""`: nenhum `settings.json`, hook ou `CLAUDE.md` do repositório vale.
3. O job só roda para o ator configurado em `AUTOFIX_ACTOR` (o App `mike-autofix`); sem a variável, não roda.
4. O PR sai como **rascunho**, de uma branch `auto-fix/*`, e **nunca é mesclado automaticamente**: `main` exige revisão e CI, sem bypass para o App.
5. O CI normal não usa segredo nem `pull_request_target` (há um teste que garante isso).
6. Mexer neste diretório ou no workflow é mudança de segurança: precisa de revisão do Braid e do Quill.

## O que não foi exercitado

O agente de verdade (`claude --bare ...` contra o gateway) não roda sem o App e sem a chave. Os testes cobrem as guardas, as propriedades do workflow, e a geração do patch a partir de um repositório novo (arquivo alterado, novo, binário e removido; hooks e filtros plantados em `.git` do agente não rodam).
