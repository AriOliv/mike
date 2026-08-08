"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import {
    getDossier,
    type Dossier,
    type DossierFinding,
    type DossierRedline,
} from "@/app/lib/mikeApi";

const RISK_STYLES: Record<string, string> = {
    critico: "bg-red-100 text-red-700",
    atencao: "bg-amber-100 text-amber-700",
    ok: "bg-emerald-100 text-emerald-700",
};

const CONFORMIDADE_LABELS: Record<string, string> = {
    lgpd: "Data protection (LGPD)",
    confidencialidade: "Confidentiality",
    lei_e_foro: "Governing law & venue",
    prazo_rescisao_penalidades: "Term, termination & penalties",
};

/** A quoted clause. Findings without one are shown plainly — the analysis
 *  should always cite, so a missing quote is worth noticing rather than hiding. */
function SourceQuote({ text }: { text?: string | null }) {
    if (!text) return null;
    return (
        <blockquote className="mt-1.5 border-l-2 border-gray-200 pl-2.5 text-[12px] italic leading-relaxed text-gray-500">
            {text}
        </blockquote>
    );
}

function FindingList({
    items,
    accent,
    body,
}: {
    items: DossierFinding[];
    accent: string;
    body: (f: DossierFinding) => string | null | undefined;
}) {
    return (
        <div className="space-y-3">
            {items.map((f, i) => (
                <div key={i} className={`rounded-lg border-l-2 bg-white p-3 shadow-sm ${accent}`}>
                    {f.clausula && (
                        <div className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                            {f.clausula}
                        </div>
                    )}
                    <p className="text-sm leading-relaxed text-gray-800">{body(f)}</p>
                    <SourceQuote text={f.trecho_fonte} />
                </div>
            ))}
        </div>
    );
}

function Section({
    title,
    count,
    children,
}: {
    title: string;
    count?: number;
    children: React.ReactNode;
}) {
    return (
        <section className="mb-7">
            <h2 className="mb-2.5 text-[11px] font-medium uppercase tracking-wider text-gray-500">
                {title}
                {count !== undefined && count > 0 && ` · ${count}`}
            </h2>
            {children}
        </section>
    );
}

export function DossierView({ projectId }: { projectId: string }) {
    const [dossier, setDossier] = useState<Dossier | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const data = await getDossier(projectId);
                if (!cancelled) setDossier(data);
            } catch (e) {
                if (!cancelled) {
                    setError(e instanceof Error ? e.message : "Failed to load the analysis");
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [projectId]);

    if (loading) {
        return (
            <div className="flex h-64 items-center justify-center text-gray-400">
                <Loader2 className="h-5 w-5 animate-spin" />
            </div>
        );
    }

    if (error) {
        return (
            <div className="mx-6 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error}
            </div>
        );
    }

    if (!dossier) {
        return (
            <div className="mx-6 rounded-xl border border-dashed border-gray-200 px-4 py-12 text-center text-sm text-gray-400">
                No AI analysis for this contract yet.
            </div>
        );
    }

    const p = dossier.payload ?? {};
    const criticos = p.riscos_criticos ?? [];
    const atencao = p.pontos_atencao ?? [];
    const favoraveis = p.pontos_favoraveis ?? [];
    const redlines: DossierRedline[] = p.redlines ?? [];
    const conformidade = p.conformidade ?? {};
    const abertos = p.pontos_abertos ?? [];

    return (
        // The workspace shell clips its children, so the analysis owns its own
        // scroll area — without this the sections below the fold are rendered
        // but unreachable.
        <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="max-w-4xl px-6 pb-10">
            <div className="mb-5 flex items-center gap-2">
                {dossier.risk_level && (
                    <span
                        className={`rounded px-2 py-0.5 text-[11px] uppercase ${
                            RISK_STYLES[dossier.risk_level] ?? "bg-gray-100 text-gray-600"
                        }`}
                    >
                        {dossier.risk_level}
                    </span>
                )}
                <span className="text-[11px] text-gray-400">
                    Preliminary guidance — not a legal opinion.
                </span>
            </div>

            {p.resumo_executivo && (
                <Section title="Summary">
                    <p className="text-sm leading-relaxed text-gray-800">{p.resumo_executivo}</p>
                </Section>
            )}

            {criticos.length > 0 && (
                <Section title="Critical risks" count={criticos.length}>
                    <FindingList items={criticos} accent="border-red-400" body={(f) => f.justificativa} />
                </Section>
            )}

            {atencao.length > 0 && (
                <Section title="Points of attention" count={atencao.length}>
                    <FindingList items={atencao} accent="border-amber-400" body={(f) => f.sugestao} />
                </Section>
            )}

            {redlines.length > 0 && (
                <Section title="Suggested redlines" count={redlines.length}>
                    <div className="space-y-3">
                        {redlines.map((r, i) => {
                            // Some analyses carry a clause with no wording yet. Rendering
                            // empty from/to boxes would read as a UI fault, so say so.
                            const hasWording = !!(r.de?.trim() || r.para?.trim());
                            return (
                                <div key={i} className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
                                    {r.clausula && (
                                        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                                            {r.clausula}
                                        </div>
                                    )}
                                    {hasWording ? (
                                        <div className="grid gap-2 md:grid-cols-2">
                                            <div className="rounded bg-red-50/60 p-2 text-[12px] leading-relaxed text-gray-700">
                                                <span className="mb-1 block text-[10px] uppercase text-red-600">from</span>
                                                {r.de}
                                            </div>
                                            <div className="rounded bg-emerald-50/60 p-2 text-[12px] leading-relaxed text-gray-700">
                                                <span className="mb-1 block text-[10px] uppercase text-emerald-700">to</span>
                                                {r.para}
                                            </div>
                                        </div>
                                    ) : (
                                        <p className="text-[12px] italic text-gray-400">
                                            Flagged for redlining — no wording proposed.
                                        </p>
                                    )}
                                    {r.porque && (
                                        <p className="mt-2 text-[12px] text-gray-500">{r.porque}</p>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </Section>
            )}

            {favoraveis.length > 0 && (
                <Section title="Favourable points" count={favoraveis.length}>
                    <FindingList items={favoraveis} accent="border-emerald-400" body={(f) => f.nota} />
                </Section>
            )}

            {Object.keys(conformidade).length > 0 && (
                <Section title="Compliance">
                    <dl className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                        {Object.entries(conformidade).map(([key, value], i) => (
                            <div key={key} className={`px-3 py-2.5 ${i > 0 ? "border-t border-gray-100" : ""}`}>
                                <dt className="text-[11px] uppercase tracking-wide text-gray-400">
                                    {CONFORMIDADE_LABELS[key] ?? key}
                                </dt>
                                <dd className="mt-0.5 text-sm leading-relaxed text-gray-700">{value}</dd>
                            </div>
                        ))}
                    </dl>
                </Section>
            )}

            {abertos.length > 0 && (
                <Section title="Open questions" count={abertos.length}>
                    <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
                        {abertos.map((item, i) => (
                            <li key={i}>{item}</li>
                        ))}
                    </ul>
                </Section>
            )}
            </div>
        </div>
    );
}
