import { describe, expect, it } from "vitest";
import { assign, looksLikeToken, mappingProblems, propertiesFor, propertyOf, sinceLabel } from "./notionIntegration";

describe("notion integration helpers", () => {
    it("recognizes a token", () => {
        expect(looksLikeToken(" ntn_" + "a".repeat(30) + " ")).toBe(true);
        expect(looksLikeToken("ntn_x")).toBe(false);
    });

    it("inverts and reassigns the field map, one property per field", () => {
        expect(propertyOf({ Contrato: "name", Etapa: "lane" })).toEqual({ name: "Contrato", lane: "Etapa" });
        expect(assign({ Contrato: "name", Pessoa: "assignee" }, "assignee", "Responsável")).toEqual({ Contrato: "name", Responsável: "assignee" });
        expect(assign({ Contrato: "name", Pessoa: "assignee" }, "assignee", null)).toEqual({ Contrato: "name" });
        expect(assign({ Contrato: "name" }, "counterparty", "Contrato")).toEqual({ Contrato: "counterparty" });
    });

    it("lists what is missing", () => {
        expect(mappingProblems({ Contrato: "name", Etapa: "lane" }, ["A"], { A: { lane: "entrada", tag: null } })).toEqual([]);
        expect(mappingProblems({}, ["A", "B"], {})).toEqual([
            "Escolha a propriedade com o nome do contrato.",
            "Escolha a propriedade com a etapa.",
            "Escolha a etapa do Mike para A, B.",
        ]);
    });

    it("filters properties by type", () => {
        expect(propertiesFor([{ name: "Prazo", type: "date" }, { name: "Contrato", type: "title" }], ["date"])).toEqual(["Prazo"]);
    });

    it("says when the last sync ran", () => {
        const now = Date.parse("2026-10-22T12:00:00Z");
        expect(sinceLabel(null, now)).toBe("ainda não sincronizou");
        expect(sinceLabel("2026-10-22T11:59:50Z", now)).toBe("agora há pouco");
        expect(sinceLabel("2026-10-22T11:57:00Z", now)).toBe("há 3 min");
        expect(sinceLabel("2026-10-22T10:00:00Z", now)).toBe("há 2 h");
        expect(sinceLabel("2026-10-20T10:00:00Z", now)).toMatch(/^em \d{2}\/\d{2}$/);
        expect(sinceLabel("2026-10-22T12:05:00Z", now)).toBe("agora há pouco");
        expect(sinceLabel("2026-10-22T11:00:00Z")).toMatch(/^(há|em)/);
    });
});
