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
    setIntakeTemplate,
} from "../requests.service";
import { applyAnswers, intakeStatus, mergeInferred, normalizeAnswer, parseIntakeTemplate } from "../requests.intake";

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

const REQUIRED = DEFAULT_INTAKE_TEMPLATE.filter((i) => i.required).map((i) => i.key);
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
        expect(await handleIntakePrefill(w.db, { payload: { request_id: id } })).toEqual({ filled: 3, dropped: 1 });
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
        expect(await handleIntakePrefill(w.db, { payload: { request_id: id } })).toEqual({ filled: 0, dropped: 0, unparsed: true });
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
