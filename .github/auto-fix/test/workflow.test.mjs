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

test("são três jobs: agent, verify e publish", () => {
    for (const j of ["agent", "verify", "publish"]) assert.ok(job(j));
    assert.deepEqual([...wf.matchAll(/^  ([a-z-]+):$/gm)].map((m) => m[1]).filter((n) => ["agent", "verify", "publish"].includes(n)), ["agent", "verify", "publish"]);
    assert.match(job("verify"), /needs: agent/);
    assert.match(job("publish"), /needs: \[agent, verify\]/);
    assert.match(job("publish"), /needs\.verify\.result == 'success'/);
});

test("toda chamada ao gateway pede a redação das mensagens, no env do workflow", () => {
    assert.match(wf, /ANTHROPIC_CUSTOM_HEADERS: "x-litellm-enable-message-redaction: true"/);
    assert.ok(wf.indexOf("ANTHROPIC_CUSTOM_HEADERS") < wf.indexOf("\njobs:"), "o header está no env do workflow, e vale para todo job");
});

test("a chave do gateway tem o nome combinado e só aparece no job do agente", () => {
    assert.ok(!wf.includes("secrets.LITELLM_API_KEY"));
    assert.match(job("agent"), /secrets\.LITELLM_AUTOFIX_KEY/);
    assert.ok(!job("verify").includes("LITELLM"));
    assert.ok(!job("publish").includes("LITELLM"), "a chave nunca entra no job que tem o token do App");
});

test("o agente só lê e edita arquivos: sem Bash, sem rede, sem tarefas, configuração fixada", () => {
    const agent = noComments(job("agent"));
    assert.match(agent, /--tools "Read,Grep,Glob,Edit,Write"/);
    assert.match(agent, /--bare/);
    assert.match(agent, /--setting-sources ""/);
    assert.match(agent, /--settings "\$RUNNER_TEMP\/agent\/settings\.json"/);
    assert.match(agent, /--strict-mcp-config/);
    assert.match(agent, /--disable-slash-commands/);
    assert.match(agent, /--permission-mode dontAsk/);
    assert.ok(!/--allowedTools[^\n]*Bash/.test(agent), "nenhuma permissão de Bash");
    assert.match(agent, /"deny": \["Bash", "WebFetch", "WebSearch", "Task"/);
    for (const denied of ["Read(./.git/**)", "Read(./.claude/**)", "Read(/proc/**)", "Edit(./.git/**)", "Write(./.claude/**)", "Edit(./.github/**)"]) assert.ok(agent.includes(denied), denied);
    // edita só o código do app
    assert.match(agent, /"Edit\(\.\/backend\/src\/\*\*\)"/);
    assert.ok(!/"Edit\(\.\/\*\*\)"/.test(agent));
});

test("o Claude Code é instalado antes de o segredo existir, sem scripts de instalação", () => {
    const agent = job("agent");
    const install = agent.indexOf("npm install --global --ignore-scripts @anthropic-ai/claude-code@2.1.309");
    assert.ok(install > 0);
    assert.ok(install < agent.indexOf("LITELLM_AUTOFIX_KEY"), "instala antes do passo que recebe a chave");
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

test("o job de testes não tem segredo nem environment, e as guardas rodam antes do código do agente", () => {
    const verify = noComments(job("verify"));
    assert.ok(!verify.includes("secrets."));
    assert.ok(!verify.includes("environment:"));
    assert.ok(!verify.includes("create-github-app-token"));
    assert.ok(verify.indexOf("run-guard.mjs diff") < verify.indexOf("vitest run"), "o patch é checado antes de qualquer teste");
    assert.ok(verify.indexOf("run-guard.mjs diff") < verify.indexOf("npm ci"), "e antes de qualquer instalação");
    assert.match(verify, /npm ci --ignore-scripts/);
});

test("só o job final tem o token do App, e ele não executa nada que o agente escreveu", () => {
    assert.match(job("publish"), /create-github-app-token/);
    assert.ok(!noComments(job("agent")).includes("create-github-app-token"));
    assert.ok(!noComments(job("verify")).includes("create-github-app-token"));
    const publish = noComments(job("publish"));
    assert.ok(!/npm (ci|install|test|run)|npx |vitest/.test(publish), "publish não instala nem testa o código do agente");
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
});

test("o repro volta a ser validado e o PR é montado pelas guardas, em rascunho", () => {
    const publish = noComments(job("publish"));
    assert.match(publish, /run-guard\.mjs pr/);
    assert.match(publish, /--draft/);
    assert.ok(!/Fixes #/.test(wf));
});

test("a pasta do agente nunca é exportada: só o patch e o repro", () => {
    const upload = job("agent").slice(job("agent").indexOf("upload-artifact"));
    assert.ok(!/work\//.test(upload.split("retention-days")[0]), "o artifact não inclui a pasta work");
    for (const j of ["verify", "publish"]) assert.match(job(j), /Código limpo de main/);
});

test("o git deste workflow não lê configuração de ninguém", () => {
    assert.match(wf, /GIT_CONFIG_GLOBAL: \/dev\/null/);
    assert.match(wf, /GIT_CONFIG_SYSTEM: \/dev\/null/);
    assert.match(wf, /GIT_CONFIG_NOSYSTEM: "1"/);
});

test("as guardas rodam em verify e de novo em publish, sempre com o código de main", () => {
    for (const j of ["verify", "publish"]) {
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
