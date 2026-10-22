"use client";

import { Suspense } from "react";
import { HomeView } from "@/app/components/home/HomeView";

export default function InicioPage() {
    // useSearchParams (the open review lives in ?doc=) needs a boundary.
    return (
        <Suspense fallback={null}>
            <HomeView />
        </Suspense>
    );
}
