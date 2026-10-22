// Guardas do auto-fix (doc 13 §5, passo 3). Rodam FORA do agente, em passos que
// ele não consegue editar: o agente só mexe na pasta de trabalho; quem decide se
// o resultado vira PR são estes testes, que o diff não pode tocar.
//
// Sem dependências, para rodar em `node` puro no runner.

export const REL = /^REL-\d{4,}$/;
const MAX_REPRO = 6000;

/**
 * O que o `repository_dispatch` pode trazer: duas chaves, `rel` e `repro`,
 * e mais nada. Um payload com outra chave, outro tipo ou tamanho fora do
 * limite é recusado inteiro: o texto nem chega ao agente.
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
    // O repro é Markdown de texto: sem HTML, sem imagem, sem link, sem bloco de código que simule instrução do sistema.
    if (/<[a-z!/][^>]*>/i.test(repro)) return { ok: false, reason: "contém HTML" };
    if (/!\[[^\]]*\]\([^)]*\)|\[[^\]]*\]\([^)]*\)/.test(repro)) return { ok: false, reason: "contém link ou imagem" };
    if (/\b(?:https?:\/\/|www\.)\S+/i.test(repro)) return { ok: false, reason: "contém URL" };
    return { ok: true, rel: payload.rel, repro };
}

/** Caminhos que o auto-fix nunca altera, por maior que seja a vontade do agente. */
const DENIED = [
    /^\.github\//,
    /^\.gitleaks\.toml$/,
    /^\.gitignore$/,
    /^\.claude\//,
    /(^|\/)CODEOWNERS$/,
    /(^|\/)\.env(\.|$)/,
    /(^|\/)package-lock\.json$/,
    /(^|\/)bun\.lock$/,
    /^docs\/product\/migrations-reservadas\.md$/,
    /^backend\/migrations\//,
    /^backend\/schema\.sql$/,
    /^infra\//,
    /(^|\/)Dockerfile[^/]*$/,
    /(^|\/)(?:id_rsa|.*\.pem|.*\.key)$/,
];

export const LIMITS = { files: 15, lines: 600 };

/**
 * @param {{ path: string, added: number, removed: number, status?: string }[]} changes  o diff
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
        if (path.includes("..") || path.startsWith("/")) reasons.push("caminho fora do repositório");
        else if (DENIED.some((re) => re.test(path))) reasons.push(`mexe em arquivo protegido (${path.split("/")[0]})`);
        if (c.status === "R" || c.status === "C") reasons.push("renomeia ou copia arquivo");
    }
    return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/**
 * O caminho de destino de uma linha do numstat. O git escreve renomeações como
 * `a/{velho => novo}/b` ou `velho => novo`; vale sempre o lado novo.
 */
export function renamedTo(raw) {
    const braces = /^(.*)\{(.*?) => (.*?)\}(.*)$/.exec(raw);
    if (braces) return `${braces[1]}${braces[3]}${braces[4]}`.replace(/\/\//g, "/");
    const plain = /^(.*) => (.*)$/.exec(raw);
    return plain ? plain[2] : raw;
}

/** `git diff --numstat` + `--name-status` em uma lista de mudanças. */
export function parseDiff(numstat, nameStatus) {
    const status = new Map();
    for (const line of String(nameStatus).split("\n")) {
        const m = /^([A-Z])\d*\t(.+?)(?:\t(.+))?$/.exec(line);
        if (m) status.set(m[3] ?? m[2], m[1]);
    }
    const out = [];
    for (const line of String(numstat).split("\n")) {
        const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
        if (!m) continue;
        const path = renamedTo(m[3]);
        out.push({ path, added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]), status: status.get(path) ?? "M" });
    }
    return out;
}

/** O título e o corpo do PR: só o repro e a referência, nunca nada vindo do agente. */
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
            repro,
        ].join("\n"),
    };
}
