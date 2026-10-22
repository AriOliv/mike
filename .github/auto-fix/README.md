# Auto-fix: o lado público

Este diretório só **recebe** um `repro.md` já aprovado e tenta abrir um PR. Ele nunca vê o relato original: toda a triagem e a reescrita ficam no repositório privado de feedback.

O dispatch traz duas chaves, `rel` (`REL-nnnn`) e `repro`. Qualquer outra coisa é recusada antes de chegar ao agente.

## As guardas (`guard.mjs`)

Rodam **fora do agente**, em passos que ele não edita, com o código vindo de `main`:

- `parsePayload`: formato estrito (só `rel` e `repro`), tamanho, sem HTML, link, imagem nem URL.
- `checkDiff`: no máximo 15 arquivos e 600 linhas, e nenhum caminho protegido (`.github/`, `.claude/`, ambiente, lockfiles, migrations, `schema.sql`, `infra/`, Dockerfile, chaves, `CODEOWNERS`). Renomear conta pelo caminho novo.
- `prText`: o título e o corpo do PR saem daqui (`Ref REL-nnnn` e o repro), nunca do agente.

## Regras do fluxo

1. O agente só edita arquivos. Não tem `git commit`, `git push`, `gh`, `curl`, rede nem ferramenta de teste.
2. Os testes rodam depois, num passo **sem nenhum segredo**.
3. O PR sai como **rascunho**, de uma branch `auto-fix/*`, pelo App `mike-autofix` (token de 1 hora, só neste repo), e **nunca é mesclado automaticamente**: a branch `main` exige revisão e CI, sem bypass para o App.
4. Mexer neste diretório ou no workflow é mudança de segurança: precisa de revisão do Braid e do dono da segurança.
