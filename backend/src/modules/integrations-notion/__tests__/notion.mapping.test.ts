import { describe, expect, it } from "vitest";
import {
    normalize,
    parseFieldMap,
    parseStageMap,
    readPage,
    suggestFieldMap,
    suggestStageMap,
    writePage,
    type BoardProperty,
    type MikeField,
} from "../notion.mapping";
import { BOARD } from "./notionFake";

const properties: BoardProperty[] = Object.entries(BOARD.properties).map(([name, p]) => ({ name, type: p.type }));
const all = new Set<MikeField>(["name", "lane", "status", "priority", "assignee", "deadline", "completed_at", "requester_name", "counterparty", "risk_level", "renewal", "contract_type", "project_id", "app_link"]);

describe("suggestFieldMap", () => {
    it("reads a typical legal board, preferring Responsável over Pessoa for the owner", () => {
        expect(suggestFieldMap(properties)).toEqual({
            Contrato: "name",
            Etapa: "lane",
            Progresso: "status",
            Prioridade: "priority",
            Responsável: "assignee",
            Prazo: "deadline",
            "Data de conclusão": "completed_at",
            Solicitante: "requester_name",
            Contraparte: "counterparty",
            Risco: "risk_level",
            Renovação: "renewal",
            Tipo: "contract_type",
            ProjectId: "project_id",
            "Abrir no app": "app_link",
        });
    });

    it("skips a property whose type does not fit, and uses each property once", () => {
        expect(suggestFieldMap([{ name: "Prazo", type: "rich_text" }, { name: "Name", type: "title" }])).toEqual({ Name: "name" });
        expect(normalize("  Data de Conclusão! ")).toBe("data de conclusao");
    });
});

describe("suggestStageMap", () => {
    it("maps known stages to lanes and keeps the others as a tag in Triagem", () => {
        expect(suggestStageMap(["Not started", "Revisão", "Done", "Processos", "Legal Estratégico"])).toEqual({
            "Not started": { lane: "entrada", tag: null },
            Revisão: { lane: "revisao", tag: null },
            Done: { lane: "arquivado", tag: null },
            Processos: { lane: "triagem", tag: "Processos" },
            "Legal Estratégico": { lane: "triagem", tag: "Legal Estratégico" },
        });
    });
});

describe("parseFieldMap and parseStageMap", () => {
    it("accepts a sound map and drops cleared rows", () => {
        expect(parseFieldMap({ Contrato: "name", Etapa: "lane", Pessoa: null, Documento: "" }, properties)).toEqual({
            ok: true,
            value: { Contrato: "name", Etapa: "lane" },
        });
    });

    it.each([
        [null, "Envie o mapeamento de campos."],
        [[], "Envie o mapeamento de campos."],
        [{ Inexistente: "name" }, "A base não tem a propriedade Inexistente."],
        [{ Contrato: "nome" }, "Campo do Mike desconhecido em Contrato."],
        [{ Contrato: "name", Prazo: "lane" }, "Prazo é do tipo date e não serve para Etapa."],
        [{ Contrato: "name", Etapa: "lane", Responsável: "assignee", Pessoa: "assignee" }, "Responsável está ligado a duas propriedades."],
        [{ Etapa: "lane" }, "Escolha a propriedade com o nome do contrato."],
        [{ Contrato: "name" }, "Escolha a propriedade com a etapa."],
    ])("refuses %j", (input, detail) => {
        expect(parseFieldMap(input, properties)).toEqual({ ok: false, detail });
    });

    it("needs a lane for every stage and trims tags", () => {
        expect(parseStageMap({ Revisão: { lane: "revisao" }, Processos: { lane: "triagem", tag: "  Processos  " } }, ["Revisão", "Processos"])).toEqual({
            ok: true,
            value: { Revisão: { lane: "revisao", tag: null }, Processos: { lane: "triagem", tag: "Processos" } },
        });
        expect(parseStageMap({ Revisão: { lane: "revisao" } }, ["Revisão", "Done"])).toEqual({ ok: false, detail: "Escolha a etapa do Mike para Done." });
        expect(parseStageMap({ Done: { lane: "fim" } }, ["Done"])).toMatchObject({ ok: false });
        expect(parseStageMap("x", [])).toEqual({ ok: false, detail: "Envie o mapeamento de etapas." });
    });
});

const fieldMap = suggestFieldMap(properties);
const stageMap = suggestStageMap(["Revisão", "Processos", "Done"]);

describe("readPage", () => {
    it("reads every mapped field into card terms", () => {
        const page = {
            Contrato: { type: "title", title: [{ plain_text: "Contrato " }, { plain_text: "Fictício" }] },
            Etapa: { type: "select", select: { name: "Processos" } },
            Progresso: { type: "select", select: { name: "Em andamento" } },
            Prioridade: { type: "select", select: { name: "Média" } },
            Responsável: { type: "people", people: [{ id: "n-user-1" }] },
            Prazo: { type: "date", date: { start: "2026-11-30T10:00:00.000Z" } },
            "Data de conclusão": { type: "date", date: null },
            Solicitante: { type: "rich_text", rich_text: [{ plain_text: "Área X" }] },
            Contraparte: { type: "rich_text", rich_text: [] },
            Risco: { type: "select", select: { name: "Risco crítico" } },
            Renovação: { type: "date", date: { start: "2027-01-01" } },
            Tipo: { type: "select", select: null },
            ProjectId: { type: "rich_text", rich_text: [{ plain_text: "p-1" }] },
            "Abrir no app": { type: "url", url: "http://localhost:3000/projects/p-1" },
        };
        expect(readPage(page, fieldMap, stageMap)).toEqual({
            name: "Contrato Fictício",
            lane: "triagem",
            notion_stage: "Processos",
            status: "em_andamento",
            priority: "media",
            assignee_ids: ["n-user-1"],
            deadline: "2026-11-30",
            completed_at: null,
            requester_name: "Área X",
            counterparty: null,
            risk_level: "critico",
            renewal: "2027-01-01",
            contract_type: null,
            project_id: "p-1",
            app_link: "http://localhost:3000/projects/p-1",
        });
    });

    it("tolerates missing, empty and unknown values", () => {
        const out = readPage(
            {
                Contrato: { type: "title", title: [] },
                Etapa: { type: "select", select: { name: "Fase nova" } },
                Progresso: { type: "status", status: null },
                Prioridade: { type: "select", select: { name: "Urgentíssima" } },
                Risco: { type: "select", select: null },
                Responsável: { type: "people" },
                "Abrir no app": { type: "url", url: null },
            },
            fieldMap,
            stageMap,
        );
        expect(out).toEqual({ status: null, priority: null, risk_level: null, assignee_ids: [], app_link: null });
        expect(readPage({}, { Fantasma: undefined }, stageMap)).toEqual({});
    });
});

describe("writePage", () => {
    it("writes back only the fields asked, with the original stage kept", () => {
        const props = writePage(
            {
                name: "Contrato Fictício",
                lane: "triagem",
                notion_stage: "Processos",
                status: "bloqueado",
                priority: "alta",
                assignee_notion_ids: ["n-user-1"],
                deadline: "2026-11-30",
                completed_at: null,
                requester_name: "Área X",
                counterparty: "Empresa Fictícia",
                risk_level: "medio",
                renewal: null,
                contract_type: "NDA",
                project_id: "p-1",
                app_link: "https://mike.example/projects/p-1",
            },
            fieldMap,
            stageMap,
            all,
        );
        expect(props).toMatchObject({
            Contrato: { title: [{ text: { content: "Contrato Fictício" } }] },
            Etapa: { select: { name: "Processos" } },
            Progresso: { select: { name: "Bloqueado" } },
            Prioridade: { select: { name: "Alta" } },
            Responsável: { people: [{ id: "n-user-1" }] },
            Prazo: { date: { start: "2026-11-30" } },
            "Data de conclusão": { date: null },
            Contraparte: { rich_text: [{ text: { content: "Empresa Fictícia" } }] },
            Risco: { select: { name: "Atenção" } },
            Renovação: { date: null },
            Tipo: { select: { name: "NDA" } },
            ProjectId: { rich_text: [{ text: { content: "p-1" } }] },
            "Abrir no app": { url: "https://mike.example/projects/p-1" },
        });
        expect(writePage({ counterparty: "X", name: "Y" }, fieldMap, stageMap, new Set<MikeField>(["counterparty"]))).toEqual({
            Contraparte: { rich_text: [{ text: { content: "X" } }] },
        });
    });

    it("falls back to the lane's plain option, and leaves empties empty", () => {
        expect(writePage({ lane: "revisao", notion_stage: "Sumiu" }, fieldMap, stageMap, all)).toMatchObject({ Etapa: { select: { name: "Revisão" } } });
        expect(writePage({ lane: "assinatura" }, fieldMap, stageMap, all)).not.toHaveProperty("Etapa");
        expect(writePage({}, fieldMap, stageMap, all)).toMatchObject({
            Progresso: { select: null },
            Prioridade: { select: null },
            Risco: { select: null },
            Responsável: { people: [] },
            Contraparte: { rich_text: [] },
            "Abrir no app": { url: null },
        });
        expect(writePage({}, fieldMap, stageMap, all)).not.toHaveProperty("Contrato");
    });
});
