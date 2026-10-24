import { describe, expect, it } from "vitest";
import { assign, looksLikeToken, mappingProblems, propertiesFor, propertyOf } from "./notionIntegration";

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
});
