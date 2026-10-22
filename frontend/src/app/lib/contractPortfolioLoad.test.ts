import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ listContractFichas: vi.fn() }));
vi.mock("./mikeApi", () => api);

import { loadAllContractFichas } from "./contractPortfolioLoad";

const row = (id: string) => ({ project_id: id }) as never;

beforeEach(() => api.listContractFichas.mockReset());

describe("loadAllContractFichas", () => {
    it("follows the pages to the end, nearest notice first", async () => {
        api.listContractFichas
            .mockResolvedValueOnce({ rows: [row("a"), row("b")], total: 3, next_offset: 100 })
            .mockResolvedValueOnce({ rows: [row("c")], total: 3, next_offset: null });
        expect((await loadAllContractFichas()).map((r) => (r as { project_id: string }).project_id)).toEqual(["a", "b", "c"]);
        expect(api.listContractFichas).toHaveBeenNthCalledWith(1, { sort: "aviso", limit: 100, offset: 0 });
        expect(api.listContractFichas).toHaveBeenNthCalledWith(2, { sort: "aviso", limit: 100, offset: 100 });
    });

    it("stops after the safety limit of pages", async () => {
        api.listContractFichas.mockResolvedValue({ rows: [row("x")], total: 9999, next_offset: 1 });
        expect(await loadAllContractFichas()).toHaveLength(50);
    });

    it("lets a failure reach the page, which shows its error state", async () => {
        api.listContractFichas.mockRejectedValueOnce(new Error("offline"));
        await expect(loadAllContractFichas()).rejects.toThrow("offline");
    });
});
