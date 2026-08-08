"use client";

import { use, useEffect, useState } from "react";
import { Download, FileText, Loader2 } from "lucide-react";
import {
    fetchAuthedObjectUrl,
    getDocumentPreview,
    type DocumentPreview,
} from "@/app/lib/mikeApi";
import { DossierView } from "@/app/components/projects/DossierView";
import { ProjectSectionToolbar } from "@/app/components/projects/ProjectWorkspace";

interface Props {
    params: Promise<{ id: string }>;
}

/**
 * Contract beside its analysis — the review view. Reading a criticism while the
 * clause it quotes is on screen is the whole point, so the two panes scroll
 * independently instead of one pushing the other off the page.
 */
export default function ProjectReviewPage({ params }: Props) {
    const { id } = use(params);
    const [preview, setPreview] = useState<DocumentPreview | null>(null);
    const [objectUrl, setObjectUrl] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        let created: string | null = null;
        void (async () => {
            let data: DocumentPreview | null = null;
            try {
                data = await getDocumentPreview(id);
            } catch (e) {
                console.error("[review] preview lookup failed", e);
            }
            if (cancelled) return;
            setPreview(data);

            // A failed inline fetch must not hide the document: fall back to the
            // download link rather than claiming there is nothing here.
            if (data?.inline) {
                try {
                    created = await fetchAuthedObjectUrl(data.url);
                    if (cancelled) {
                        URL.revokeObjectURL(created);
                        return;
                    }
                    setObjectUrl(created);
                } catch (e) {
                    console.error("[review] inline preview failed", e);
                }
            }
            if (!cancelled) setLoading(false);
        })();
        return () => {
            cancelled = true;
            if (created) URL.revokeObjectURL(created);
        };
    }, [id]);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <ProjectSectionToolbar />
            <div className="flex min-h-0 flex-1 gap-3 px-6 pb-6">
                <div className="flex min-h-0 w-1/2 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white">
                    {loading ? (
                        <div className="flex flex-1 items-center justify-center text-gray-400">
                            <Loader2 className="h-5 w-5 animate-spin" />
                        </div>
                    ) : !preview ? (
                        <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-gray-400">
                            No document on this contract yet.
                        </div>
                    ) : preview.inline && objectUrl ? (
                        <iframe
                            src={objectUrl}
                            title={preview.filename}
                            className="h-full w-full"
                        />
                    ) : (
                        // Only PDFs render inline; anything else is offered for download
                        // rather than shown in a viewer that cannot read it.
                        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
                            <FileText className="h-8 w-8 text-gray-300" />
                            <p className="text-sm text-gray-500">{preview.filename}</p>
                            <a
                                href={preview.url}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                            >
                                <Download className="h-3.5 w-3.5" />
                                Download
                            </a>
                        </div>
                    )}
                </div>

                <div className="flex min-h-0 w-1/2 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white">
                    <DossierView projectId={id} />
                </div>
            </div>
        </div>
    );
}
