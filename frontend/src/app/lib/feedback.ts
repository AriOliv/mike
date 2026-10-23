// "Algo errado? Conte" (doc 13): what the report modal needs outside React.
// The modal opens from the sidebar link, the user menu, the shortcut and the
// error toast, so the request to open lives in a tiny store. The draft stays
// in memory while the page lives: Esc closes without losing what was typed.

import { useSyncExternalStore } from "react";

export type FeedbackKind = "bug" | "feature";
export type FeedbackDraft = { kind: FeedbackKind | null; body: string; expected: string };
export type FeedbackOpen = { open: boolean; seed: Partial<FeedbackDraft> | null };

export const EMPTY_DRAFT: FeedbackDraft = { kind: null, body: "", expected: "" };
/** The counter only shows near the limit; the number is not in the way before. */
export const BODY_MAX = 4000;
export const COUNTER_FROM = 3500;
export const BODY_MIN = 3;

/** Set by the host once the server says the feature is on; the error toast reads it. */
let offered = false;
export const setFeedbackOffered = (v: boolean) => void (offered = v);
export const feedbackOffered = () => offered;

let state: FeedbackOpen = { open: false, seed: null };
let draft: FeedbackDraft = EMPTY_DRAFT;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const feedbackStore = {
    subscribe(l: () => void) {
        listeners.add(l);
        return () => void listeners.delete(l);
    },
    getSnapshot: () => state,
    /** `seed` pre-fills the modal, as the error toast does with the failure it showed. */
    open(seed: Partial<FeedbackDraft> | null = null) {
        if (seed) draft = { ...draft, ...seed };
        state = { open: true, seed };
        emit();
    },
    close() {
        state = { open: false, seed: null };
        emit();
    },
    getDraft: () => draft,
    setDraft(next: FeedbackDraft) {
        draft = next;
    },
    /** After a send: the next report starts empty. */
    clearDraft() {
        draft = EMPTY_DRAFT;
    },
};

export function useFeedbackOpen(): FeedbackOpen {
    return useSyncExternalStore(feedbackStore.subscribe, feedbackStore.getSnapshot, feedbackStore.getSnapshot);
}

/** A one-line account of what failed, for the box the toast opens. */
export function seedFromError(title: string, message: string, route: string): Partial<FeedbackDraft> {
    return { kind: "bug", body: `${title}${message ? `: ${message}` : ""}\n(página ${route})\n\n`.slice(0, 600) };
}

/** What the person sees before sending, and what goes with the report. */
export function technicalContext(win: Pick<Window, "location" | "navigator"> = window) {
    return {
        route: win.location.pathname,
        app_version: process.env.NEXT_PUBLIC_APP_VERSION || process.env.NEXT_PUBLIC_COMMIT_SHA || "dev",
        browser: win.navigator.userAgent.slice(0, 120),
    };
}

export type BodyCheck = { ok: boolean; hint: string | null; counter: string | null };

/** The text rules in the person's words: no numbers until it is nearly full. */
export function checkBody(body: string): BodyCheck {
    const n = body.trim().length;
    if (n < BODY_MIN) return { ok: false, hint: n === 0 ? null : "Conte um pouco mais, pelo menos uma frase.", counter: null };
    if (n > BODY_MAX) return { ok: false, hint: "O relato ficou longo demais. Resuma um pouco.", counter: `${n}/${BODY_MAX}` };
    return { ok: true, hint: null, counter: n >= COUNTER_FROM ? `${n}/${BODY_MAX}` : null };
}

/** Ctrl/Cmd+Shift+F, outside a field where a person is typing. */
export function isFeedbackShortcut(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): boolean {
    return e.shiftKey && !e.altKey && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f";
}
