// O workflow decide quem vê o quê. Estes testes leem o YAML como texto e garantem as
// propriedades de segurança que a revisão pediu, para que uma edição descuidada não as
// desfaça sem o CI reclamar.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const wf = readFileSync(new URL("../../workflows/auto-fix.yml", import.meta.url), "utf8");
const job = (name) => {
    const start = wf.indexOf(`\n  ${name}:\n`);
    assert.ok(start >= 0, `job ${name}`);
    const rest = wf.slice(start + 1);
    const next = rest.slice(1).search(/\n  [a-z-]+:\n/);
    return next < 0 ? rest : rest.slice(0, next + 1);
};
const noComments = (t) => t.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

test("são dois jobs, e o verify não existe mais: nada que o agente escreve roda no repositório", () => {
    const names = [...wf.matchAll(/^  ([a-z-]+):$/gm)].map((m) => m[1]).filter((n) => ["agent", "verify", "publish"].includes(n));
    assert.deepEqual(names, ["agent", "publish"]);
    assert.ok(!/^  verify:/m.test(wf));
    assert.match(job("publish"), /needs: agent/);
    // nada que o agente escreveu é instalado, compilado ou testado aqui: os testes rodam no CI do PR
    assert.ok(!/npm (ci|install|test|run)|npx |vitest/.test(noComments(job("publish")).replace(/npm install --global[^\n]*/g, "")));
    assert.ok(!/vitest/.test(noComments(job("agent"))));
});

test("toda chamada ao gateway pede a redação das mensagens, no env do workflow", () => {
    assert.match(wf, /ANTHROPIC_CUSTOM_HEADERS: "x-litellm-enable-message-redaction: true"/);
    assert.ok(wf.indexOf("ANTHROPIC_CUSTOM_HEADERS") < wf.indexOf("\njobs:"), "o header está no env do workflow, e vale para todo job");
});

test("a chave do gateway tem o nome combinado e só aparece no job do agente", () => {
    assert.ok(!wf.includes("secrets.LITELLM_API_KEY"));
    assert.match(job("agent"), /secrets\.LITELLM_AUTOFIX_KEY/);
    assert.ok(!job("publish").includes("LITELLM"), "a chave nunca entra no job que tem o token do App");
});

test("o agente só lê e edita arquivos: sem Bash, sem rede, sem tarefas, configuração fixada", () => {
    const agent = noComments(job("agent"));
    // o cliente só oferece Read e Edit (Edit também cria arquivo novo); provado numa bancada local
    assert.match(agent, /--tools "Read,Edit"/);
    assert.match(agent, /--bare/);
    assert.match(agent, /--setting-sources ""/);
    assert.match(agent, /--settings "\$RUNNER_TEMP\/agent\/settings\.json"/);
    assert.match(agent, /--strict-mcp-config/);
    assert.match(agent, /--disable-slash-commands/);
    assert.match(agent, /--permission-mode dontAsk/);
    assert.ok(!/--allowedTools[^\n]*Bash/.test(agent), "nenhuma permissão de Bash");
    // o settings.json é gerado por um passo Python: o deny começa pelas ferramentas que o agente nunca pode ter
    const deny = agent.slice(agent.indexOf("deny = ["), agent.indexOf("allow = ["));
    for (const tool of ["Bash", "WebFetch", "WebSearch", "Task", "NotebookEdit", "Grep", "Glob"]) assert.ok(deny.includes(`"${tool}"`), `${tool} no deny`);
    const allow = agent.slice(agent.indexOf("allow = ["), agent.indexOf("with open(os.environ"));
    for (const tool of ["Bash", "WebFetch", "WebSearch", "Task", "Grep", "Glob", "Write"]) assert.ok(!allow.includes(`"${tool}`), `${tool} fora do allow`);
    for (const denied of ["Edit(./.git/**)", "Edit(./.claude/**)", "Edit(./.github/**)"]) assert.ok(agent.includes(`"${denied}"`), denied);
    // O passo que escreve o settings.json monta os caminhos absolutos de $HOME e $RUNNER_TEMP DE VERDADE (duas
    // barras: com uma só a regra é relativa e não bloqueia nada), em vez de supor /home/runner.
    for (const root of ["proc", "sys", "etc", "run", "var", "root"]) {
        assert.ok(agent.includes(`"Read(//${root}/**)"`), `Read(//${root}/**)`);
        assert.ok(!agent.includes(`"Read(/${root}/**)"`), `/${root} com uma barra só não bloqueia`);
    }
    // o que há de sensível DENTRO do HOME e do runner, nomeado (decisão do Legal Manager e do Quill)
    for (const sensitive of [".ssh/**", ".config/**", ".gitconfig", ".netrc", ".aws/**", ".docker/**", ".npmrc", ".npm/**", ".cache/**"]) {
        assert.ok(agent.includes(`f"Read({home}/${sensitive})"`), `HOME/${sensitive}`);
    }
    assert.ok(agent.includes('f"Read({temp}/**)"'), "RUNNER_TEMP (settings, prompt e repro do runner)");
    assert.match(agent, /HOME_DENY="\/\$HOME" TEMP_DENY="\/\$RUNNER_TEMP"/);
    // /home e /tmp NÃO são negados inteiros: o diretório de trabalho do runner mora em /home/runner/work, e negá-lo cega o agente
    assert.ok(!agent.includes('"Read(//home/**)"') && !agent.includes('"Read(//tmp/**)"'), "negar /home ou /tmp inteiros bloquearia o próprio código");
    // dentro do diretório de trabalho o padrão é LER o que não está no deny: os sensíveis do checkout são nomeados
    for (const inside of ["./.git/**", "./.claude/**", "./.github/**", "./**/.env", "./**/.env.*", "./**/*.pem", "./**/*.key", "./**/.npmrc", "./**/.netrc"]) {
        assert.ok(agent.includes(`"Read(${inside})"`), `work/${inside}`);
    }
    // Grep e Glob: negados e fora do allow (verificado acima, no settings.json que o passo gera)
    // edita só o código do app
    assert.match(agent, /"Edit\(\.\/backend\/src\/\*\*\)"/);
    assert.ok(!/"Edit\(\.\/\*\*\)"/.test(agent));
    // o repro vive em work/REPRO.md (fora do patch), e só ele é lido fora de src
    assert.match(agent, /cp "\$RUNNER_TEMP\/repro\.md" work\/REPRO\.md/);
    assert.match(agent, /"Read\(\.\/REPRO\.md\)"/);
    assert.match(agent, /Corrija o bug descrito em REPRO\.md/);
    assert.ok(!/RUNNER_TEMP\/repro\.md\. Esse/.test(agent), "o agente não é mandado ler fora do diretório de trabalho");
});

test("o Claude Code é instalado antes de o segredo existir, sem scripts de instalação", () => {
    const agent = job("agent");
    const install = agent.indexOf("npm install --global --ignore-scripts @anthropic-ai/claude-code@2.1.309");
    assert.ok(install > 0);
    assert.ok(install < agent.indexOf("LITELLM_AUTOFIX_KEY"), "instala antes do passo que recebe a chave");
});

test("o valor da chave é recusado no job do agente, onde a chave existe, antes de o patch sair", () => {
    const agent = noComments(job("agent"));
    assert.match(agent, /KEY_TO_REFUSE: \$\{\{ secrets\.LITELLM_AUTOFIX_KEY \}\}/);
    assert.match(agent, /grep -F -q -- "\$KEY_TO_REFUSE"/);
    assert.ok(agent.indexOf("Recusar patch que contém a chave") < agent.indexOf("upload-artifact"), "a recusa vem antes do upload");
    assert.ok(agent.indexOf("Exportar o patch") < agent.indexOf("Recusar patch que contém a chave"), "e depois de gerar o patch");
    // sem a chave para comparar, recusa (não deixa passar)
    assert.match(agent, /sem a chave para conferir: recusado/);
});

test("o job do agente não tem token do GitHub, e nenhum git roda sobre a pasta do agente", () => {
    const agent = noComments(job("agent"));
    assert.ok(!agent.includes("create-github-app-token"));
    assert.ok(!agent.includes("AUTOFIX_APP"));
    // `git` só aparece no repositório NOVO (tmprepo) e nunca com cd na pasta work.
    const gitLines = agent.split("\n").filter((l) => /\bg(it)? (add|diff|status|commit|init|config|apply)\b/.test(l) || /\bgit -c\b/.test(l));
    assert.ok(gitLines.length > 0);
    assert.ok(!/working-directory: work[\s\S]{0,200}git /.test(agent.slice(agent.indexOf("Exportar o patch"))), "o passo do patch não roda git em work");
    assert.match(agent, /cd "\$RUNNER_TEMP\/tmprepo"/);
    assert.match(agent, /core\.symlinks=false/);
    assert.match(agent, /find "work\/\$tree" -type l/);
});

test("só o job final tem o token do App, e ele não executa nada que o agente escreveu", () => {
    assert.match(job("publish"), /create-github-app-token/);
    assert.ok(!noComments(job("agent")).includes("create-github-app-token"));
    const publish = noComments(job("publish"));
    assert.ok(!/npm (ci|install|test|run)|npx |vitest/.test(publish), "publish não instala nem testa o código do agente");
    // o gitleaks roda sobre as linhas adicionadas do patch, com binário verificado por sha256
    assert.match(publish, /GITLEAKS_SHA256: [0-9a-f]{64}/);
    assert.match(publish, /sha256sum -c -/);
    assert.match(publish, /gitleaks" detect --no-banner --redact --no-git --source/);
    assert.ok(publish.indexOf("gitleaks\" detect") < publish.indexOf("create-github-app-token"), "o gitleaks roda antes de o token existir");
    assert.match(publish, /core\.hooksPath=\/dev\/null/);
    assert.match(publish, /core\.fsmonitor=false/);
    assert.match(publish, /commit --no-verify/);
    assert.ok(publish.indexOf("run-guard.mjs diff") < publish.indexOf("create-github-app-token"), "as guardas rodam antes de o token existir");
});

test("o job final RECALCULA o diff do patch e não lê numstat nem summary prontos", () => {
    const publish = noComments(job("publish"));
    assert.match(publish, /apply --numstat -z "\$PATCH" > "\$NUMSTAT_Z"/);
    assert.match(publish, /apply --summary -z "\$PATCH" > "\$SUMMARY_Z"/);
    // o artifact só leva o patch e o repro: nada de numstat/summary vindo do agente
    const upload = job("agent").slice(job("agent").indexOf("upload-artifact"));
    assert.ok(!/numstat|namestatus|summary/.test(upload));
    assert.match(upload, /auto-fix\.patch/);
    // o artifact leva só o patch: o repro NÃO vai (o publish usa o do evento)
    assert.ok(!/repro\.md/.test(upload.split("retention-days")[0]), "o repro não vai no artifact");
});

test("o publish revalida o payload do EVENTO, não do artifact, e re-testa o ID antes da branch", () => {
    const publish = noComments(job("publish"));
    assert.match(publish, /PAYLOAD_JSON: \$\{\{ toJson\(github\.event\.client_payload\) \}\}/);
    assert.match(publish, /run-guard\.mjs payload/);
    // o ID e o repro do PR vêm do passo que validou, nunca de needs.agent.outputs nem do artifact
    assert.ok(!/needs\.agent\.outputs\.rel/.test(publish), "o ID não vem de output do job do agente");
    assert.match(publish, /REL: \$\{\{ steps\.payload\.outputs\.rel \}\}/);
    assert.match(publish, /REPRO_FILE: \$\{\{ runner\.temp \}\}\/repro\.validated\.md/);
    assert.ok(!/in\/repro\.md/.test(publish), "o repro do artifact não é usado");
    // o ID é testado de novo logo antes de virar nome de branch e mensagem de commit
    const last = publish.slice(publish.indexOf("Empurrar a branch"));
    assert.match(last, /grep -Eq '\^REL-\[0-9\]\{4,\}\$'/);
    assert.ok(last.indexOf("grep -Eq") < last.indexOf("branch=\"auto-fix"));
});

test("o PR é montado pelas guardas, em rascunho", () => {
    const publish = noComments(job("publish"));
    assert.match(publish, /run-guard\.mjs pr/);
    assert.match(publish, /--draft/);
    assert.ok(!/Fixes #/.test(wf));
});

test("a pasta do agente nunca é exportada: só o patch", () => {
    const upload = job("agent").slice(job("agent").indexOf("upload-artifact"));
    assert.ok(!/work\//.test(upload.split("retention-days")[0]), "o artifact não inclui a pasta work");
    assert.match(job("publish"), /Código limpo de main/);
});

test("o git deste workflow não lê configuração de ninguém", () => {
    assert.match(wf, /GIT_CONFIG_GLOBAL: \/dev\/null/);
    assert.match(wf, /GIT_CONFIG_SYSTEM: \/dev\/null/);
    assert.match(wf, /GIT_CONFIG_NOSYSTEM: "1"/);
});

test("as guardas do publish são o código de main, em checkout separado, e rodam antes do token", () => {
    for (const j of ["publish"]) {
        assert.match(job(j), /run-guard\.mjs diff/);
        assert.match(job(j), /ref: main\n\s+path: guard/);
    }
});

test("todas as ações estão fixadas por SHA, nada persiste credencial, e só o App configurado dispara", () => {
    for (const m of wf.matchAll(/uses: ([^\s]+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, m[1]);
    assert.ok(!/persist-credentials: true/.test(wf));
    // só o App configurado dispara, e sem a variável o job não roda
    assert.match(job("agent"), /if: vars\.AUTOFIX_ACTOR != '' && github\.actor == vars\.AUTOFIX_ACTOR/);
});

test("o CI normal não usa segredo nem pull_request_target: o PR do App roda sem segredo", () => {
    const dir = new URL("../../workflows/", import.meta.url);
    for (const name of readdirSync(dir)) {
        if (!name.endsWith(".yml") || name.startsWith("auto-fix")) continue;
        const text = readFileSync(new URL(name, dir), "utf8");
        assert.ok(!/pull_request_target/.test(text), `${name} usa pull_request_target`);
        const secrets = [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]).filter((n) => n !== "GITHUB_TOKEN");
        assert.deepEqual(secrets, [], `${name} usa segredo(s): ${secrets.join(", ")}`);
    }
});
