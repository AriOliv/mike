import { describe, expect, it } from "vitest";
import {
    agentConfigForBot,
    DEFAULT_SETTINGS,
    DISCLAIMER,
    FIXED_ESCALATIONS,
    mayAsk,
    parseSettings,
    settingsFromRow,
    withinHours,
} from "../legalAgent.settings";

const valid = () => ({
    enabled: true,
    display_name: "  Assistente do Jurídico ",
    persona: " Sou o assistente. ",
    tone: "direto",
    hours: { timezone: "America/Sao_Paulo", days: [5, 1, 1, 3], start: "08:30", end: "19:00", outside: "so_registra" },
    permissions: [
        { area: "Comercial", kinds: ["nda", "contrato_novo", "nda"] },
        { area: "Produto", kinds: [] },
    ],
    escalation: { risk_levels: ["alto"], kinds: ["parecer"], low_confidence: false, escalate_to_email: " Head@Avenia.io " },
    proactive: { deadline_days: [7, 30, 15, 7], renewals: false, radar: true, digest_time: "" },
});

describe("parseSettings", () => {
    it("normalizes a full form", () => {
        const result = parseSettings(valid());
        expect(result).toEqual({
            ok: true,
            value: {
                enabled: true,
                display_name: "Assistente do Jurídico",
                persona: "Sou o assistente.",
                tone: "direto",
                hours: { timezone: "America/Sao_Paulo", days: [1, 3, 5], start: "08:30", end: "19:00", outside: "so_registra" },
                permissions: [
                    { area: "Comercial", kinds: ["nda", "contrato_novo"] },
                    { area: "Produto", kinds: [] },
                ],
                escalation: { risk_levels: ["alto"], kinds: ["parecer"], low_confidence: false, escalate_to_email: "head@avenia.io" },
                proactive: { deadline_days: [30, 15, 7], renewals: false, radar: true, digest_time: "" },
            },
        });
    });

    it.each([
        [null, "Envie as configurações do agente."],
        [{ ...valid(), enabled: "sim" }, "Diga se o agente está ligado ou desligado."],
        [{ ...valid(), display_name: " " }, "Dê um nome ao agente."],
        [{ ...valid(), display_name: "x".repeat(61) }, "O nome do agente pode ter até 60 caracteres."],
        [{ ...valid(), persona: 3 }, "Descreva como o agente se apresenta."],
        [{ ...valid(), persona: "x".repeat(2001) }, "A descrição do agente pode ter até 2000 caracteres."],
        [{ ...valid(), tone: "rude" }, "Escolha o tom: formal, cordial ou direto."],
        [{ ...valid(), hours: null }, "Informe o horário de atendimento."],
        [{ ...valid(), hours: { ...valid().hours, days: [] } }, "Escolha pelo menos um dia de atendimento."],
        [{ ...valid(), hours: { ...valid().hours, days: [8] } }, "Escolha pelo menos um dia de atendimento."],
        [{ ...valid(), hours: { ...valid().hours, days: "seg" } }, "Escolha pelo menos um dia de atendimento."],
        [{ ...valid(), hours: { ...valid().hours, start: "8h" } }, "Use o formato HH:MM no horário de atendimento."],
        [{ ...valid(), hours: { ...valid().hours, end: 18 } }, "Use o formato HH:MM no horário de atendimento."],
        [{ ...valid(), hours: { ...valid().hours, start: "19:00", end: "08:00" } }, "O horário de início tem de ser antes do fim."],
        [{ ...valid(), hours: { ...valid().hours, timezone: "Marte/Olympus" } }, "Fuso horário desconhecido."],
        [{ ...valid(), hours: { ...valid().hours, timezone: 3 } }, "Fuso horário desconhecido."],
        [{ ...valid(), hours: { ...valid().hours, outside: "ignora" } }, "Diga o que o agente faz fora do horário."],
        [{ ...valid(), permissions: {} }, "Informe quem pode pedir o quê."],
        [{ ...valid(), permissions: [{ area: "", kinds: [] }] }, "Cada regra de permissão precisa de uma área."],
        [{ ...valid(), permissions: ["Comercial"] }, "Cada regra de permissão precisa de uma área."],
        [
            { ...valid(), permissions: [{ area: "Comercial", kinds: [] }, { area: "comercial", kinds: [] }] },
            "A área comercial aparece duas vezes.",
        ],
        [{ ...valid(), permissions: [{ area: "Comercial", kinds: ["tudo"] }] }, "Tipo de pedido desconhecido na área Comercial."],
        [{ ...valid(), permissions: [{ area: "Comercial", kinds: "nda" }] }, "Tipo de pedido desconhecido na área Comercial."],
        [{ ...valid(), escalation: [] }, "Informe quando o agente passa para uma pessoa."],
        [{ ...valid(), escalation: { ...valid().escalation, risk_levels: ["enorme"] } }, "Nível de risco desconhecido na regra de escalada."],
        [{ ...valid(), escalation: { ...valid().escalation, kinds: ["x"] } }, "Tipo de pedido desconhecido na regra de escalada."],
        [{ ...valid(), escalation: { ...valid().escalation, low_confidence: 1 } }, "Diga se o agente escala quando não tem certeza."],
        [{ ...valid(), escalation: { ...valid().escalation, escalate_to_email: "head" } }, "O e-mail de quem recebe as escaladas não é válido."],
        [{ ...valid(), escalation: { ...valid().escalation, escalate_to_email: null } }, "O e-mail de quem recebe as escaladas não é válido."],
        [{ ...valid(), proactive: "sim" }, "Informe os avisos que o agente dá sozinho."],
        [{ ...valid(), proactive: { ...valid().proactive, deadline_days: [0] } }, "Os avisos de prazo vão de 1 a 180 dias antes."],
        [{ ...valid(), proactive: { ...valid().proactive, deadline_days: null } }, "Os avisos de prazo vão de 1 a 180 dias antes."],
        [{ ...valid(), proactive: { ...valid().proactive, radar: "sim" } }, "Diga se o agente avisa renovações e mudanças regulatórias."],
        [{ ...valid(), proactive: { ...valid().proactive, renewals: null } }, "Diga se o agente avisa renovações e mudanças regulatórias."],
        [{ ...valid(), proactive: { ...valid().proactive, digest_time: "8" } }, "Use o formato HH:MM no horário do resumo diário."],
        [{ ...valid(), proactive: { ...valid().proactive, digest_time: 8 } }, "Use o formato HH:MM no horário do resumo diário."],
    ])("refuses %j with a sentence", (input, detail) => {
        expect(parseSettings(input)).toEqual({ ok: false, detail });
    });

    it("accepts an empty escalation e-mail: the queue receives it", () => {
        const result = parseSettings({ ...valid(), escalation: { ...valid().escalation, escalate_to_email: "" } });
        expect(result.ok && result.value.escalation.escalate_to_email).toBe("");
    });
});

describe("settingsFromRow", () => {
    it("starts from safe defaults: off, an assistant, deadlines at 30/15/7", () => {
        expect(settingsFromRow(null)).toBe(DEFAULT_SETTINGS);
        expect(DEFAULT_SETTINGS).toMatchObject({ enabled: false, display_name: "Assistente do Legal" });
        expect(DEFAULT_SETTINGS.proactive.deadline_days).toEqual([30, 15, 7]);
    });

    it("fills what a stored row lacks", () => {
        const s = settingsFromRow({
            enabled: true,
            display_name: "",
            persona: "",
            tone: "gritante",
            hours: { start: "10:00" },
            permissions: "x",
            escalation: null,
            proactive: { radar: false },
            updated_at: "2026-10-21T00:00:00Z",
        });
        expect(s.enabled).toBe(true);
        expect(s.display_name).toBe("Assistente do Legal");
        expect(s.persona).toBe(DEFAULT_SETTINGS.persona);
        expect(s.tone).toBe("cordial");
        expect(s.hours).toEqual({ ...DEFAULT_SETTINGS.hours, start: "10:00" });
        expect(s.permissions).toEqual([]);
        expect(s.escalation).toEqual(DEFAULT_SETTINGS.escalation);
        expect(s.proactive.radar).toBe(false);
        expect(s.updated_at).toBe("2026-10-21T00:00:00Z");
        const kept = settingsFromRow({ display_name: "Jurídico", persona: "p", tone: "formal", permissions: [{ area: "A", kinds: [] }], updated_at: 1 });
        expect(kept).toMatchObject({ enabled: false, display_name: "Jurídico", persona: "p", tone: "formal", updated_at: null });
        expect(kept.permissions).toHaveLength(1);
    });
});

describe("agentConfigForBot", () => {
    it("gives the bot its persona, hours, permissions and every escalation, the fixed ones first", () => {
        const config = agentConfigForBot(
            {
                ...DEFAULT_SETTINGS,
                enabled: true,
                permissions: [{ area: "Comercial", kinds: ["nda"] }],
                escalation: { risk_levels: ["critico"], kinds: ["parecer"], low_confidence: true, escalate_to_email: "head@x.io" },
            },
            { kind: "slack", name: "Avenia" },
        );
        expect(config).toMatchObject({
            ativo: true,
            nome: "Assistente do Legal",
            tom: "cordial",
            horario: { tz: "America/Sao_Paulo", dias: ["seg", "ter", "qua", "qui", "sex"], inicio: "09:00", fim: "18:00" },
            permissoes_por_area: [{ area: "Comercial", pode_pedir: ["nda"] }],
            escalar_para: "head@x.io",
            aviso: DISCLAIMER,
            proativo: { avisos_de_prazo_dias: [30, 15, 7], max_lembretes: 2, renovacoes: true, radar: true, resumo_diario: "08:00" },
            canal_atual: { kind: "slack", name: "Avenia" },
        });
        expect(config.escalada.slice(0, FIXED_ESCALATIONS.length).every((e) => e.fixa)).toBe(true);
        expect(config.escalada.slice(FIXED_ESCALATIONS.length).map((e) => e.regra)).toEqual([
            "Risco critico",
            "Pedido do tipo parecer",
            "Quando não tiver certeza da resposta",
        ]);
        const quiet = agentConfigForBot({
            ...DEFAULT_SETTINGS,
            escalation: { risk_levels: [], kinds: [], low_confidence: false, escalate_to_email: "" },
            proactive: { ...DEFAULT_SETTINGS.proactive, digest_time: "" },
        });
        expect(quiet).toMatchObject({ escalar_para: null, canal_atual: null, proativo: { resumo_diario: null } });
        expect(quiet.escalada).toHaveLength(FIXED_ESCALATIONS.length);
    });

    it("never offers the agent to sign, send out or accept risk", () => {
        expect(FIXED_ESCALATIONS.join(" ")).toMatch(/Assinar.*Enviar.*Aceitar um risco/s);
    });
});

describe("mayAsk and withinHours", () => {
    it("lets anyone ask anything until rules exist, then only what the area may", () => {
        expect(mayAsk(DEFAULT_SETTINGS, null, "nda")).toBe(true);
        const ruled = { ...DEFAULT_SETTINGS, permissions: [{ area: "Comercial", kinds: ["nda" as const] }] };
        expect(mayAsk(ruled, "comercial", "nda")).toBe(true);
        expect(mayAsk(ruled, "Comercial", "parecer")).toBe(false);
        expect(mayAsk(ruled, "Produto", "nda")).toBe(false);
        expect(mayAsk(ruled, null, "nda")).toBe(false);
    });

    it("reads the hours in the agent's own time zone", () => {
        const hours = DEFAULT_SETTINGS.hours;
        // Wednesday 2026-10-21 12:00 UTC = 09:00 in São Paulo.
        expect(withinHours(hours, new Date("2026-10-21T12:00:00Z"))).toBe(true);
        expect(withinHours(hours, new Date("2026-10-21T11:59:00Z"))).toBe(false);
        expect(withinHours(hours, new Date("2026-10-21T21:00:00Z"))).toBe(false);
        // Saturday.
        expect(withinHours(hours, new Date("2026-10-24T15:00:00Z"))).toBe(false);
        expect(withinHours({ ...hours, days: [6] }, new Date("2026-10-24T15:00:00Z"))).toBe(true);
    });
});
