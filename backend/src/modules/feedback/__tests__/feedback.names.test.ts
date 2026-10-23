// The backend's check of the base's names (doc 13 §5): the names stay in the cluster, only a
// verdict leaves, and any doubt is `sensitive`. All names here are made up.

import { describe, expect, it } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { mentionsAny, nameWords, namesVerdict, norm } from "../feedback.names";

const NAMES = ["Orion Participações S.A.", "Contrato de Prestação de Serviços - Maria Pereira.docx", "Pedido da Zeta Logística", null, ""];

describe("norm and nameWords", () => {
    it("drops accents and case", () => {
        expect(norm("Participações ÁGIL")).toBe("participacoes agil");
    });
    it("keeps the words that identify, and drops short, numeric, extension and generic ones", () => {
        const w = nameWords(NAMES);
        // "pedido", "contrato", "participações" and the like are common words: only the names stay.
        expect([...w].sort()).toEqual(["logistica", "maria", "orion", "pereira", "zeta"]);
    });
});

describe("mentionsAny", () => {
    it("finds a name regardless of accent, case or punctuation", () => {
        expect(mentionsAny("Era o pedido da ORION, urgente.", NAMES)).toBe(true);
        expect(mentionsAny("falei com a maria pereira ontem", NAMES)).toBe(true);
        expect(mentionsAny("A zeta logistica não aparece", NAMES)).toBe(true);
    });
    it("does not flag ordinary text or the generic words of a title", () => {
        expect(mentionsAny("O botão Salvar não responde no pedido de teste", NAMES)).toBe(false);
        expect(mentionsAny("o contrato de prestação de serviços falhou", NAMES)).toBe(false);
    });
    it("matches whole words, not pieces of them", () => {
        expect(mentionsAny("A orionização do pedido falhou", NAMES)).toBe(false);
        expect(mentionsAny("A Zetamax não aparece", NAMES)).toBe(false);
    });
    it("does not let a generic word in a file name flag every report that uses it", () => {
        const names = ["Pedido de Renovação - Contrato Alfa Energia.pdf", "Termo de Adesão.docx"];
        expect(mentionsAny("Ao clicar em Salvar no pedido de renovação a tela trava", names)).toBe(false);
        expect(mentionsAny("O termo de adesão não abre", names)).toBe(false);
        expect(mentionsAny("O arquivo da Alfa Energia some", names)).toBe(true);
    });
    it("finds a whole multi-word name", () => {
        expect(mentionsAny("Abri a Zeta Logística", ["Zeta Logística"])).toBe(true);
    });
});

describe("namesVerdict", () => {
    const org = "00000000-0000-4000-c000-000000000001";
    const script = (projects: unknown, documents: unknown, versions?: unknown) => [
        { table: "projects", data: projects },
        { table: "documents", data: documents },
        ...(versions !== undefined ? [{ table: "document_versions", data: versions }] : []),
    ];

    it("is names-clear when nothing in the org is named", async () => {
        const fake = scriptedDb(script([{ name: "Contrato Alfa", counterparty: "Beta Comércio" }], [{ id: "d1" }], [{ filename: "alfa.pdf" }]));
        expect(await namesVerdict(fake.db, org, "u1", ["O botão Salvar não responde"])).toBe("names-clear");
        fake.done();
    });

    it("is sensitive when the text names a counterparty, a contract or a file of the org", async () => {
        for (const [projects, versions] of [
            [[{ name: "Contrato Alfa", counterparty: "Beta Comércio" }], [{ filename: "x.pdf" }]],
            [[{ name: "Projeto Gama", counterparty: null }], [{ filename: "x.pdf" }]],
            [[{ name: "Qualquer", counterparty: null }], [{ filename: "Aditivo Delta Energia.pdf" }]],
        ] as const) {
            const fake = scriptedDb(script(projects, [{ id: "d1" }], versions));
            expect(await namesVerdict(fake.db, org, "u1", ["Falei da Beta, do projeto Gama e da Delta Energia"])).toBe("sensitive");
        }
    });

    it("scopes the names to the org, or in a personal space to what the person made", async () => {
        const inOrg = scriptedDb(script([], [], undefined));
        await namesVerdict(inOrg.db, org, "u1", ["texto"]);
        expect(inOrg.calls[0].filters).toContainEqual(["eq", "org_id", org]);
        expect(inOrg.calls[0].filters.some((f) => f[1] === "user_id")).toBe(false);
        const personal = scriptedDb(script([], [], undefined));
        await namesVerdict(personal.db, null, "u1", ["texto"]);
        expect(personal.calls[0].filters).toContainEqual(["eq", "user_id", "u1"]);
        expect(personal.calls[0].filters).toContainEqual(["is", "org_id", null]);
    });

    it("fails closed: any error reading the base is sensitive, never names-clear", async () => {
        const fake = scriptedDb([{ table: "projects", error: { message: "boom" } }]);
        expect(await namesVerdict(fake.db, org, "u1", ["O botão Salvar não responde"])).toBe("sensitive");
    });

    it("reads past the first page of names", async () => {
        const page = Array.from({ length: 1000 }, (_, i) => ({ name: `Contrato ${i}`, counterparty: null }));
        const fake = scriptedDb([
            { table: "projects", data: page },
            { table: "projects", data: [{ name: "Tardia Holdings", counterparty: null }] },
            { table: "documents", data: [] },
        ]);
        expect(await namesVerdict(fake.db, org, "u1", ["Era a Tardia"])).toBe("sensitive");
    });
});
