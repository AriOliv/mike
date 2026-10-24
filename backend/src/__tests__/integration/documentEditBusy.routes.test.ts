import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// The chat's edit card rejects through POST /single-documents/:id/edits/:id/reject. When that write loses the
// race to another one, the body the screen receives must carry the code it acts on, with the Portuguese
// sentence; any other failure must not claim a race.
const state = vi.hoisted(() => ({ resolveEdit: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ createServerSupabase: () => ({}) }));
vi.mock("../../middleware/auth", async () => {
  const { authMock } = await import("../helpers/authMock.js");
  return authMock();
});
vi.mock("../../modules/documents/documents.service", async (original) => ({
  ...(await original<typeof import("../../modules/documents/documents.service")>()),
  resolveEdit: state.resolveEdit,
}));
import { app } from "../../app";

const DOC = "11111111-2222-4333-8444-555555555555";
const EDIT = "99999999-2222-4333-8444-555555555555";
beforeEach(() => vi.clearAllMocks());

describe("POST /single-documents/:id/edits/:id/reject", () => {
  it("answers 409 with the document_busy code and the Portuguese sentence when the write lost the race", async () => {
    state.resolveEdit.mockResolvedValue({
      ok: false,
      status: 409,
      code: "document_busy",
      detail: "O contrato foi alterado por outra pessoa ao mesmo tempo. Sua decisão não foi gravada; tente de novo.",
    });
    const res = await request(app).post(`/single-documents/${DOC}/edits/${EDIT}/reject`);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: "document_busy",
      detail: "O contrato foi alterado por outra pessoa ao mesmo tempo. Sua decisão não foi gravada; tente de novo.",
    });
  });

  it("keeps the plain { detail } body, with no code, for a failure that is not a lost race", async () => {
    state.resolveEdit.mockResolvedValue({ ok: false, detail: "Edit not found" });
    const res = await request(app).post(`/single-documents/${DOC}/edits/${EDIT}/accept`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ detail: "Edit not found" });
  });
});
