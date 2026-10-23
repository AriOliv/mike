// useFeedbackOpen: the modal's open state, as the sidebar link, the menu, the shortcut and the error toast
// all see it. It reads the store through useSyncExternalStore, so it must follow the store.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { feedbackStore, useFeedbackOpen } from "./feedback";

beforeEach(() => {
    act(() => feedbackStore.close());
    feedbackStore.clearDraft();
});

describe("useFeedbackOpen", () => {
    it("starts closed, opens when the store opens, and closes when it closes", () => {
        const { result } = renderHook(() => useFeedbackOpen());
        expect(result.current).toEqual({ open: false, seed: null });

        act(() => feedbackStore.open());
        expect(result.current.open).toBe(true);

        act(() => feedbackStore.close());
        expect(result.current).toEqual({ open: false, seed: null });
    });

    it("carries the seed the error toast opened it with", () => {
        const { result } = renderHook(() => useFeedbackOpen());
        act(() => feedbackStore.open({ kind: "bug", body: "Não salvou" }));
        expect(result.current).toEqual({ open: true, seed: { kind: "bug", body: "Não salvou" } });
    });

    it("every hook sees the same state, and a hook that is gone no longer listens", () => {
        const a = renderHook(() => useFeedbackOpen());
        const b = renderHook(() => useFeedbackOpen());
        act(() => feedbackStore.open());
        expect(a.result.current.open).toBe(true);
        expect(b.result.current.open).toBe(true);

        b.unmount();
        act(() => feedbackStore.close());
        expect(a.result.current.open).toBe(false);
    });
});
