"use client";

import { use } from "react";
import { ContractAlertsView } from "@/app/components/projects/ContractAlertsView";
import { ProjectSectionToolbar } from "@/app/components/projects/ProjectWorkspace";

interface Props {
    params: Promise<{ id: string }>;
}

export default function ProjectAlertsPage({ params }: Props) {
    const { id } = use(params);
    return (
        <div className="flex h-full min-h-0 flex-col">
            <ProjectSectionToolbar />
            <ContractAlertsView projectId={id} />
        </div>
    );
}
