"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { getContractTerms, type ContractTerms } from "@/app/lib/mikeApi";

function daysUntil(date: string): number {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((new Date(`${date}T00:00:00`).getTime() - today.getTime()) / 86_400_000);
}

/** A value with the clause it came from, so nothing here is unverifiable. */
function Field({
    label,
    value,
    quote,
}: {
    label: string;
    value: string | null;
    quote?: string | null;
}) {
    if (!value) return null;
    return (
        <div className="px-3 py-2.5">
            <dt className="text-[11px] uppercase tracking-wide text-gray-400">{label}</dt>
            <dd className="mt-0.5 text-sm leading-relaxed text-gray-800">{value}</dd>
            {quote && (
                <blockquote className="mt-1 border-l-2 border-gray-200 pl-2 text-[11px] italic leading-relaxed text-gray-400">
                    {quote}
                </blockquote>
            )}
        </div>
    );
}

export function ContractTermsCard({ projectId }: { projectId: string }) {
    const [terms, setTerms] = useState<ContractTerms | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const data = await getContractTerms(projectId);
                if (!cancelled) setTerms(data);
            } catch {
                if (!cancelled) setTerms(null);
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
            <div className="flex h-16 items-center justify-center text-gray-300">
                <Loader2 className="h-4 w-4 animate-spin" />
            </div>
        );
    }
    if (!terms) return null;

    const s = terms.sources ?? {};
    const deadlineIn = terms.notice_deadline ? daysUntil(terms.notice_deadline) : null;

    return (
        <section className="mb-7">
            <h2 className="mb-2.5 text-[11px] font-medium uppercase tracking-wider text-gray-500">
                Termos comerciais
            </h2>

            {/* The renewal window is the one that bites: miss it and the contract
                renews on its own, so it leads and carries a countdown. */}
            {terms.notice_deadline && (
                <div
                    className={`mb-3 rounded-lg border p-3 ${
                        deadlineIn !== null && deadlineIn < 120
                            ? "border-amber-300 bg-amber-50"
                            : "border-gray-200 bg-white"
                    }`}
                >
                    <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                        <div>
                            <p className="text-sm text-gray-800">
                                Avisar não renovação até{" "}
                                <strong className="tabular-nums">{terms.notice_deadline}</strong>
                                {deadlineIn !== null && (
                                    <span className="text-gray-500">
                                        {" "}
                                        ({deadlineIn < 0 ? "prazo vencido" : `em ${deadlineIn} dias`})
                                    </span>
                                )}
                            </p>
                            <p className="mt-0.5 text-[12px] text-gray-500">
                                {terms.auto_renewal ? "Renovação automática" : "Renovação"} · término{" "}
                                {terms.term_end ?? "—"} · aviso prévio de {terms.notice_days} dias
                            </p>
                        </div>
                    </div>
                </div>
            )}

            <dl className="divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200 bg-white">
                {terms.auto_renewal !== null && !terms.notice_deadline && (
                    <Field
                        label="Renovação automática"
                        value={terms.auto_renewal ? "Sim" : "Não"}
                        quote={s.auto_renewal}
                    />
                )}
                <Field
                    label="Multa"
                    value={
                        terms.penalty_value
                            ? `${terms.penalty_value}${
                                  terms.penalty_recurrence
                                      ? ` · ${terms.penalty_recurrence === "unica" ? "única" : "por evento"}`
                                      : ""
                              }`
                            : null
                    }
                    quote={s.penalty_value}
                />
                <Field
                    label="Cap de responsabilidade"
                    value={terms.liability_cap}
                    quote={s.liability_cap}
                />
                <Field
                    label="Alteração unilateral"
                    value={
                        terms.unilateral_amendment === null
                            ? null
                            : terms.unilateral_amendment
                              ? "Sim — a contraparte pode alterar a seu exclusivo critério"
                              : "Não"
                    }
                    quote={s.unilateral_amendment}
                />
                <Field label="Alterações" value={terms.amendment_notes} quote={s.amendment_notes} />
                <Field
                    label="Impacto em preço / regulatório"
                    value={terms.price_regulatory_impact}
                    quote={s.price_regulatory_impact}
                />
            </dl>
        </section>
    );
}
