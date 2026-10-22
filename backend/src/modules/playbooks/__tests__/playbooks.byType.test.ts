import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";

const operations = vi.hoisted(() => ({ listPlaybooks: vi.fn() }));
vi.mock("../playbooks.operations", () => operations);

import { findPlaybookForContractType, playbookForContractType } from "../playbooks.service";

type Shape = { id: string; visibility: "private" | "organization"; documentTypes: string[]; updatedAt: string };
const playbook = ({ id, visibility, documentTypes, updatedAt }: Shape) =>
    ({ id, visibility, updatedAt, content: { documentTypes } }) as never;

const NDA = playbook({ id: "nda", visibility: "organization", documentTypes: ["NDA"], updatedAt: "2026-10-01" });
const MSA = playbook({ id: "msa", visibility: "organization", documentTypes: ["MSA", "Prestação de serviços"], updatedAt: "2026-10-05" });

beforeEach(() => vi.clearAllMocks());

describe("playbookForContractType", () => {
    it("picks the organization playbook written for the contract's type", () => {
        expect(playbookForContractType([MSA, NDA], "NDA")).toBe(NDA);
        expect(playbookForContractType([MSA, NDA], "Prestação de serviços")).toBe(MSA);
        expect(playbookForContractType([MSA, NDA], "prestacao  de servicos")).toBe(MSA);
    });

    it("treats the names of a confidentiality agreement as one type", () => {
        for (const name of ["Acordo de Confidencialidade", "MNDA", "Mutual Non-Disclosure Agreement", "nda"])
            expect(playbookForContractType([MSA, NDA], name), name).toBe(NDA);
        const writtenInFull = playbook({ id: "acordo", visibility: "organization", documentTypes: ["Termo de confidencialidade"], updatedAt: "2026-01-01" });
        expect(playbookForContractType([writtenInFull], "NDA")).toBe(writtenInFull);
    });

    it("never reviews with a private draft, and prefers the newest of several", () => {
        const draft = playbook({ id: "draft", visibility: "private", documentTypes: ["NDA"], updatedAt: "2026-12-01" });
        expect(playbookForContractType([draft], "NDA")).toBeNull();
        const newer = playbook({ id: "newer", visibility: "organization", documentTypes: ["NDA"], updatedAt: "2026-11-01" });
        expect(playbookForContractType([NDA, draft, newer], "NDA")).toBe(newer);
    });

    it("finds nothing for an unknown, blank or unmatched type", () => {
        expect(playbookForContractType([MSA, NDA], null)).toBeNull();
        expect(playbookForContractType([MSA, NDA], "  ")).toBeNull();
        expect(playbookForContractType([MSA, NDA], "Locação")).toBeNull();
        expect(playbookForContractType([], "NDA")).toBeNull();
    });
});

describe("findPlaybookForContractType", () => {
    it("lists the organization's playbooks as the caller and matches", async () => {
        operations.listPlaybooks.mockResolvedValue([MSA, NDA]);
        const found = await findPlaybookForContractType({} as Db, {
            userId: "u1",
            userEmail: "duda@avenia.io",
            orgId: "org-1",
            contractType: "NDA",
        });
        expect(found).toBe(NDA);
        expect(operations.listPlaybooks).toHaveBeenCalledWith("u1", expect.anything(), { workspace: "org-1", email: "duda@avenia.io" });
    });

    it("does not look without an organization or a type", async () => {
        expect(await findPlaybookForContractType({} as Db, { userId: "u1", orgId: null, contractType: "NDA" })).toBeNull();
        expect(await findPlaybookForContractType({} as Db, { userId: "u1", orgId: "org-1", contractType: null })).toBeNull();
        expect(operations.listPlaybooks).not.toHaveBeenCalled();
    });
});
