import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { applyTrackedEdits, extractDocxBodyText } from "../docxTrackedChanges";

// The analyst's redline names a quote ("from") and the contract is edited at that quote. What decides
// whether it may be applied is the FACT about the ACTIVE document, not which version it is: the quote
// must be there exactly once. These tests use the real applier on real .docx bytes (no mock), because
// "once / not at all / more than once" is exactly what it decides.

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
async function makeDocx(...paragraphs: string[]): Promise<Buffer> {
    const zip = new JSZip();
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${paragraphs.map(para).join("")}</w:body></w:document>`);
    return zip.generateAsync({ type: "nodebuffer" });
}
const edit = (find: string, replace: string) => ({ find, replace, context_before: "", context_after: "", reason: "r" });

// Fictitious clauses.
const PRAZO = "5.1 O prazo de pagamento é de 5 dias corridos.";
const MULTA = "6.1 A multa rescisória é de 50% do valor total.";
const FORO = "9.1 Fica eleito o foro da Comarca de São Paulo.";

describe("a redline against the active document", () => {
    it("applies when its quote is there exactly once", async () => {
        const bytes = await makeDocx(PRAZO, MULTA, FORO);
        const out = await applyTrackedEdits(bytes, [edit("multa rescisória é de 50%", "multa rescisória é de 10%")], { author: "Pessoa" });
        expect(out.errors).toEqual([]);
        expect(out.changes).toHaveLength(1);
    });

    it("still applies after a decision on ANOTHER clause (a playbook review, another redline) made a newer version", async () => {
        // v1 = what the analysis saw. A decision on the prazo clause (a different clause) makes v2.
        const v1 = await makeDocx(PRAZO, MULTA, FORO);
        const v2 = (await applyTrackedEdits(v1, [edit("prazo de pagamento é de 5 dias", "prazo de pagamento é de 30 dias")], { author: "Pessoa" })).bytes;
        expect(v2.equals(v1)).toBe(false);
        // The multa redline quotes text that v2 still holds, so it applies on v2: a version rule would have refused it.
        const out = await applyTrackedEdits(v2, [edit("multa rescisória é de 50%", "multa rescisória é de 10%")], { author: "Pessoa" });
        expect(out.errors).toEqual([]);
        expect(out.changes).toHaveLength(1);
        // And the earlier decision is still in the document: nothing was erased.
        expect(await extractDocxBodyText(out.bytes)).toContain("30 dias");
    });

    it("says the quote was changed when someone altered THAT clause: not_found, nothing applied", async () => {
        const v1 = await makeDocx(PRAZO, MULTA, FORO);
        // The same clause was changed after the analysis (an accepted change that replaced the quoted words).
        const v2 = (await applyTrackedEdits(v1, [edit("multa rescisória é de 50%", "multa rescisória é de 20%")], { author: "Pessoa" })).bytes;
        // The applier reads the document as it stands with the tracked change in: the quoted words are gone.
        expect(await extractDocxBodyText(v2)).toContain("é de 20%");
        expect(await extractDocxBodyText(v2)).not.toContain("é de 50%");
        const out = await applyTrackedEdits(v2, [edit("multa rescisória é de 50%", "multa rescisória é de 10%")], { author: "Pessoa" });
        expect(out.changes).toHaveLength(0);
        expect(out.errors[0]).toMatchObject({ code: "not_found" });
    });

    it("does not guess when the quote is in the contract more than once: ambiguous, nothing applied", async () => {
        const bytes = await makeDocx("2.1 O prazo é de 5 dias.", "3.1 Outra cláusula.", "4.1 O prazo é de 5 dias.");
        const out = await applyTrackedEdits(bytes, [edit("O prazo é de 5 dias", "O prazo é de 30 dias")], { author: "Pessoa" });
        expect(out.changes).toHaveLength(0);
        expect(out.errors[0]).toMatchObject({ code: "ambiguous" });
    });

    it("a quote that is gone from the document says not_found, never ambiguous", async () => {
        const bytes = await makeDocx(PRAZO, FORO);
        const out = await applyTrackedEdits(bytes, [edit("texto que nunca existiu", "x")], { author: "Pessoa" });
        expect(out.errors[0]).toMatchObject({ code: "not_found" });
    });
});
