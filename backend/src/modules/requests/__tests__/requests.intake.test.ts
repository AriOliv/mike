// The intake checklist: the generic and the organization's own list, the
// requester answering and confirming, the agent reading the contract (only
// with a literal quote, never over a person's answer), and closing it.
// Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, uuid } from "./memoryDb";

const llm = vi.hoisted(() => ({ completeText: vi.fn() }));
vi.mock("../../../lib/llm", () => llm);
const settings = vi.hoisted(() => ({
    getUserModelSettings: vi.fn(async (): Promise<Record<string, unknown>> => ({ tabular_model: "test-model", last_selected_chat_model: null, api_keys: {} })),
}));
vi.mock("../../user/user.service", () => settings);
const enqueue = vi.hoisted(() => ({ enqueueDbJob: vi.fn(async () => ({ id: "job", deduped: false })) }));
vi.mock("../../../lib/dbq/enqueue", () => enqueue);
const text = vi.hoisted(() => ({
    read: vi.fn((_args: Record<string, unknown>): unknown => null),
}));

import { NonRetryableJobError } from "../../../lib/dbq/runner";
import {
    answerIntake,
    createRequest,
    DEFAULT_INTAKE_TEMPLATE,
    getIntake,
    getIntakeTemplate,
    handleIntakePrefill,
    intakeForAnalysis,
    parsePrefill,
    searchContracts,
    setIntakeTemplate,
} from "../requests.service";
import { cleanIntake } from "../../contract-review/contractReview.analysisService";
import { parseTermsInferred } from "../requests.prefill";
import { readDate, readMonths } from "../requests.terms";
import { applicableItems, applyAnswers, DEFAULT_KIND_QUESTIONS, intakeStatus, mergeInferred, normalizeAnswer, parseIntakeTemplate, readAnswers } from "../requests.intake";

const ORG = "11111111-1111-4111-8111-111111111111";
const HEAD = { userId: "aaaaaaaa-0000-4000-8000-000000000001", userEmail: "head@avenia.io" };
const ANALYST = { userId: "aaaaaaaa-0000-4000-8000-000000000002", userEmail: "duda@avenia.io" };
const REQUESTER = { userId: "bbbbbbbb-0000-4000-8000-000000000001", userEmail: "ana@avenia.io" };
const STRANGER = { userId: "bbbbbbbb-0000-4000-8000-000000000009", userEmail: "x@avenia.io" };

const CONTRACT = `CONTRATO DE PRESTAÇÃO DE SERVIÇOS
Contratante: Exemplo Pagamentos Ltda. Contratada: Nuvem Fictícia S.A.
Cláusula 3. O valor mensal é de R$ 12.000,00 (doze mil reais), pago todo dia 10.
Cláusula 7. As partes trocarão informações confidenciais sobre clientes, que a Contratada não poderá divulgar.
Cláusula 9. A Contratada tratará dados pessoais de clientes da Contratante apenas conforme as instruções desta.
Cláusula 12. Vigência a partir de 1º de novembro de 2026.`;

function world(extra: Record<string, Record<string, unknown>[]> = {}) {
    let number = 0;
    return memoryDb(
        {
            legal_teams: [{ org_id: ORG, sla_days: {}, auto_assign: false, intake_template: [], created_at: "2026-01-01" }],
            org_members: [
                { org_id: ORG, user_id: HEAD.userId, role: "owner", created_at: "2026-01-01" },
                { org_id: ORG, user_id: ANALYST.userId, role: "member", created_at: "2026-01-02" },
            ],
            user_profiles: [
                { user_id: HEAD.userId, email: "head@avenia.io", display_name: "Marina" },
                { user_id: ANALYST.userId, email: "duda@avenia.io", display_name: "Duda" },
                { user_id: REQUESTER.userId, email: "ana@avenia.io", display_name: "Ana" },
            ],
            ...extra,
        },
        {
            defaults: {
                legal_requests: () => {
                    number += 1;
                    const now = new Date().toISOString();
                    return {
                        number,
                        status: "novo",
                        paused_at: null,
                        paused_seconds: 0,
                        assignee_id: null,
                        assigned_at: null,
                        summary: null,
                        triage: null,
                        delivery: null,
                        delivered_at: null,
                        source: { channel: "form" },
                        intake: {},
                        intake_completed_at: null,
                        critical_alert_at: null,
                        idempotency_key: null,
                        created_at: now,
                        updated_at: now,
                    };
                },
                card_events: () => ({ at: new Date().toISOString() }),
                legal_request_notifications: () => ({ status: "pending", attempts: 0, created_at: new Date().toISOString() }),
                legal_request_messages: () => ({ created_at: new Date().toISOString() }),
                legal_request_participants: () => ({ revoked_at: null, created_at: new Date().toISOString() }),
            },
            rpc: {
                read_document_text: (args) => text.read(args),
                create_project_with_memory: (args, tables) => {
                    const row = { id: uuid(), user_id: args.p_user_id, name: args.p_name, org_id: args.p_org_id };
                    (tables.projects ??= []).push(row);
                    return row;
                },
            },
        },
    );
}


async function newRequest(w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) {
    const r = await createRequest(w.db, REQUESTER, { kind: "revisao", counterparty: "Nuvem Fictícia S.A.", context: "Contrato de nuvem.", ...extra });
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.data.request.id;
}

function withDocument(w: ReturnType<typeof world>, requestId: string) {
    const req = w.table("legal_requests").find((r) => r.id === requestId)!;
    w.table("documents").push({
        id: "d0000000-0000-4000-8000-000000000001",
        project_id: req.project_id,
        current_version_id: "v1",
        archived_at: null,
        created_at: "2026-10-20T10:00:00Z",
    });
}

/** A valid answer for every question of the generic checklist, by kind. */
const BASE_KEYS = DEFAULT_KIND_QUESTIONS.revisao.map((q) => q.key);
const BASE_ITEMS = DEFAULT_INTAKE_TEMPLATE.filter((i) => BASE_KEYS.includes(i.key));
const ALL_ANSWERS = Object.fromEntries(
    BASE_ITEMS.map((i) => [i.key, i.kind === "yes_no" ? "não" : i.kind === "date" ? "na assinatura" : "Validação técnica"]),
);

const REQUIRED = BASE_ITEMS.filter((i) => i.required).map((i) => i.key);
const ready = () => ({ revision: "r1", status: "ready", text: CONTRACT, textless_page_count: 0 });

beforeEach(() => {
    llm.completeText.mockReset();
    enqueue.enqueueDbJob.mockClear();
    text.read.mockReset();
    text.read.mockImplementation(ready);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("the checklist rules", () => {
    it("ships a generic checklist with no company names in it", () => {
        expect(DEFAULT_INTAKE_TEMPLATE.map((i) => i.key)).toEqual([
            "aprovacao",
            "contraparte",
            "empresa_signataria",
            "motivo_condicoes",
            "de_acordo",
            "inicio",
            "valor_recorrencia",
            "confidencial",
            "dados_pessoais",
            "quem_compartilha",
            "finalidade",
            "modelo",
            "contrato_original",
            "o_que_muda",
            "duvida",
        ]);
        expect(JSON.stringify(DEFAULT_INTAKE_TEMPLATE)).not.toMatch(/avenia|brla|founder/i);
    });

    it("checks an organization's checklist and explains what is wrong, in Portuguese", () => {
        expect(parseIntakeTemplate([{ key: "x", label: "X", kind: "text" }])).toMatchObject({ ok: true, items: [{ required: true }] });
        expect(parseIntakeTemplate("nope")).toEqual({ ok: false, detail: "Envie o checklist como uma lista de perguntas." });
        expect(parseIntakeTemplate([{ key: "Com Espaço", label: "X", kind: "text" }])).toMatchObject({ ok: false });
        expect(parseIntakeTemplate([null])).toMatchObject({ ok: false, detail: "A pergunta 1 está vazia." });
        expect(
            parseIntakeTemplate([
                { key: "a", label: "A", kind: "text" },
                { key: "a", label: "B", kind: "text" },
            ]),
        ).toMatchObject({ ok: false, detail: "Há duas perguntas com o mesmo identificador (pergunta 2)." });
        expect(parseIntakeTemplate([{ key: "a", label: "", kind: "text" }])).toMatchObject({ detail: "Escreva o texto da pergunta 1." });
        expect(parseIntakeTemplate([{ key: "a", label: "A", kind: "cor" }])).toMatchObject({ detail: "Escolha o tipo de resposta da pergunta 1." });
        expect(parseIntakeTemplate(Array.from({ length: 21 }, (_, i) => ({ key: `k${i}`, label: "x", kind: "text" })))).toMatchObject({ ok: false });
        expect(
            parseIntakeTemplate([{ key: "a", label: "A", kind: "yes_no", detail_label: "Quem?", hint: "dica", required: false }]),
        ).toMatchObject({ ok: true, items: [{ detail_label: "Quem?", hint: "dica", required: false }] });
    });

    it("normalizes yes/no, dates and text answers", () => {
        const yn = DEFAULT_INTAKE_TEMPLATE.find((i) => i.key === "confidencial")!;
        expect(normalizeAnswer(yn, "sim", "A contraparte")).toEqual({
            ok: true,
            answer: { choice: "sim", value: "Sim. A contraparte", detail: "A contraparte" },
        });
        expect(normalizeAnswer(yn, false)).toEqual({ ok: true, answer: { choice: "nao", value: "Não" } });
        expect(normalizeAnswer(yn, "talvez")).toMatchObject({
            ok: false,
            detail: "Responda sim ou não em “Há compartilhamento de informação confidencial?”.",
        });
        const date = DEFAULT_INTAKE_TEMPLATE.find((i) => i.key === "inicio")!;
        expect(normalizeAnswer(date, "logo")).toMatchObject({ ok: false });
        expect(normalizeAnswer(date, "Na assinatura")).toMatchObject({ ok: true });
        expect(normalizeAnswer(date, "01/11/2026")).toMatchObject({ ok: true });
        expect(normalizeAnswer(DEFAULT_INTAKE_TEMPLATE[0], "  ")).toMatchObject({ ok: false });
    });

    it("never lets an inference overwrite a person's answer, and confirms inferred ones on request", () => {
        const t = [...DEFAULT_INTAKE_TEMPLATE];
        const now = "2026-10-22T12:00:00Z";
        const given = applyAnswers(t, {}, { answers: { contraparte: "Nuvem" } }, now);
        if (!given.ok) throw new Error("apply");
        const merged = mergeInferred(
            t,
            given.answers,
            { contraparte: { value: "Outra", quote: "x" }, inicio: { value: "1º/11/2026", quote: "Vigência" } },
            now,
        );
        expect(merged.filled).toEqual(["inicio"]);
        expect(merged.answers.contraparte).toMatchObject({ value: "Nuvem", source: "requester", confirmed: true });
        expect(merged.answers.inicio).toMatchObject({ source: "inferred", confirmed: false, quote: "Vigência" });

        expect(applyAnswers(t, merged.answers, { confirm: ["inicio"] }, now)).toMatchObject({ ok: true, changed: ["inicio"] });
        expect(applyAnswers(t, merged.answers, { confirm: ["contraparte"] }, now)).toMatchObject({ ok: true, changed: [] });
        expect(applyAnswers(t, merged.answers, { confirm: ["aprovacao"] }, now)).toMatchObject({ ok: false });
        expect(applyAnswers(t, merged.answers, { answers: { bogus: "x" } }, now)).toMatchObject({ ok: false });
        expect(applyAnswers(t, merged.answers, { confirm: ["bogus"] }, now)).toMatchObject({ ok: false });

        const status = intakeStatus(t, merged.answers);
        expect(status).toMatchObject({ complete: false, answered: 1, to_confirm: ["inicio"] });
        expect(status.pending).toContain("inicio");
        expect(intakeForAnalysis(t, merged.answers)).toEqual([
            { key: "contraparte", label: "Nome da contraparte", value: "Nuvem", source: "requester" },
            { key: "inicio", label: "Previsão de início", value: "1º/11/2026", source: "inferred" },
        ]);
    });

    it("keeps an inferred answer only with a quote that is literally in the contract", () => {
        const t = [...DEFAULT_INTAKE_TEMPLATE];
        const raw = JSON.stringify({
            answers: {
                valor_recorrencia: { value: "R$ 12.000,00 por mês", quote: "O valor mensal é de R$ 12.000,00 (doze mil reais)" },
                contraparte: { value: "Nuvem", quote: "uma frase que não existe no contrato" },
                inicio: { value: "1º/11/2026", quote: "" },
                bogus: { value: "x", quote: "Contratante" },
                confidencial: { value: "Sim", quote: "trocarão   informações confidenciais", choice: "sim" },
            },
        });
        const { inferred, dropped } = parsePrefill("```json\n" + raw + "\n```", t, CONTRACT);
        expect(Object.keys(inferred).sort()).toEqual(["confidencial", "valor_recorrencia"]);
        expect(inferred.confidencial.choice).toBe("sim");
        expect(dropped).toBe(2);
        expect(parsePrefill("not json", t, CONTRACT)).toEqual({ inferred: {}, dropped: 0, unparsed: true });
    });

    it("keeps the whole answers of a reply cut off mid-way, and says when nothing was readable", () => {
        const t = [...DEFAULT_INTAKE_TEMPLATE];
        const whole = JSON.stringify({
            answers: {
                contraparte: { value: "Nuvem Fictícia S.A.", quote: "Contratada: Nuvem Fictícia S.A.", choice: null },
                valor_recorrencia: { value: "R$ 12.000,00 por mês", quote: "O valor mensal é de R$ 12.000,00 (doze mil reais)", choice: null },
                inicio: { value: "1º/11/2026", quote: "Vigência a partir de 1º de novembro de 2026.", choice: null },
            },
        });
        // Out of room inside the third answer: the first two are whole, with a "}" in a value too.
        const cut = whole.slice(0, whole.indexOf('"inicio"') + 30);
        const parsed = parsePrefill(cut.replace("Nuvem Fictícia S.A.\"", "Nuvem Fictícia S.A. {sic}\""), t, CONTRACT);
        expect(Object.keys(parsed.inferred).sort()).toEqual(["contraparte", "valor_recorrencia"]);
        expect(parsed.unparsed).toBe(false);
        expect(parsePrefill('{"answers": {"contraparte": {"value": "Nu', t, CONTRACT)).toEqual({ inferred: {}, dropped: 0, unparsed: true });
        expect(parsePrefill('{"resposta": "nada"}', t, CONTRACT)).toEqual({ inferred: {}, dropped: 0, unparsed: false });
    });

    it("matches a quote across what a Word file writes differently: soft hyphens, dashes, invisible spaces", () => {
        const t = [...DEFAULT_INTAKE_TEMPLATE];
        const docx = "CONTRATANTE: EXEMPLO PAGA\u00adMENTOS LTDA.\u200b — inscrita no CNPJ 00.000.000/0001-00";
        const raw = JSON.stringify({ answers: { contraparte: { value: "Exemplo Pagamentos Ltda.", quote: "EXEMPLO PAGAMENTOS LTDA. - inscrita" } } });
        expect(parsePrefill(raw, t, docx)).toMatchObject({ inferred: { contraparte: { value: "Exemplo Pagamentos Ltda." } }, dropped: 0 });
    });
});

describe("the checklist on a request", () => {
    it("starts with the generic list, takes answers given on the form, and hides it from outsiders", async () => {
        const w = world();
        const id = await newRequest(w, { intake: { contraparte: "Nuvem Fictícia S.A.", de_acordo: "sim" } });
        const mine = await getIntake(w.db, REQUESTER, id);
        expect(mine).toMatchObject({ ok: true, data: { template_source: "padrao", answered: 2, total: 9, complete: false, can_answer: true } });
        if (!mine.ok) return;
        expect(mine.data.pending).toEqual(REQUIRED.filter((k) => k !== "contraparte" && k !== "de_acordo"));
        expect(await getIntake(w.db, STRANGER, id)).toMatchObject({ ok: false, kind: "not_found" });
        // Nothing attached: no contract to read.
        expect(enqueue.enqueueDbJob).not.toHaveBeenCalledWith(w.db, expect.objectContaining({ kind: "request.intake_prefill" }));
    });

    it("closes once every required item is confirmed, and logs it once", async () => {
        const w = world();
        const id = await newRequest(w);
        const answers: Record<string, unknown> = {
            aprovacao: "Diretoria comercial",
            contraparte: "Nuvem Fictícia S.A.",
            empresa_signataria: "Exemplo Pagamentos Ltda.",
            motivo_condicoes: "Hospedagem do sistema; R$ 12 mil por mês.",
            de_acordo: true,
            inicio: "01/11/2026",
            valor_recorrencia: "R$ 12.000,00 mensais",
            confidencial: { value: "sim", detail: "As duas partes" },
        };
        const partial = await answerIntake(w.db, REQUESTER, id, { answers });
        expect(partial).toMatchObject({ ok: true, data: { complete: false, pending: ["dados_pessoais"], completed_at: null } });
        const done = await answerIntake(w.db, REQUESTER, id, { answers: { dados_pessoais: "não" } });
        expect(done).toMatchObject({ ok: true, data: { complete: true, completed_at: "2026-10-22T12:00:00.000Z" } });
        expect(w.table("card_events").filter((e) => String(e.action).startsWith("intake.")).map((e) => e.action)).toEqual([
            "intake.answered",
            "intake.completed",
        ]);
        // Changing an answer keeps it closed and does not log "completed" again.
        await answerIntake(w.db, REQUESTER, id, { answers: { inicio: "15/11/2026" } });
        expect(w.table("card_events").filter((e) => e.action === "intake.completed")).toHaveLength(1);
        expect(await answerIntake(w.db, REQUESTER, id, { answers: { de_acordo: "talvez" } })).toMatchObject({ ok: false, kind: "validation" });
        // Nothing new: nothing written.
        const before = w.table("card_events").length;
        expect(await answerIntake(w.db, REQUESTER, id, {})).toMatchObject({ ok: true });
        expect(w.table("card_events")).toHaveLength(before);
    });

    it("the team may answer for the requester; a stranger and a closed request may not", async () => {
        const w = world();
        const id = await newRequest(w);
        expect(await answerIntake(w.db, ANALYST, id, { answers: { contraparte: "Nuvem" } })).toMatchObject({ ok: true });
        expect(await answerIntake(w.db, STRANGER, id, { answers: { contraparte: "x" } })).toMatchObject({ ok: false, kind: "not_found" });
        w.table("legal_requests")[0].status = "cancelado";
        expect(await answerIntake(w.db, REQUESTER, id, { answers: { contraparte: "x" } })).toMatchObject({
            ok: false,
            kind: "conflict",
            detail: "Este pedido já foi encerrado.",
        });
    });
});

describe("the organization's own checklist", () => {
    it("only the Head replaces it; the team reads it; an empty list goes back to the generic one", async () => {
        const w = world();
        const own = [
            { key: "aprovacao_socio", label: "Algum sócio aprovou?", kind: "yes_no", detail_label: "Qual?" },
            { key: "contraparte", label: "Contraparte", kind: "text" },
        ];
        expect(await setIntakeTemplate(w.db, ANALYST, { items: own })).toMatchObject({ ok: false, kind: "forbidden" });
        expect(await setIntakeTemplate(w.db, REQUESTER, { items: own })).toMatchObject({ ok: false, kind: "forbidden" });
        expect(await setIntakeTemplate(w.db, HEAD, { items: [{ key: "a" }] })).toMatchObject({ ok: false, kind: "validation" });
        expect(await setIntakeTemplate(w.db, HEAD, { items: own })).toMatchObject({ ok: true, data: { source: "org" } });
        expect(await getIntakeTemplate(w.db, ANALYST)).toMatchObject({
            ok: true,
            data: { source: "org", items: [{ key: "aprovacao_socio" }, { key: "contraparte" }] },
        });
        expect(await getIntakeTemplate(w.db, REQUESTER)).toMatchObject({ ok: false, kind: "forbidden" });

        const id = await newRequest(w);
        expect(await getIntake(w.db, REQUESTER, id)).toMatchObject({ ok: true, data: { template_source: "org", total: 2 } });

        expect(await setIntakeTemplate(w.db, HEAD, { items: [] })).toMatchObject({ ok: true, data: { source: "padrao" } });
    });
});

describe("the intake agent", () => {
    it("is queued when the request comes with a contract", async () => {
        const w = world({
            documents: [
                {
                    id: "d0000000-0000-4000-8000-0000000000aa",
                    user_id: REQUESTER.userId,
                    project_id: null,
                    org_id: null,
                    workflow_id: null,
                    current_version_id: "v1",
                    archived_at: null,
                    created_at: "2026-10-22",
                },
            ],
        });
        await newRequest(w, { document_ids: ["d0000000-0000-4000-8000-0000000000aa"] });
        expect(enqueue.enqueueDbJob).toHaveBeenCalledWith(w.db, expect.objectContaining({ kind: "request.intake_prefill" }));
    });

    it("fills what the contract says, quoted, leaves the rest open, and logs it", async () => {
        const w = world();
        const id = await newRequest(w, { intake: { contraparte: "Nuvem (como a Ana escreveu)" } });
        withDocument(w, id);
        llm.completeText.mockResolvedValue(
            JSON.stringify({
                answers: {
                    valor_recorrencia: {
                        value: "R$ 12.000,00 por mês, dia 10",
                        quote: "O valor mensal é de R$ 12.000,00 (doze mil reais), pago todo dia 10.",
                    },
                    inicio: { value: "1º/11/2026", quote: "Vigência a partir de 1º de novembro de 2026." },
                    dados_pessoais: {
                        value: "Sim. A contratada trata dados de clientes conforme instruções.",
                        quote: "tratará dados pessoais de clientes",
                        choice: "sim",
                    },
                    aprovacao: { value: "Diretoria", quote: "inventado" },
                },
            }),
        );
        expect(await handleIntakePrefill(w.db, { payload: { request_id: id } })).toEqual({ filled: 3, terms: 0, dropped: 1 });
        // The model is asked only about what is still open, and reads as the team.
        const prompt = (llm.completeText.mock.calls[0][0] as { systemPrompt: string }).systemPrompt;
        expect(prompt).not.toContain('"contraparte"');
        expect(text.read).toHaveBeenCalledWith(expect.objectContaining({ p_user_id: HEAD.userId }));

        const intake = await getIntake(w.db, REQUESTER, id);
        if (!intake.ok) throw new Error("intake");
        expect(intake.data.items.find((i) => i.key === "contraparte")?.answer).toMatchObject({
            value: "Nuvem (como a Ana escreveu)",
            source: "requester",
        });
        expect(intake.data.items.find((i) => i.key === "inicio")).toMatchObject({
            state: "inferido",
            answer: { quote: "Vigência a partir de 1º de novembro de 2026." },
        });
        expect([...intake.data.to_confirm].sort()).toEqual(["dados_pessoais", "inicio", "valor_recorrencia"]);
        expect(w.table("card_events").at(-1)).toMatchObject({ action: "intake.prefilled", actor_type: "agent", after: { filled: 3 } });
        expect(w.table("agent_runs")[0]).toMatchObject({ agent: "intake", status: "succeeded" });
    });

    it("waits for the contract's text, gives up on an unreadable one, and skips what it should not do", async () => {
        const w = world();
        const id = await newRequest(w);
        expect(await handleIntakePrefill(w.db, { payload: { request_id: id } })).toEqual({ skipped: "no_document" });
        withDocument(w, id);
        text.read.mockImplementation(() => ({ revision: "r1", status: "processing", text: null, textless_page_count: null }));
        await expect(handleIntakePrefill(w.db, { payload: { request_id: id } })).rejects.toThrow("contract text not ready");
        text.read.mockImplementation(() => ({ revision: "r1", status: "failed", text: null, textless_page_count: null }));
        await expect(handleIntakePrefill(w.db, { payload: { request_id: id } })).rejects.toBeInstanceOf(NonRetryableJobError);
        w.table("legal_requests")[0].status = "entregue";
        expect(await handleIntakePrefill(w.db, { payload: { request_id: id } })).toEqual({ skipped: "closed" });
        expect(await handleIntakePrefill(w.db, { payload: { request_id: "nope" } })).toEqual({ skipped: "missing" });
    });

    it("says there is no model before waiting on the contract's text", async () => {
        const w = world();
        const id = await newRequest(w);
        withDocument(w, id);
        settings.getUserModelSettings.mockResolvedValueOnce({ tabular_model: null, last_selected_chat_model: null, api_keys: {} });
        text.read.mockImplementation(() => ({ revision: "r1", status: "processing", text: null, textless_page_count: null }));
        expect(await handleIntakePrefill(w.db, { payload: { request_id: id } })).toEqual({ skipped: "no_model" });
        expect(text.read).not.toHaveBeenCalled();
    });

    it("gives up at once when no model key is set, instead of retrying", async () => {
        const w = world();
        const id = await newRequest(w);
        withDocument(w, id);
        llm.completeText.mockRejectedValue(new Error("Anthropic API key is not configured. Set ANTHROPIC_API_KEY or add a user Anthropic key."));
        await expect(handleIntakePrefill(w.db, { payload: { request_id: id } })).rejects.toBeInstanceOf(NonRetryableJobError);
        llm.completeText.mockRejectedValue(new Error("socket hang up"));
        await expect(handleIntakePrefill(w.db, { payload: { request_id: id } })).rejects.not.toBeInstanceOf(NonRetryableJobError);
    });

    it("gives the model room for every answer and records an unreadable reply instead of a silent zero", async () => {
        const w = world();
        const id = await newRequest(w);
        withDocument(w, id);
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        llm.completeText.mockResolvedValue("Desculpe, não consigo.");
        expect(await handleIntakePrefill(w.db, { payload: { request_id: id } })).toEqual({ filled: 0, terms: 0, dropped: 0, unparsed: true });
        expect((llm.completeText.mock.calls[0][0] as { maxTokens: number }).maxTokens).toBeGreaterThanOrEqual(4000);
        expect(w.table("agent_runs").at(-1)).toMatchObject({ status: "succeeded", output: { filled: [], dropped: 0, unparsed: true } });
    });

    it("tells the checklist whether it is reading, done or unable to", async () => {
        const w = world();
        const id = await newRequest(w);
        const state = async () => {
            const r = await getIntake(w.db, REQUESTER, id);
            if (!r.ok) throw new Error("intake");
            return r.data.prefill;
        };
        expect(await state()).toBeNull();
        const job = (status: string, result: Record<string, unknown> | null, created_at: string) =>
            w.table("db_jobs").push({ id: uuid(), kind: "request.intake_prefill", dedupe_key: `intake-prefill:${id}`, status, result, created_at });
        job("running", null, "2026-10-22T10:00:00Z");
        expect(await state()).toBe("lendo");
        job("failed", null, "2026-10-22T10:01:00Z");
        expect(await state()).toBe("falhou");
        job("done", { skipped: "no_model" }, "2026-10-22T10:02:00Z");
        expect(await state()).toBe("falhou");
        job("done", { skipped: "no_document" }, "2026-10-22T10:03:00Z");
        expect(await state()).toBeNull();
        job("done", { filled: 2, dropped: 0 }, "2026-10-22T10:04:00Z");
        expect(await state()).toBe("concluido");
        const answered = await answerIntake(w.db, REQUESTER, id, { answers: { contraparte: "Nuvem" } });
        expect(answered.ok && answered.data.prefill).toBe("concluido");
    });
});

describe("the contract's terms read by the intake agent", () => {
    const WITH_TERMS = `${CONTRACT}
Cláusula 13. O prazo de vigência é de 24 (vinte e quatro) meses.
Cláusula 14. Contratada: Nuvem Fictícia S.A.`;
    const reply = (terms: Record<string, unknown>) => JSON.stringify({ answers: {}, terms });

    it("reads dates and terms the way a person writes them, and refuses what it cannot normalize", () => {
        expect(readDate("2026-11-12")).toBe("2026-11-12");
        expect(readDate("12/11/2026")).toBe("2026-11-12");
        expect(readDate("1º de novembro de 2026")).toBe("2026-11-01");
        expect(readDate("12 de Março de 2027")).toBe("2027-03-12");
        for (const bad of ["breve", "30/02/2026", "1 de novembr de 2026", "2026-13-01", ""]) expect(readDate(bad)).toBeNull();
        expect(readMonths("24")).toBe(24);
        expect(readMonths("12 meses")).toBe(12);
        expect(readMonths("2 anos")).toBe(24);
        expect(readMonths("1 mês")).toBe(1);
        for (const bad of ["indeterminado", "0", "700", "1,5 anos", "doze"]) expect(readMonths(bad)).toBeNull();
    });

    it("keeps a term only with the contract's own words behind it", () => {
        const read = parseTermsInferred(
            reply({
                counterparty: { value: "Nuvem Fictícia S.A.", quote: "Contratada: Nuvem Fictícia S.A." },
                term_start: { value: "1º de novembro de 2026", quote: "Vigência a partir de 1º de novembro de 2026." },
                term_months: { value: 24, quote: "prazo de vigência é de 24 (vinte e quatro) meses" },
            }),
            WITH_TERMS,
        );
        expect(read.dropped).toBe(0);
        expect(read.terms).toEqual({
            counterparty: { value: "Nuvem Fictícia S.A.", quote: "Contratada: Nuvem Fictícia S.A." },
            term_start: { value: "2026-11-01", quote: "Vigência a partir de 1º de novembro de 2026." },
            term_months: { value: "24", quote: "prazo de vigência é de 24 (vinte e quatro) meses" },
        });
    });

    it("drops a term with an invented quote, no quote, or a value it cannot read, and counts it", () => {
        const read = parseTermsInferred(
            reply({
                counterparty: { value: "Outra Empresa", quote: "trecho que não existe no contrato" },
                term_start: { value: "em breve", quote: "Vigência a partir de 1º de novembro de 2026." },
                term_months: { value: "24" },
            }),
            WITH_TERMS,
        );
        expect(read.terms).toEqual({});
        expect(read.dropped).toBe(3);
    });

    it("says nothing for a reply without terms, a broken one, or entries that are not objects", () => {
        expect(parseTermsInferred('{"answers": {}}', WITH_TERMS)).toEqual({ terms: {}, dropped: 0 });
        expect(parseTermsInferred("não sei", WITH_TERMS)).toEqual({ terms: {}, dropped: 0 });
        expect(parseTermsInferred(reply({ counterparty: "x", term_start: null, term_months: { value: "" } }), WITH_TERMS)).toEqual({ terms: {}, dropped: 0 });
    });

    it("stores them apart from what the requester typed, only where the form was left empty", async () => {
        const w = world();
        const id = await newRequest(w, { counterparty: "Nuvem (como a Ana escreveu)", term_months: 6 });
        withDocument(w, id);
        text.read.mockReturnValue({ revision: "r1", status: "ready", text: WITH_TERMS, textless_page_count: 0 });
        llm.completeText.mockResolvedValue(
            reply({
                counterparty: { value: "Nuvem Fictícia S.A.", quote: "Contratada: Nuvem Fictícia S.A." },
                term_start: { value: "2026-11-01", quote: "Vigência a partir de 1º de novembro de 2026." },
                term_months: { value: "24", quote: "prazo de vigência é de 24 (vinte e quatro) meses" },
            }),
        );
        const out = await handleIntakePrefill(w.db, { payload: { request_id: id } });
        expect(out).toMatchObject({ terms: 1 });
        const row = w.table("legal_requests").find((r) => r.id === id)!;
        // what the person typed is untouched; only the empty start was filled
        expect(row).toMatchObject({ counterparty: "Nuvem (como a Ana escreveu)", term_months: 6, term_start: null });
        expect(row.terms_inferred).toEqual({ term_start: { value: "2026-11-01", quote: "Vigência a partir de 1º de novembro de 2026." } });
    });

    it("still reads the terms when every checklist question is already answered", async () => {
        const w = world();
        const id = await newRequest(w);
        const answered = await answerIntake(w.db, REQUESTER, id, { answers: ALL_ANSWERS });
        expect(answered.ok && answered.data.complete).toBe(true);
        withDocument(w, id);
        text.read.mockReturnValue({ revision: "r1", status: "ready", text: WITH_TERMS, textless_page_count: 0 });
        llm.completeText.mockResolvedValue(reply({ term_months: { value: "24", quote: "prazo de vigência é de 24 (vinte e quatro) meses" } }));
        const out = await handleIntakePrefill(w.db, { payload: { request_id: id } });
        expect(out).toMatchObject({ terms: 1 });
        expect(w.table("legal_requests").find((r) => r.id === id)!.terms_inferred).toEqual({
            term_months: { value: "24", quote: "prazo de vigência é de 24 (vinte e quatro) meses" },
        });
    });

    it("does not call the model at all once the checklist and the terms are all in", async () => {
        const w = world();
        const id = await newRequest(w, { counterparty: "Nuvem", term_start: "2026-11-01", term_months: 12 });
        withDocument(w, id);
        const answered = await answerIntake(w.db, REQUESTER, id, { answers: ALL_ANSWERS });
        expect(answered.ok && answered.data.complete).toBe(true);
        llm.completeText.mockClear();
        expect(await handleIntakePrefill(w.db, { payload: { request_id: id } })).toEqual({ skipped: "answered" });
        expect(llm.completeText).not.toHaveBeenCalled();
    });
});

describe("questions by kind of request", () => {
    const keysFor = (kind: string) => applicableItems([...DEFAULT_INTAKE_TEMPLATE], "padrao", kind, {}).map((i) => i.key);

    it("asks an NDA its own questions, without value or commercial terms", () => {
        const nda = keysFor("nda");
        expect(nda).toEqual(expect.arrayContaining(["quem_compartilha", "finalidade", "modelo", "confidencial", "dados_pessoais", "inicio"]));
        expect(nda).not.toContain("valor_recorrencia");
        expect(nda).not.toContain("motivo_condicoes");
        expect(nda).not.toContain("de_acordo");
    });

    it("asks an amendment for the original contract and what changes, and a legal question only what it wants to know", () => {
        expect(keysFor("aditivo")).toEqual(expect.arrayContaining(["contrato_original", "o_que_muda", "valor_recorrencia"]));
        const parecer = applicableItems([...DEFAULT_INTAKE_TEMPLATE], "padrao", "parecer", {});
        expect(parecer.map((i) => [i.key, i.required])).toEqual([["duvida", true], ["contraparte", false]]);
        expect(keysFor("revisao")).toHaveLength(9);
        expect(keysFor("outro")).toEqual(["contraparte", "empresa_signataria", "motivo_condicoes"]);
    });

    it("leaves an organization's own checklist whole unless it sets a map", () => {
        const own = [{ key: "a", label: "A", kind: "text" as const, required: true }, { key: "b", label: "B", kind: "text" as const, required: true }];
        expect(applicableItems(own, "org", "nda", {}).map((i) => i.key)).toEqual(["a", "b"]);
        expect(applicableItems(own, "org", "nda", { nda: ["b"] }).map((i) => i.key)).toEqual(["b"]);
    });

    it("counts only the kind's questions, keeps the other answers, and tells when the kind changed", async () => {
        const w = world();
        const id = await newRequest(w);
        await answerIntake(w.db, REQUESTER, id, { answers: { valor_recorrencia: "R$ 1.000 por mês", contraparte: "Nuvem Fictícia S.A." } });
        w.table("legal_requests").find((r) => r.id === id)!.kind = "nda";
        const got = await getIntake(w.db, REQUESTER, id);
        if (!got.ok) throw new Error("no intake");
        expect(got.data.kind).toBe("nda");
        expect(got.data.kind_changed).toEqual({ from: "revisao", to: "nda" });
        expect(got.data.total).toBe(9);
        expect(got.data.items.map((i) => i.key)).not.toContain("valor_recorrencia");
        expect(got.data.pending).not.toContain("valor_recorrencia");
        // The answer to a question that stopped applying is still stored.
        expect(readAnswers(w.table("legal_requests").find((r) => r.id === id)!.intake).valor_recorrencia).toBeTruthy();
        // Answering once more clears the notice.
        const again = await answerIntake(w.db, REQUESTER, id, { answers: { aprovacao: "Diretoria" } });
        expect(again.ok && again.data.kind_changed).toBeNull();
    });

    it("closes an NDA's checklist without value and commercial terms, which starts the analysis", async () => {
        const w = world();
        const id = await newRequest(w, { kind: "nda" });
        const answers = {
            aprovacao: "Diretoria",
            contraparte: "Nuvem Fictícia S.A.",
            empresa_signataria: "Exemplo Pagamentos Ltda.",
            quem_compartilha: "ambos",
            finalidade: "Avaliar parceria",
            modelo: "nosso",
            confidencial: "sim",
            dados_pessoais: { value: "não sei", unknown: true },
            inicio: "na assinatura",
        };
        enqueue.enqueueDbJob.mockClear();
        const done = await answerIntake(w.db, REQUESTER, id, { answers });
        expect(done).toMatchObject({ ok: true, data: { complete: true, pending: [] } });
        expect(enqueue.enqueueDbJob).toHaveBeenCalledWith(w.db, expect.objectContaining({ kind: "request.analysis_start" }));
    });

    it("takes a pick from a list only from its options", async () => {
        const w = world();
        const id = await newRequest(w, { kind: "nda" });
        const bad = await answerIntake(w.db, REQUESTER, id, { answers: { quem_compartilha: "ninguém" } });
        expect(bad).toMatchObject({ ok: false, kind: "validation" });
        const good = await answerIntake(w.db, REQUESTER, id, { answers: { quem_compartilha: "ambos" } });
        expect(good.ok && good.data.items.find((i) => i.key === "quem_compartilha")?.answer).toMatchObject({ selected: ["ambos"], value: "Os dois" });
        const many = await answerIntake(w.db, REQUESTER, id, { answers: { quem_compartilha: ["nos", "eles"] } });
        expect(many).toMatchObject({ ok: false, kind: "validation" });
        const amend = await newRequest(w, { kind: "aditivo" });
        const multi = await answerIntake(w.db, REQUESTER, amend, { answers: { o_que_muda: ["prazo", "valor"] } });
        expect(multi.ok && multi.data.items.find((i) => i.key === "o_que_muda")?.answer).toMatchObject({ selected: ["prazo", "valor"], value: "Prazo, Valor" });
    });

    it("says there is nothing to fill when no question is required, and the legal question is its own required field", async () => {
        expect(intakeStatus([{ key: "x", label: "X", kind: "text", required: false }], {})).toMatchObject({ nothing_to_fill: true, complete: true });
        const w = world();
        const id = await newRequest(w, { kind: "parecer", counterparty: "" });
        const got = await getIntake(w.db, REQUESTER, id);
        expect(got).toMatchObject({ ok: true, data: { total: 2, pending: ["duvida"], nothing_to_fill: false, complete: false } });
        const noUnknown = await answerIntake(w.db, REQUESTER, id, { answers: { duvida: { unknown: true } } });
        expect(noUnknown).toMatchObject({ ok: false, kind: "validation" });
        const done = await answerIntake(w.db, REQUESTER, id, { answers: { duvida: "Podemos assinar sem testemunhas?" } });
        expect(done).toMatchObject({ ok: true, data: { complete: true } });
    });

    it("keeps 'não sei' explicit: counted as answered, marked for the analysis, never read from text", async () => {
        const w = world();
        const id = await newRequest(w, { kind: "nda" });
        const typed = await answerIntake(w.db, REQUESTER, id, { answers: { confidencial: "não sei" } });
        expect(typed).toMatchObject({ ok: false });
        const unknown = await answerIntake(w.db, REQUESTER, id, { answers: { dados_pessoais: { unknown: true } } });
        if (!unknown.ok) throw new Error("no answer");
        const item = unknown.data.items.find((i) => i.key === "dados_pessoais")!;
        expect(item).toMatchObject({ state: "confirmado", answer: { value: "Não sei", unknown: true } });
        const flat = intakeForAnalysis(unknown.data.items, readAnswers(w.table("legal_requests").find((r) => r.id === id)!.intake));
        expect(flat).toEqual([{ key: "dados_pessoais", label: expect.any(String), value: "Não sei", source: "requester", unknown: true }]);
        expect(cleanIntake(flat)).toEqual([expect.objectContaining({ key: "dados_pessoais", unknown: true })]);
        expect(cleanIntake([{ key: "a", label: "A", value: "x", unknown: "true" }])?.[0]).not.toHaveProperty("unknown");
    });

    it("only puts the kind's questions to the model, and keeps a pick only by its option codes", () => {
        const items = applicableItems([...DEFAULT_INTAKE_TEMPLATE], "padrao", "nda", {});
        const raw = JSON.stringify({
            answers: {
                modelo: { value: "nosso", quote: "Cláusula 3" },
                quem_compartilha: { value: "talvez", quote: "Cláusula 3" },
                valor_recorrencia: { value: "R$ 12.000,00", quote: "R$ 12.000,00" },
            },
        });
        const parsed = parsePrefill(raw, items, CONTRACT);
        expect(Object.keys(parsed.inferred)).toEqual(["modelo"]);
        expect(parsed.inferred.modelo.selected).toEqual(["nosso"]);
        const merged = mergeInferred(items, {}, parsed.inferred, "2026-10-23T00:00:00Z");
        expect(merged.answers.modelo).toMatchObject({ value: "Nosso", selected: ["nosso"], source: "inferred", confirmed: false });
    });

    it("lets the Head set which questions apply to each kind, and refuses a map that cites nothing", async () => {
        const w = world();
        const bad = await setIntakeTemplate(w.db, HEAD, { items: [], by_kind: { nda: ["nao_existe"] } });
        expect(bad).toMatchObject({ ok: false, kind: "validation" });
        const badKind = await setIntakeTemplate(w.db, HEAD, { items: [], by_kind: { inventado: ["aprovacao"] } });
        expect(badKind).toMatchObject({ ok: false, kind: "validation" });
        const set = await setIntakeTemplate(w.db, HEAD, { items: [], by_kind: { nda: ["aprovacao", "contraparte"] } });
        expect(set).toMatchObject({ ok: true, data: { by_kind: { nda: ["aprovacao", "contraparte"] } } });
        const id = await newRequest(w, { kind: "nda" });
        const got = await getIntake(w.db, REQUESTER, id);
        expect(got.ok && got.data.items.map((i) => i.key)).toEqual(["aprovacao", "contraparte"]);
    });
});

describe("the contract an amendment changes", () => {
    const PARENT = "cccccccc-0000-4000-8000-000000000001";
    const OTHER_ORG_CARD = "cccccccc-0000-4000-8000-000000000002";
    function withContracts() {
        const w = world({
            projects: [
                { id: PARENT, org_id: ORG, name: "Contrato de Nuvem 2025", counterparty: "Nuvem Fictícia S.A.", archived_at: null },
                { id: "cccccccc-0000-4000-8000-000000000003", org_id: ORG, name: "Licença de Software", counterparty: "Código Ágil Ltda.", archived_at: null },
                { id: "cccccccc-0000-4000-8000-000000000004", org_id: ORG, name: "Contrato antigo", counterparty: "Nuvem Fictícia S.A.", archived_at: "2026-01-01" },
                { id: OTHER_ORG_CARD, org_id: "22222222-2222-4222-8222-222222222222", name: "Contrato de Nuvem de outra org", counterparty: "Nuvem Outra", archived_at: null },
            ],
        });
        return w;
    }

    it("finds contracts by name or counterparty, accents aside, only of the team's org and not archived", async () => {
        const w = withContracts();
        const byName = await searchContracts(w.db, "licenca");
        expect(byName.ok && byName.data.contracts.map((c) => c.name)).toEqual(["Licença de Software"]);
        const byParty = await searchContracts(w.db, "nuvem fict");
        expect(byParty.ok && byParty.data.contracts.map((c) => c.id)).toEqual([PARENT]);
        expect(await searchContracts(w.db, "n")).toMatchObject({ ok: false, kind: "validation" });
    });

    it("ties the amendment to the picked contract, and 'não está no Mike' unties it", async () => {
        const w = withContracts();
        const id = await newRequest(w, { kind: "aditivo" });
        const tied = await answerIntake(w.db, REQUESTER, id, { answers: { contrato_original: { project_id: PARENT } } });
        expect(tied).toMatchObject({ ok: true, data: { parent_contract: { id: PARENT, name: "Contrato de Nuvem 2025" } } });
        expect(w.table("legal_requests").find((r) => r.id === id)!.parent_project_id).toBe(PARENT);
        expect(readAnswers(w.table("legal_requests").find((r) => r.id === id)!.intake).contrato_original).toMatchObject({ project_id: PARENT });
        const seen = await getIntake(w.db, REQUESTER, id);
        expect(seen.ok && seen.data.parent_contract?.id).toBe(PARENT);
        const typed = await answerIntake(w.db, REQUESTER, id, { answers: { contrato_original: "Não está no Mike, vou anexar" } });
        expect(typed).toMatchObject({ ok: true, data: { parent_contract: null } });
        expect(w.table("legal_requests").find((r) => r.id === id)!.parent_project_id).toBeNull();
    });

    it("refuses a contract that is archived, from another organization or not a card", async () => {
        const w = withContracts();
        const id = await newRequest(w, { kind: "aditivo" });
        for (const project_id of ["cccccccc-0000-4000-8000-000000000004", OTHER_ORG_CARD, "não-é-id"]) {
            const r = await answerIntake(w.db, REQUESTER, id, { answers: { contrato_original: { project_id } } });
            expect(r).toMatchObject({ ok: false, kind: "validation" });
        }
        expect(w.table("legal_requests").find((r) => r.id === id)!.parent_project_id ?? null).toBeNull();
    });

    it("does not leave the link when other questions are answered, and the agent never guesses the contract", async () => {
        const w = withContracts();
        const id = await newRequest(w, { kind: "aditivo" });
        await answerIntake(w.db, REQUESTER, id, { answers: { contrato_original: { project_id: PARENT } } });
        await answerIntake(w.db, REQUESTER, id, { answers: { aprovacao: "Diretoria" } });
        expect(w.table("legal_requests").find((r) => r.id === id)!.parent_project_id).toBe(PARENT);
        withDocument(w, id);
        llm.completeText.mockResolvedValue(JSON.stringify({ answers: { contrato_original: { value: "Contrato X", quote: "Cláusula 3" } } }));
        await handleIntakePrefill(w.db, { payload: { request_id: id } });
        expect(llm.completeText.mock.calls[0]?.[0]).toMatchObject({ systemPrompt: expect.not.stringContaining('"contrato_original"') });
    });
});
