import { describe, expect, it, vi } from "vitest";

// The reject that loses every retry says WHY (a code the screen can act on) and says it in Portuguese,
// on the direct route (the chat's edit card) and in the review's rejection, in the same words as the
// analysis's decision.
vi.mock("../../../lib/storage", () => ({ downloadFile: vi.fn(), uploadFile: vi.fn(), deleteFileBestEffort: vi.fn(), extractedTextKey: (id: string) => id }));
vi.mock("../../../lib/access", () => ({ ensureDocAccess: vi.fn() }));
vi.mock("../../../lib/permissions", () => ({ can: () => true, DOCUMENT_EDIT_FORBIDDEN: "forbidden" }));
vi.mock("../../../lib/downloadTokens", () => ({ buildDownloadUrl: () => "https://example.test/x" }));

import { DOCUMENT_BUSY, DOCUMENT_BUSY_DETAIL } from "../documents.service";
import { SAVE_CONFLICT } from "../../contract-review/contractReview.analysisDecisions";

describe("document_busy", () => {
    it("is the code the screen maps, with the same Portuguese sentence as the analysis's decision", () => {
        expect(DOCUMENT_BUSY).toBe("document_busy");
        // Two modules each own a constant (one module does not import the other's internals); this keeps them identical.
        expect(DOCUMENT_BUSY_DETAIL).toBe(SAVE_CONFLICT);
    });
});
