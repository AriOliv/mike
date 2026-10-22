// A ponta que o workflow executa. Lê o payload e o diff do ambiente e escreve
// as saídas do job. Nunca imprime o repro.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { checkDiff, parseDiff, parsePayload, prText } from "./guard.mjs";

const out = (k, v) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${String(v).replace(/\n/g, " ")}\n`);
const mode = process.argv[2];

if (mode === "payload") {
    const r = parsePayload(JSON.parse(process.env.PAYLOAD_JSON ?? "null"));
    if (!r.ok) {
        console.error(`payload recusado: ${r.reason}`);
        process.exit(1);
    }
    // O repro vai para um arquivo; o prompt do agente lê o arquivo. Nada de repro em linha de comando.
    writeFileSync(process.env.REPRO_OUT, `${r.repro}\n`);
    out("rel", r.rel);
} else if (mode === "diff") {
    const changes = parseDiff(readFileSync(process.env.NUMSTAT, "utf8"), readFileSync(process.env.NAMESTATUS, "utf8"));
    const r = checkDiff(changes);
    out("ok", r.ok ? "true" : "false");
    out("note", r.reasons.join("; "));
    console.log(r.ok ? `diff aprovado (${changes.length} arquivo(s))` : `diff recusado: ${r.reasons.join("; ")}`);
    process.exit(r.ok ? 0 : 2);
} else if (mode === "pr") {
    const t = prText(process.env.REL, readFileSync(process.env.REPRO_FILE, "utf8").trim());
    writeFileSync(process.env.TITLE_OUT, t.title);
    writeFileSync(process.env.BODY_OUT, t.body);
} else {
    console.error("modo desconhecido");
    process.exit(1);
}
