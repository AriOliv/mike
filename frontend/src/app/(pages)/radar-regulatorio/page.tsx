"use client";

import { Suspense } from "react";
import { RegulatoryRadarView } from "@/app/components/regulatory/RegulatoryRadarView";

export default function RadarRegulatorioPage() {
    return (
        <Suspense>
            <RegulatoryRadarView />
        </Suspense>
    );
}
