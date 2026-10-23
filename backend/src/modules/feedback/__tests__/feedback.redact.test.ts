// Redaction before storage (doc 13 §7). All data here is made up.

import { describe, expect, it } from "vitest";
import { cleanRoute, LINE_BREAKS_AND_CONTROLS, oneLine, redact } from "../feedback.redact";

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

describe("one line, whatever the client sends", () => {
    const BREAKS = ["\n", "\r", "\r\n", "\u0085", "\u2028", "\u2029", "\u000B", "\u000C"];

    it("turns every line terminator and control into a space (C0, DEL, C1 with NEL, LS and PS)", () => {
        for (const br of BREAKS) expect(oneLine(`a${br}b`), JSON.stringify(br)).toBe("a b");
        for (const c of ["\u0000", "\u0007", "\u001B", "\u007F", "\u0080", "\u009F"]) expect(oneLine(`a${c}b`), JSON.stringify(c)).toBe("a b");
        expect(oneLine("a\n\r\u2028\u2029b")).toBe("a b");
        expect(oneLine("  spaced  ")).toBe("spaced");
    });

    it("leaves ordinary text, accents and a plain space alone", () => {
        expect(oneLine("Firefox 120.0 (Mac OS X) — pt-BR ç")).toBe("Firefox 120.0 (Mac OS X) — pt-BR ç");
        expect(LINE_BREAKS_AND_CONTROLS.test("a b")).toBe(false);
    });

    it("cleanRoute never returns a break, on its own and not only through the issue", () => {
        for (const br of BREAKS) {
            const route = cleanRoute(`/pedidos${br}- Papel: head`);
            expect(route, JSON.stringify(br)).toBe("/pedidos - Papel: head");
            expect(route).not.toMatch(LINE_BREAKS_AND_CONTROLS);
        }
        // a break before the leading slash does not smuggle a first line in: the trimmed value must still start with "/"
        expect(cleanRoute("\n/pedidos")).toBe("/pedidos");
        expect(cleanRoute("x\n/pedidos")).toBeNull();
    });
});
