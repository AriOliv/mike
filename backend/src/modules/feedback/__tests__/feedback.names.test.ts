// The backend's check of the base's names (doc 13 §5): the names stay in the cluster, only a
// verdict leaves, and any doubt is `sensitive`. All names here are made up.

import { describe, expect, it } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { mentionsAny, nameWords, namesVerdict, norm, shortNames } from "../feedback.names";

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
    const ORG = "00000000-0000-4000-c000-000000000001";
    const ORG2 = "00000000-0000-4000-c000-000000000002";
    // One space = projects, documents (and versions when there are documents). The author's spaces come first.
    const members = (...orgs: string[]) => ({ table: "org_members", data: orgs.map((org_id) => ({ org_id })) });
    const space = (projects: unknown, documents: unknown = [], versions?: unknown) => [
        { table: "projects", data: projects },
        { table: "documents", data: documents },
        ...(versions !== undefined ? [{ table: "document_versions", data: versions }] : []),
    ];

    it("is names-clear when nothing in any of the author's spaces is named", async () => {
        const fake = scriptedDb([members(ORG), ...space([{ name: "Contrato Alfa", counterparty: "Beta Comércio" }], [{ id: "d1" }], [{ filename: "alfa.pdf" }]), ...space([])]);
        expect(await namesVerdict(fake.db, "u1", ["O botão Salvar não responde"])).toBe("names-clear");
        fake.done();
    });

    it("is sensitive when the text names a counterparty, a contract or a file", async () => {
        for (const [projects, versions] of [
            [[{ name: "Contrato Alfa", counterparty: "Beta Comércio" }], [{ filename: "x.pdf" }]],
            [[{ name: "Projeto Gama", counterparty: null }], [{ filename: "x.pdf" }]],
            [[{ name: "Qualquer", counterparty: null }], [{ filename: "Aditivo Delta Energia.pdf" }]],
        ] as const) {
            const fake = scriptedDb([members(ORG), ...space(projects, [{ id: "d1" }], versions), ...space([])]);
            expect(await namesVerdict(fake.db, "u1", ["Falei da Beta, do projeto Gama e da Delta Energia"])).toBe("sensitive");
        }
    });

    it("compares with EVERY organization the author belongs to, and with their personal space", async () => {
        // The name sits in the SECOND organization and in no other: reporting "from" the first must still see it.
        const second = scriptedDb([members(ORG, ORG2), ...space([]), ...space([{ name: "Projeto Omega", counterparty: "Omega Energia" }]), ...space([])]);
        expect(await namesVerdict(second.db, "u1", ["Era a Omega"])).toBe("sensitive");
        // and in the personal space
        const personal = scriptedDb([members(ORG), ...space([]), ...space([{ name: "Projeto Sigma", counterparty: null }])]);
        expect(await namesVerdict(personal.db, "u1", ["Falei do Sigma"])).toBe("sensitive");
        // every space is scoped to ITS org, and the personal one to what the person made
        const scoped = scriptedDb([members(ORG, ORG2), ...space([]), ...space([]), ...space([])]);
        await namesVerdict(scoped.db, "u1", ["texto"]);
        const projectCalls = scoped.calls.filter((c) => c.table === "projects");
        expect(projectCalls[0].filters).toContainEqual(["eq", "org_id", ORG]);
        expect(projectCalls[1].filters).toContainEqual(["eq", "org_id", ORG2]);
        expect(projectCalls[2].filters).toContainEqual(["eq", "user_id", "u1"]);
        expect(projectCalls[2].filters).toContainEqual(["is", "org_id", null]);
        expect(scoped.calls[0].filters).toContainEqual(["eq", "user_id", "u1"]);
    });

    it("fails closed: any error reading the base is sensitive, never names-clear", async () => {
        expect(await namesVerdict(scriptedDb([{ table: "org_members", error: { message: "boom" } }]).db, "u1", ["O botão Salvar não responde"])).toBe("sensitive");
        expect(await namesVerdict(scriptedDb([members(ORG), { table: "projects", error: { message: "boom" } }]).db, "u1", ["O botão Salvar não responde"])).toBe("sensitive");
    });

    it("reads past the first page of names", async () => {
        const page = Array.from({ length: 1000 }, (_, i) => ({ name: `Contrato ${i}`, counterparty: null }));
        const fake = scriptedDb([members(ORG), { table: "projects", data: page }, { table: "projects", data: [{ name: "Tardia Holdings", counterparty: null }] }, { table: "documents", data: [] }, ...space([])]);
        expect(await namesVerdict(fake.db, "u1", ["Era a Tardia"])).toBe("sensitive");
    });
});

describe("short counterparty names (XP, BTG, B3)", () => {
    it("takes 2-3 letter names in capitals or with a digit, from counterparties only", () => {
        expect([...shortNames(["XP", "BTG Pactual", "B3 S.A.", "3M do Brasil", "Banco do Brasil", "de", "em", null, ""])].sort()).toEqual(["3m", "b3", "btg", "xp"]);
    });
    it("leaves out corporate forms and small words that are capitalised in a company name (ME is also the pronoun)", () => {
        const s = shortNames(["Padaria do Zé ME", "Oficina Silva EPP", "Alfa EIRELI", "Beta MEI", "Gama S.A.", "Delta Cia", "Zeta LTD", "Omega INC"]);
        expect([...s]).toEqual([]);
        // and so a report that says "me" is not flagged by a counterparty that ends in ME
        expect(mentionsAny("O botão não me deixa salvar", [], ["Padaria do Zé ME"])).toBe(false);
        // while the names that DO identify, next to those forms, still do
        expect(mentionsAny("Falei com a XP", [], ["XP Investimentos S.A."])).toBe(true);
        expect(mentionsAny("O contrato da TIM", [], ["TIM S.A."])).toBe(true);
    });
    it("does not turn common small words into names", () => {
        const s = shortNames(["Pedido de Renovação", "Termo em Vigor", "Contrato do Grupo", "Ana e Cia"]);
        for (const w of ["de", "em", "do", "e", "ana", "cia"]) expect(s.has(w)).toBe(false);
    });
    it("finds a short counterparty as a whole word, in any case, and not inside another word", () => {
        const names = { counterparties: ["XP Investimentos", "BTG Pactual", "B3"], others: [] as string[] };
        expect(mentionsAny("Falei com a xp ontem", [], names.counterparties)).toBe(true);
        expect(mentionsAny("O contrato do BTG não abre", [], names.counterparties)).toBe(true);
        expect(mentionsAny("Subiu na B3, urgente", [], names.counterparties)).toBe(true);
        expect(mentionsAny("O expresso do xpto falhou", [], names.counterparties)).toBe(false);
        expect(mentionsAny("A tela de btgx não carrega", [], names.counterparties)).toBe(false);
        expect(mentionsAny("O botão Salvar não responde", [], names.counterparties)).toBe(false);
    });
});

describe("short counterparty names end to end", () => {
    const ORG = "00000000-0000-4000-c000-000000000001";
    it("a counterparty called XP is found as a whole word through namesVerdict", async () => {
        const fake = scriptedDb([{ table: "org_members", data: [{ org_id: ORG }] }, { table: "projects", data: [{ name: "Contrato Alfa", counterparty: "XP" }] }, { table: "documents", data: [] }, { table: "projects", data: [] }, { table: "documents", data: [] }]);
        expect(await namesVerdict(fake.db, "u1", ["Falei com a XP ontem"])).toBe("sensitive");
    });
    it("a project NAME (not a counterparty) that is a short word is not read as a name", async () => {
        const fake = scriptedDb([{ table: "org_members", data: [{ org_id: ORG }] }, { table: "projects", data: [{ name: "XP", counterparty: null }] }, { table: "documents", data: [] }, { table: "projects", data: [] }, { table: "documents", data: [] }]);
        expect(await namesVerdict(fake.db, "u1", ["Falei com a XP ontem"])).toBe("names-clear");
    });
});

describe("the ceiling fails closed", () => {
    const ORG = "00000000-0000-4000-c000-000000000001";
    const page = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ name: `${tag} ${i}`, counterparty: null }));
    const members = { table: "org_members", data: [{ org_id: ORG }] };

    it("is sensitive when there are more names than the check can read (never names-clear on a partial list)", async () => {
        // The ceiling is 20 full pages of projects. The script supplies EXACTLY those 20 pages, then enough
        // for the personal space: with no ceiling error the loop ends quietly and the answer would be
        // names-clear from a partial list; with it, the answer is sensitive. (Too few steps would make the
        // fake db throw, and that alone would turn the answer into sensitive, proving nothing.)
        const fake = scriptedDb([members, ...Array.from({ length: 20 }, () => ({ table: "projects", data: page(1000, "Contrato") })), { table: "documents", data: [] }, { table: "projects", data: [] }, { table: "documents", data: [] }]);
        expect(await namesVerdict(fake.db, "u1", ["O botão Salvar não responde"])).toBe("sensitive");
        // it stopped at the ceiling and did not read the documents of a list it already knows is partial
        expect(fake.calls.filter((c) => c.table === "projects")).toHaveLength(20);
        expect(fake.calls.some((c) => c.table === "documents")).toBe(false);
    });

    it("still answers names-clear when the base is large but fits under the ceiling", async () => {
        const fake = scriptedDb([members, { table: "projects", data: page(1000, "Contrato") }, { table: "projects", data: page(400, "Contrato") }, { table: "documents", data: [] }, { table: "projects", data: [] }, { table: "documents", data: [] }]);
        expect(await namesVerdict(fake.db, "u1", ["O botão Salvar não responde"])).toBe("names-clear");
    });

    it("an exactly-full last page that is also the end is read, not refused (19 full pages + a short one)", async () => {
        const fake = scriptedDb([members, ...Array.from({ length: 19 }, () => ({ table: "projects", data: page(1000, "C") })), { table: "projects", data: page(999, "C") }, { table: "documents", data: [] }, { table: "projects", data: [] }, { table: "documents", data: [] }]);
        expect(await namesVerdict(fake.db, "u1", ["O botão Salvar não responde"])).toBe("names-clear");
    });
});
