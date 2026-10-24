"use client";

import { Suspense } from "react";
import { McpConsent } from "@/app/components/settings/McpConsent";

export default function ConsentirPage() {
    // useSearchParams (?pedido=) needs a boundary.
    return (
        <Suspense fallback={null}>
            <McpConsent />
        </Suspense>
    );
}
