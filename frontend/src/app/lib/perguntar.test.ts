import { describe, expect, it } from "vitest";
import type { AcervoMatch } from "@/app/lib/mikeApi";
import type { UserFacingError } from "@/shared/lib/userError";
import {
    coverageNotes,
    failureCopy,
    hitSummary,
    matchStatus,
    MATCH_STATUS_LABEL,
    MODEL_REQUIRED_COPY,
    readSummary,
    reviewHref,
    splitCitations,
} from "./perguntar";

const match = (overrides: Partial<AcervoMatch>): AcervoMatch => ({
    project_id: "p1",
    contract: "MSA",
    counterparty: null,
    contract_type: null,
    hit: false,
    quote: null,
    verified: false,
    basis: "busca",
    ...overrides,
});

const described = (overrides: Partial<UserFacingError>): UserFacingError => ({
    kind: "server",
    title: "",
    message: "raw backend text",
    retryable: true,
    supportable: true,
    status: 500,
    code: null,
    requestId: null,
    cause: null,
    ...overrides,
});

describe("splitCitations", () => {
    it("turns known markers into citations and keeps unknown ones as text", () => {
        expect(splitCitations("A [1] e B [2, 3]. Fim [9].", new Set([1, 2, 3]))).toEqual([
            { kind: "text", text: "A " },
            { kind: "cite", n: 1 },
            { kind: "text", text: " e B " },
            { kind: "cite", n: 2 },
            { kind: "cite", n: 3 },
            { kind: "text", text: ". Fim [9]." },
        ]);
    });

    it("handles answers that start with a marker or have none", () => {
        expect(splitCitations("[1]", new Set([1]))).toEqual([{ kind: "cite", n: 1 }]);
        expect(splitCitations("sem fonte", new Set())).toEqual([{ kind: "text", text: "sem fonte" }]);
        expect(splitCitations("", new Set())).toEqual([]);
    });
});

describe("links and labels", () => {
    it("links to the review page with the quote to highlight", () => {
        expect(reviewHref("p 1", "cl. 11 & 12")).toBe("/projects/p%201/review?quote=cl.%2011%20%26%2012");
        expect(reviewHref("p1")).toBe("/projects/p1/review");
        expect(reviewHref("p1", null)).toBe("/projects/p1/review");
    });

    it("reads a contract's row from its hit and basis", () => {
        expect(matchStatus(match({ hit: true, basis: "pendente" }))).toBe("tem");
        expect(matchStatus(match({ basis: "pendente" }))).toBe("indexando");
        expect(matchStatus(match({ basis: "nao_buscado" }))).toBe("nao_buscado");
        expect(matchStatus(match({ basis: "lido" }))).toBe("nao_tem");
        expect(MATCH_STATUS_LABEL.indexando).toBe("Ainda indexando");
    });

    it("counts hits and says what the search could not see", () => {
        expect(hitSummary({ total: 1, matches: [match({ hit: true })] })).toBe("1 de 1 contrato");
        expect(hitSummary({ total: 3, matches: [match({ hit: true }), match({})] })).toBe("1 de 3 contratos");

        const coverage = {
            total_versions: 0,
            indexed_versions: 0,
            pending_versions: 0,
            failed_versions: 0,
            versions_needing_ocr: 0,
        };
        expect(coverageNotes({ coverage: { ...coverage, contracts_pending: 0, contracts_not_searched: 0 } })).toEqual([]);
        expect(coverageNotes({ coverage: { ...coverage, contracts_pending: 1, contracts_not_searched: 1 } })).toEqual([
            "1 contrato ainda está sendo indexado; a busca pode não ter visto tudo.",
            "1 contrato não foi buscado pelo limite por pergunta. Restrinja o escopo para cobrir todos.",
        ]);
        expect(coverageNotes({ coverage: { ...coverage, contracts_pending: 3, contracts_not_searched: 2 } })).toEqual([
            "3 contratos ainda estão sendo indexados; a busca pode não ter visto tudo.",
            "2 contratos não foram buscados pelo limite por pergunta. Restrinja o escopo para cobrir todos.",
        ]);
        expect(readSummary(1)).toBe("Respondido a partir de 1 contrato lido.");
        expect(readSummary(4)).toBe("Respondido a partir de 4 contratos lidos.");
    });
});

describe("failureCopy", () => {
    it("speaks Portuguese and never echoes the raw message", () => {
        expect(failureCopy(described({ kind: "validation", code: "model_required" }))).toBe(MODEL_REQUIRED_COPY);
        const kinds = [
            "unauthenticated",
            "forbidden",
            "validation",
            "rate_limited",
            "offline",
            "network",
            "timeout",
            "server",
        ] as const;
        const copies = kinds.map((kind) => failureCopy(described({ kind })));
        expect(new Set(copies).size).toBe(kinds.length - 1); // offline and network read the same
        for (const copy of copies) expect(copy).not.toContain("raw backend text");
    });
});
