import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkBody, EMPTY_DRAFT, feedbackStore, isFeedbackShortcut, seedFromError, technicalContext } from "./feedback";

beforeEach(() => {
    feedbackStore.clearDraft();
    feedbackStore.close();
});

describe("checkBody", () => {
    it("says nothing on an empty box, asks for a sentence when short, and shows the counter only near the limit", () => {
        expect(checkBody("")).toEqual({ ok: false, hint: null, counter: null });
        expect(checkBody("ab")).toEqual({ ok: false, hint: "Conte um pouco mais, pelo menos uma frase.", counter: null });
        expect(checkBody("não salva")).toEqual({ ok: true, hint: null, counter: null });
        expect(checkBody("x".repeat(3500)).counter).toBe("3500/4000");
        expect(checkBody("x".repeat(4001))).toMatchObject({ ok: false, hint: "O relato ficou longo demais. Resuma um pouco." });
    });
});

describe("the draft", () => {
    it("survives closing and reopening, and is cleared after a send", () => {
        feedbackStore.open();
        feedbackStore.setDraft({ kind: "bug", body: "rascunho", expected: "" });
        feedbackStore.close();
        expect(feedbackStore.getSnapshot().open).toBe(false);
        expect(feedbackStore.getDraft().body).toBe("rascunho");
        feedbackStore.clearDraft();
        expect(feedbackStore.getDraft()).toEqual(EMPTY_DRAFT);
    });

    it("opens pre-filled with a failure, as the error toast does", () => {
        const l = vi.fn();
        const off = feedbackStore.subscribe(l);
        feedbackStore.open(seedFromError("Não salvou", "Tente de novo", "/pedidos"));
        expect(l).toHaveBeenCalled();
        expect(feedbackStore.getDraft()).toMatchObject({ kind: "bug" });
        expect(feedbackStore.getDraft().body).toContain("Não salvou: Tente de novo");
        expect(feedbackStore.getDraft().body).toContain("(página /pedidos)");
        off();
    });
});

describe("shortcut and context", () => {
    const key = (o: object) => ({ key: "F", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
    it("is Ctrl or Cmd plus Shift plus F, and nothing else", () => {
        expect(isFeedbackShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(true);
        expect(isFeedbackShortcut(key({ metaKey: true, shiftKey: true, key: "f" }))).toBe(true);
        expect(isFeedbackShortcut(key({ ctrlKey: true }))).toBe(false);
        expect(isFeedbackShortcut(key({ shiftKey: true }))).toBe(false);
        expect(isFeedbackShortcut(key({ ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
        expect(isFeedbackShortcut(key({ ctrlKey: true, shiftKey: true, key: "g" }))).toBe(false);
    });

    it("sends the path and never the query or the fragment", () => {
        const ctx = technicalContext({ location: { pathname: "/pedidos/abc" }, navigator: { userAgent: "Firefox" } } as never);
        expect(ctx).toMatchObject({ route: "/pedidos/abc", browser: "Firefox" });
        expect(JSON.stringify(ctx)).not.toMatch(/token|cookie/i);
    });
});
