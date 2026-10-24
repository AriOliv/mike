"use client";

// Mounted once with the providers: owns the report modal, which the sidebar
// link, the user menu, the shortcut and the error toast all open through the
// store. Renders nothing when the server has the feature off.

import { useEffect, useState } from "react";
import { useAuth } from "@/app/contexts/AuthContext";
import { getFeedbackStatus } from "@/app/lib/mikeApi";
import { feedbackStore, isFeedbackShortcut, setFeedbackOffered, useFeedbackOpen } from "@/app/lib/feedback";
import { FeedbackModal } from "./FeedbackModal";

/** Whether the entry points show: the person is signed in and the server has it on. */
export function useFeedbackEnabled(): boolean {
    const { user } = useAuth();
    const [enabled, setEnabled] = useState(false);
    const signedIn = !!user;
    useEffect(() => {
        if (!signedIn) return;
        let live = true;
        // Off when it cannot be known: the entry points never show on a guess.
        Promise.resolve()
            .then(() => getFeedbackStatus())
            .then((s) => live && setEnabled(s.enabled === true))
            .catch(() => live && setEnabled(false));
        return () => {
            live = false;
        };
    }, [signedIn]);
    return signedIn && enabled;
}

export function FeedbackHost() {
    const enabled = useFeedbackEnabled();
    const { open } = useFeedbackOpen();
    useEffect(() => {
        setFeedbackOffered(enabled);
        return () => setFeedbackOffered(false);
    }, [enabled]);

    useEffect(() => {
        if (!enabled) return;
        const onKey = (e: KeyboardEvent) => {
            if (!isFeedbackShortcut(e)) return;
            e.preventDefault();
            feedbackStore.open();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [enabled]);

    if (!enabled) return null;
    return <FeedbackModal open={open} onClose={() => feedbackStore.close()} />;
}
