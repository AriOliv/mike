"use client";

import { Suspense } from "react";
import { ChatLinkConfirm } from "@/app/components/organizations/ChatLinkConfirm";

export default function VincularChatPage() {
    // useSearchParams (the one-time ?t=) needs a boundary.
    return (
        <Suspense fallback={null}>
            <ChatLinkConfirm />
        </Suspense>
    );
}
