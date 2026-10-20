"use client";

import { use } from "react";
import { useSearchParams } from "next/navigation";
import { ContractReviewWorkspace } from "@/app/components/contract-review/ContractReviewWorkspace";
import {
    ProjectSectionToolbar,
    useProjectWorkspace,
} from "@/app/components/projects/ProjectWorkspace";

interface Props {
    params: Promise<{ id: string }>;
}

/**
 * The contract review: the document with its redline beside the first review
 * by playbook and the Ficha. `?quote=` arrives from a cited answer and shows
 * that passage in the document.
 */
export default function ProjectReviewPage({ params }: Props) {
    const { id } = use(params);
    const quote = useSearchParams().get("quote");
    const { project, canDo, openAccess } = useProjectWorkspace();
    return (
        <div className="flex h-full min-h-0 flex-col">
            <ProjectSectionToolbar />
            <ContractReviewWorkspace
                projectId={id}
                projectName={project?.name ?? "Contrato"}
                canEdit={canDo("content.edit")}
                onShare={openAccess}
                initialQuote={quote}
            />
        </div>
    );
}
