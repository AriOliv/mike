"use client";

import { use, useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ContractReviewWorkspace } from "@/app/components/contract-review/ContractReviewWorkspace";
import { reviewSearch, verdictFromParam, type VerdictFilter } from "@/app/lib/contractReviewView";
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
 * that passage in the document; `?run=` opens one review and `?veredito=`
 * (diverge | precisa_revisao | alinhado) opens it filtered, as the Início's
 * tiles link to it. The URL follows the screen without scrolling.
 */
export default function ProjectReviewPage({ params }: Props) {
    const { id } = use(params);
    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const { project, canDo, openAccess } = useProjectWorkspace();
    const syncUrl = useCallback(
        ({ runId, filter }: { runId: string | null; filter: VerdictFilter }) => {
            const current = window.location.search;
            const next = reviewSearch(current, runId, filter);
            if (next !== (current === "?" ? "" : current)) router.replace(`${pathname}${next}`, { scroll: false });
        },
        [router, pathname],
    );
    return (
        <div className="flex h-full min-h-0 flex-col">
            <ProjectSectionToolbar />
            <ContractReviewWorkspace
                projectId={id}
                projectName={project?.name ?? "Contrato"}
                canEdit={canDo("content.edit")}
                onShare={openAccess}
                initialQuote={searchParams.get("quote")}
                initialRunId={searchParams.get("run")}
                initialVerdict={verdictFromParam(searchParams.get("veredito"))}
                onUrlStateChange={syncUrl}
            />
        </div>
    );
}
