// A ponta que o workflow executa, sempre com o código de `main`. Nunca imprime o repro
// nem repete texto vindo do agente sem passar por `logSafe`.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { changesFromPatch, checkDiff, checkPatch, leaksSecret, logSafe, looksLikeSecret, parsePayload, prText } from "./guard.mjs";

const out = (k, v) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${logSafe(v)}\n`);
const mode = process.argv[2];

if (mode === "payload") {
    const r = parsePayload(JSON.parse(process.env.PAYLOAD_JSON ?? "null"));
    if (!r.ok) {
        console.error(`payload recusado: ${logSafe(r.reason)}`);
        process.exit(1);
    }
    // O repro vai para um arquivo; o prompt do agente lê o arquivo. Nada de repro em linha de comando.
    writeFileSync(process.env.REPRO_OUT, `${r.repro}\n`);
    out("rel", r.rel);
} else if (mode === "diff") {
    // PATCH, NUMSTAT_Z e SUMMARY_Z vêm de `git apply` rodado AQUI, sobre o patch baixado: nada
    // do que está em RUNNER_TEMP foi escrito por quem rodou código do agente.
    const patch = readFileSync(process.env.PATCH, "utf8");
    const p = checkPatch(patch);
    const changes = changesFromPatch(readFileSync(process.env.NUMSTAT_Z, "utf8"), readFileSync(process.env.SUMMARY_Z, "utf8"));
    const d = checkDiff(changes);
    const keys = (process.env.SECRETS_TO_REFUSE ?? "").split("\n");
    const leaked = leaksSecret(patch, keys) || looksLikeSecret(patch);
    const reasons = [...p.reasons, ...d.reasons, ...(leaked ? ["segredo no patch"] : [])];
    const ok = p.ok && d.ok && !leaked;
    console.log(ok ? `diff aprovado (${changes.length} arquivo(s))` : `diff recusado: ${logSafe(reasons.join("; "))}`);
    process.exit(ok ? 0 : 2);
} else if (mode === "pr") {
    const t = prText(process.env.REL, readFileSync(process.env.REPRO_FILE, "utf8").trim());
    writeFileSync(process.env.TITLE_OUT, t.title);
    writeFileSync(process.env.BODY_OUT, t.body);
} else {
    console.error("modo desconhecido");
    process.exit(1);
}
