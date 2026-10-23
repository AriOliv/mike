// Guardas do auto-fix (doc 13 §5, passo 3). Rodam em jobs que o agente nunca
// toca, com o código vindo de `main`, e sobre o PATCH (texto), nunca sobre a
// pasta do agente. Nada que estas funções leem vem pronto do agente: o diff é
// recalculado aqui a partir do patch.
//
// Sem dependências, para rodar em `node` puro no runner.

export const REL = /^REL-\d{4,}$/;
const MAX_REPRO = 6000;

// Caracteres que escondem texto: controle, formatação invisível (Cf), tags
// U+E0000–E007F, separadores de linha/parágrafo, BOM e variation selectors.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]|\uDB40[\uDC00-\uDC7F]|\uD834[\uDD73-\uDD7A]/;

/**
 * O que o `repository_dispatch` pode trazer: duas chaves, `rel` e `repro`,
 * e mais nada. Qualquer coisa fora do formato é recusada inteira: o texto
 * nem chega ao agente.
 * @returns {{ ok: true, rel: string, repro: string } | { ok: false, reason: string }}
 */
export function parsePayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, reason: "payload ausente" };
    const keys = Object.keys(payload).sort();
    if (keys.length !== 2 || keys[0] !== "rel" || keys[1] !== "repro") return { ok: false, reason: "chaves inesperadas" };
    if (typeof payload.rel !== "string" || !REL.test(payload.rel)) return { ok: false, reason: "ID de relato inválido" };
    if (typeof payload.repro !== "string") return { ok: false, reason: "repro inválido" };
    const repro = payload.repro.replace(/\r\n/g, "\n").trim();
    if (repro.length < 40 || repro.length > MAX_REPRO) return { ok: false, reason: "tamanho do repro fora do limite" };
    if (INVISIBLE.test(repro)) return { ok: false, reason: "contém caractere invisível" };
    // Texto simples: sem HTML, imagem, link, URL, e-mail nem menção (@pessoa).
    if (/<[a-z!/][^>]*>/i.test(repro)) return { ok: false, reason: "contém HTML" };
    if (/!\[[^\]]*\]\([^)]*\)|\[[^\]]*\]\([^)]*\)/.test(repro)) return { ok: false, reason: "contém link ou imagem" };
    if (/\b(?:https?:\/\/|www\.)\S+/i.test(repro)) return { ok: false, reason: "contém URL" };
    if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(repro)) return { ok: false, reason: "contém e-mail" };
    if (/(^|[^\w`])@[A-Za-z0-9][\w-]{0,38}/.test(repro)) return { ok: false, reason: "contém menção" };
    return { ok: true, rel: payload.rel, repro };
}

/**
 * ALLOWLIST: o agente só mexe no código do app e nos testes dele. Todo o resto
 * (instalação, config, CI, deploy, banco, scripts) fica de fora por não estar aqui.
 */
const ALLOWED = [/^backend\/src\/.+\.(?:ts|tsx|json)$/, /^frontend\/src\/.+\.(?:ts|tsx|json|css)$/];

/**
 * Dentro de `src/` ainda há o que não é do agente: onde se decide quem pode o
 * quê, para onde o servidor fala, e que provedor de modelo recebe contrato.
 */
const SECURITY_AREAS = [
    /(^|\/)(?:egressProxy|blockedDestination|privateIp)\b/i,
    /(^|\/)lib\/mcp\//,
    /(^|\/)lib\/llm\//,
    /(^|\/)lib\/(?:access|permissions|authSession|authHandoff|contentAccess|manifestSigning|downloadTokens|audit|auditExport)\b/,
    /(^|\/)middleware\//,
    /(^|\/)modules\/auth\//,
    /(^|\/)modules\/mcp\//,
    /(^|\/)modules\/models\//,
    /(^|\/)modules\/feedback\//,
    /(^|\/)modules\/user\/user\.apiKeyStore/,
    /(^|\/)(?:sentryPrivacy|instrument|instrumentation)[^/]*\.ts$/,
    /(^|\/)(?:app|index|worker|workerRuntime|workerThread)\.ts$/,
    /(^|\/)supabase\//i,
    /\.(?:pem|key|p12|pfx|jks)$/,
];

export const LIMITS = { files: 15, lines: 600 };

/**
 * @param {{ path: string, added: number, removed: number, binary?: boolean, status?: string }[]} changes
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function checkDiff(changes) {
    const reasons = [];
    if (!Array.isArray(changes) || changes.length === 0) return { ok: false, reasons: ["nenhuma mudança"] };
    if (changes.length > LIMITS.files) reasons.push(`mais de ${LIMITS.files} arquivos`);
    const lines = changes.reduce((n, c) => n + (c.added || 0) + (c.removed || 0), 0);
    if (lines > LIMITS.lines) reasons.push(`mais de ${LIMITS.lines} linhas`);
    for (const c of changes) {
        const path = String(c.path ?? "");
        // O caminho vem do agente: vale só se for texto limpo e relativo.
        if (path.includes("\0") || INVISIBLE.test(path) || /["\\]/.test(path) || path.startsWith("/") || path.split("/").includes("..") || path.split("/").includes(".git")) {
            reasons.push("caminho suspeito");
            continue;
        }
        if (!ALLOWED.some((re) => re.test(path))) reasons.push("fora do código do app");
        else if (SECURITY_AREAS.some((re) => re.test(path))) reasons.push("área de segurança");
        if (c.status === "R" || c.status === "C") reasons.push("renomeia ou copia arquivo");
        if (c.status === "T") reasons.push("muda o tipo do arquivo (link simbólico)");
        if (c.binary) reasons.push("arquivo binário");
    }
    return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/**
 * O diff, recalculado do patch pelo git, no job que vai publicar (nada disto vem
 * pronto de quem rodou código do agente). `git apply --numstat -z` e
 * `--summary` não trazem o mesmo, então são duas listas: o numstat dá o caminho
 * e as linhas; o `--summary` (também com -z) dá criação, remoção, renomeação e modo.
 * Tudo separado por NUL: um nome com aspas, octal ou quebra de linha não escapa do parse.
 *
 * @param {string} numstatZ  saída de `git apply --numstat -z <patch>`
 * @param {string} summaryZ  saída de `git apply --summary -z <patch>`
 */
export function changesFromPatch(numstatZ, summaryZ = "") {
    const status = new Map();
    // --summary -z: "create mode 100644 path\0", "delete mode ...", "rename old => new (xx%)\0", "mode change 100644 => 100755 path\0"
    for (const entry of String(summaryZ).split("\0")) {
        const t = entry.trim();
        let m;
        if ((m = /^create mode \d+ (.+)$/.exec(t))) status.set(m[1], "A");
        else if ((m = /^delete mode \d+ (.+)$/.exec(t))) status.set(m[1], "D");
        else if ((m = /^mode change \d+ => \d+ (.+)$/.exec(t))) status.set(m[1], "T");
        else if ((m = /^(?:rename|copy) (.+) => (.+?)(?: \(\d+%\))?$/.exec(t))) status.set(m[2], "R");
    }
    const out = [];
    // numstat -z: "added\tremoved\tpath\0"; em renomeação "added\tremoved\t\0old\0new\0".
    const parts = String(numstatZ).split("\0");
    for (let i = 0; i < parts.length; i++) {
        const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i]);
        if (!m) continue;
        let path = m[3];
        let renamed = false;
        if (path === "") {
            renamed = true;
            path = parts[i + 2] ?? "";
            i += 2;
        }
        const binary = m[1] === "-" || m[2] === "-";
        out.push({
            path,
            added: binary ? 0 : Number(m[1]),
            removed: binary ? 0 : Number(m[2]),
            binary,
            status: renamed ? "R" : (status.get(path) ?? "M"),
        });
    }
    return out;
}

/**
 * O patch bruto, antes de ser aplicado. O diff por arquivo não mostra tudo o
 * que um patch faz: olhamos o texto também. Nada em `.git`, nada de link
 * simbólico (120000), de submódulo (160000), de executável (100755) nem de
 * mudança de modo; nenhum cabeçalho com aspas (o git cita nomes estranhos, e
 * aqui eles são recusados em vez de interpretados).
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function checkPatch(patch) {
    const reasons = [];
    const text = String(patch ?? "");
    if (!text.trim()) return { ok: false, reasons: ["patch vazio"] };
    if (INVISIBLE.test(text.replace(/\n/g, ""))) reasons.push("caractere invisível no patch");
    for (const line of text.split("\n")) {
        const header = /^(?:diff --git |--- |\+\+\+ |rename (?:from|to) |copy (?:from|to) |similarity index )/.test(line);
        if (!header) continue;
        if (line.includes('"') || line.includes("\\")) reasons.push("caminho com aspas ou escape");
        if (/(^|[ /])\.git(\/|$|\s)/.test(line)) reasons.push("toca .git");
    }
    if (/^(?:new|old) file mode 120000$/m.test(text) || /^index .* 120000$/m.test(text)) reasons.push("link simbólico");
    if (/^new file mode 100755$/m.test(text) || /^(?:new|old) mode \d+$/m.test(text)) reasons.push("arquivo executável ou mudança de modo");
    if (/^(?:new|old) (?:file )?mode 160000$/m.test(text) || /^index .* 160000$/m.test(text)) reasons.push("submódulo");
    if (/^GIT binary patch$/m.test(text) || /^Binary files /m.test(text)) reasons.push("arquivo binário");
    return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/** O valor de um segredo (a chave do gateway) não pode estar em nenhuma linha adicionada. */
export function leaksSecret(patch, secrets) {
    const added = String(patch)
        .split("\n")
        .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
        .join("\n");
    return secrets.some((s) => s && s.length >= 8 && added.includes(s));
}

/** Padrões de chave/token que nunca devem aparecer numa linha adicionada, mesmo sem saber o valor. */
export function looksLikeSecret(patch) {
    const added = String(patch)
        .split("\n")
        .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
        .join("\n");
    // Sem `\b` na chave privada: o texto começa por `-`, e `\b` não casa antes dele.
    return (
        /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(added) ||
        /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|mike_(?:pat|svc|oat|ort|cfm)_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/.test(added)
    );
}

/**
 * O título e o corpo do PR: só o repro e a referência. Nenhum "#123", "Fixes #n"
 * nem menção vira ligação no GitHub: o `#` ganha uma barra invertida invisível
 * ao Markdown (`\#`) e o `@` também.
 */
export function neutralize(text) {
    return String(text)
        .replace(/\b(fix(?:e[sd])?|close[sd]?|resolve[sd]?)\b(\s*:?\s*)(#\d+)/gi, (_, w, sp, n) => `${w}${sp}\\${n}`)
        .replace(/(^|[^\w\\])#(\d+)/g, "$1\\#$2")
        .replace(/(^|[^\w\\`])@([A-Za-z0-9])/g, "$1\\@$2");
}

export function prText(rel, repro) {
    return {
        title: `fix: ${rel} (correção sugerida automaticamente)`,
        body: [
            `Ref ${rel}`,
            "",
            "Correção sugerida por um agente a partir de um relato interno, reescrito sem dados de cliente. **Revisão humana obrigatória; este PR nunca é mesclado sozinho.**",
            "",
            "---",
            "",
            neutralize(repro),
        ].join("\n"),
    };
}

/** Uma mensagem de log que não deixa o texto do agente escapar para comandos do runner (`::`) nem quebrar linha. */
export function logSafe(text) {
    return String(text).replace(/::/g, ": :").replace(/[\r\n]+/g, " ").slice(0, 200);
}
