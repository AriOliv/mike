// The model the contract reads run on: the person's own choice wins, the
// deployment default (LEGAL_DEFAULT_MODEL) fills the first use, and with
// neither the answer is a 400 that points to Settings. No LLM is called.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../../user/user.service", () => ({
    getUserModelSettings: vi.fn(async () => settings.current),
}));

import { analysisModel } from "../contracts.shared";

const db = {} as never;
const KEYS = { claude: "chave-ficticia" };

beforeEach(() => {
    settings.current = { tabular_model: null, last_selected_chat_model: null, api_keys: KEYS };
    delete process.env.LEGAL_DEFAULT_MODEL;
});
afterEach(() => {
    delete process.env.LEGAL_DEFAULT_MODEL;
});

describe("analysisModel", () => {
    it("uses the deployment default on first use, when the person's keys can run it", async () => {
        process.env.LEGAL_DEFAULT_MODEL = "claude-sonnet-5-5";
        expect(await analysisModel(db, "u")).toMatchObject({ ok: true, model: "claude-sonnet-5-5" });
    });

    it("keeps the person's own choice over the default", async () => {
        process.env.LEGAL_DEFAULT_MODEL = "claude-sonnet-5-5";
        settings.current = { ...settings.current, tabular_model: "claude-haiku-5-5" };
        expect(await analysisModel(db, "u")).toMatchObject({ model: "claude-haiku-5-5" });
        settings.current = { ...settings.current, tabular_model: null, last_selected_chat_model: "claude-opus-5-5" };
        expect(await analysisModel(db, "u")).toMatchObject({ model: "claude-opus-5-5" });
    });

    it("asks for a model, pointing to Settings, when there is none or no key can run the default", async () => {
        expect(await analysisModel(db, "u")).toMatchObject({ ok: false, kind: "validation", code: "model_required" });
        process.env.LEGAL_DEFAULT_MODEL = "claude-sonnet-5-5";
        settings.current = { ...settings.current, api_keys: {} };
        expect(await analysisModel(db, "u")).toMatchObject({ ok: false, code: "model_required" });
    });
});
