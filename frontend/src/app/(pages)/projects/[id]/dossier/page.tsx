"use client";

import { use } from "react";
import { DossierView } from "@/app/components/projects/DossierView";
import { ProjectSectionToolbar } from "@/app/components/projects/ProjectWorkspace";

interface Props {
    params: Promise<{ id: string }>;
}

export default function ProjectDossierPage({ params }: Props) {
    const { id } = use(params);
    return (
        <div className="flex h-full min-h-0 flex-col">
            <ProjectSectionToolbar />
            <DossierView projectId={id} />
        </div>
    );
}
