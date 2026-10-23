import { describe, expect, it } from "vitest";
import { MikeApiError } from "@/app/lib/mikeApi";
import { editFailureMessage } from "./editFailureMessage";

describe("editFailureMessage", () => {
    it("shows the server's own Portuguese words when two people wrote the contract at once", () => {
        const busy = new MikeApiError({
            status: 409,
            code: "document_busy",
            message: "O contrato foi alterado por outra pessoa ao mesmo tempo. Sua decisão não foi gravada; tente de novo.",
        });
        expect(editFailureMessage(busy, "reject")).toBe(
            "Não consegui salvar a recusa: O contrato foi alterado por outra pessoa ao mesmo tempo. Sua decisão não foi gravada; tente de novo. A edição voltou ao que era.",
        );
    });

    it("says it in Portuguese for an accept, and in the plural for a batch", () => {
        const busy = new MikeApiError({ status: 409, code: "document_busy", message: "Tente de novo." });
        expect(editFailureMessage(busy, "accept")).toMatch(/^Não consegui salvar a aceitação: /);
        expect(editFailureMessage(busy, "accept", 3)).toMatch(/^Não consegui salvar algumas das aceitações: /);
        expect(editFailureMessage(busy, "reject", 3)).toMatch(/^Não consegui salvar algumas das recusas: /);
    });

    it("never leaks English for a failure with no message of its own", () => {
        const text = editFailureMessage(new TypeError("Failed to fetch"), "accept");
        expect(text).toMatch(/^Não consegui salvar a aceitação: /);
        expect(text).toMatch(/A edição voltou ao que era\.$/);
        expect(text).not.toMatch(/Couldn't|reverted/);
    });
});
