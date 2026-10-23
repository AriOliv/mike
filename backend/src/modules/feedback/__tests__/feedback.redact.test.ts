// Redaction before storage (doc 13 §7). All data here is made up.

import { describe, expect, it } from "vitest";
import { cleanRoute, redact } from "../feedback.redact";

describe("redact", () => {
    it("hides e-mail, CNPJ, CPF, phone and long digit runs, and counts them", () => {
        const r = redact("Falei com ana@exemplo.test sobre 11.222.333/0001-81 e o CPF 123.456.789-09; fone (11) 91234-5678, contrato 20260012.");
        expect(r.text).toBe("Falei com [e-mail] sobre [CNPJ] e o CPF [CPF]; fone [telefone], contrato [número].");
        expect(r.found).toBe(5);
    });

    it("hides 11 digits in a row even without punctuation (it may be a CPF)", () => {
        expect(redact("12345678909").text).toBe("[CPF]");
    });

    it("hides a pasted token or key", () => {
        const r = redact("meu token mike_pat_AbC123_xyz e ghp_abcdefghijklmnopqrstuvwx e sk-abcdefghijklmnop1234");
        expect(r.text).toBe("meu token [segredo] e [segredo] e [segredo]");
        expect(r.found).toBe(3);
    });

    it("leaves ordinary text and short numbers alone; names are not caught", () => {
        const r = redact("O botão Salvar não responde na página 3 em 2026. Falei com Maria Exemplo.");
        expect(r).toEqual({ text: "O botão Salvar não responde na página 3 em 2026. Falei com Maria Exemplo.", found: 0 });
    });
});

describe("cleanRoute", () => {
    it("drops query and fragment, and anything that is not a path", () => {
        expect(cleanRoute("/pedidos/abc?token=segredo#x")).toBe("/pedidos/abc");
        expect(cleanRoute("https://x.test/a")).toBeNull();
        expect(cleanRoute(42)).toBeNull();
    });
});
