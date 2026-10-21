import { describe, expect, it } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { contractCorpus } from "../contracts.service";

describe("contractCorpus", () => {
    it("joins the indexed text of each pipeline contract of an organization", async () => {
        const fake = scriptedDb([
            {
                table: "projects",
                data: [
                    { id: "p1", name: "MSA", counterparty: "X", org_id: "o1" },
                    { id: "p2", name: "Sem texto", counterparty: null, org_id: "o1" },
                ],
            },
            { table: "documents", data: [{ id: "d1", project_id: "p1" }, { id: "d2", project_id: "p2" }] },
            { table: "document_versions", data: [{ id: "v1", document_id: "d1" }, { id: "v2", document_id: "d1" }, { id: "v3", document_id: "d2" }] },
            {
                table: "document_version_texts",
                data: [
                    { version_id: "v1", text_content: "primeira" },
                    { version_id: "v2", text_content: "segunda" },
                    { version_id: "v3", text_content: null },
                    { version_id: "ghost", text_content: "x" },
                ],
            },
        ]);
        expect(await contractCorpus(fake.db, { orgId: "o1", userId: "u1" })).toEqual([
            { project_id: "p1", name: "MSA", counterparty: "X", org_id: "o1", text: "primeira\n\nsegunda" },
        ]);
        expect(fake.calls[0].filters).toContainEqual(["eq", "org_id", "o1"]);
        expect(fake.calls[3].filters).toContainEqual(["eq", "status", "ready"]);
        fake.done();
    });

    it("reads a person's own contracts outside an organization, and stops early when there is nothing", async () => {
        const personal = scriptedDb([
            { table: "projects", data: [{ id: "p1", name: "A", counterparty: null, org_id: null }] },
            { table: "documents", data: [] },
        ]);
        expect(await contractCorpus(personal.db, { orgId: null, userId: "u1" })).toEqual([]);
        expect(personal.calls[0].filters).toContainEqual(["eq", "user_id", "u1"]);
        personal.done();

        const noVersions = scriptedDb([
            { table: "projects", data: [{ id: "p1", name: "A", counterparty: null, org_id: null }] },
            { table: "documents", data: [{ id: "d1", project_id: "p1" }] },
            { table: "document_versions", data: [] },
        ]);
        expect(await contractCorpus(noVersions.db, { orgId: null, userId: "u1" })).toEqual([]);
        noVersions.done();

        const none = scriptedDb([{ table: "projects", data: [] }]);
        expect(await contractCorpus(none.db, { orgId: "o1", userId: null })).toEqual([]);
        expect(await contractCorpus(scriptedDb([]).db, { orgId: null, userId: null })).toEqual([]);
    });

    it("throws read errors so the job retries", async () => {
        const steps = [
            { table: "projects", data: [{ id: "p1", name: "A", counterparty: null, org_id: null }] },
            { table: "documents", data: [{ id: "d1", project_id: "p1" }] },
            { table: "document_versions", data: [{ id: "v1", document_id: "d1" }] },
            { table: "document_version_texts", data: [] },
        ];
        for (let i = 0; i < steps.length; i++) {
            const fake = scriptedDb([...steps.slice(0, i), { table: steps[i].table, error: { message: "x" } }]);
            await expect(contractCorpus(fake.db, { orgId: null, userId: "u1" })).rejects.toEqual({ message: "x" });
        }
    });
});
