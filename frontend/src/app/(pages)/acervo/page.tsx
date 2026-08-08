"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Loader2, Search } from "lucide-react";
import { askAcervo, type AcervoAnswer } from "@/app/lib/mikeApi";
import { PageHeader } from "@/app/components/shared/PageHeader";

const EXAMPLES = [
    "Quais contratos têm cláusula de exclusividade?",
    "Qual é a lei aplicável nos NDAs?",
    "Algum contrato permite rescisão sem justa causa?",
];

export default function AcervoPage() {
    const router = useRouter();
    const [question, setQuestion] = useState("");
    const [answer, setAnswer] = useState<AcervoAnswer | null>(null);
    const [asking, setAsking] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function ask(q: string) {
        const text = q.trim();
        if (!text || asking) return;
        setAsking(true);
        setError(null);
        setAnswer(null);
        try {
            setAnswer(await askAcervo(text));
        } catch (e) {
            setError(e instanceof Error ? e.message : "Could not answer");
        } finally {
            setAsking(false);
        }
    }

    return (
        <div className="flex h-full flex-col">
            <PageHeader>Acervo</PageHeader>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10">
                <div className="max-w-3xl">
                    <p className="mb-3 text-sm text-gray-500">
                        Pergunte sobre todos os contratos. Toda resposta cita a cláusula-fonte.
                    </p>

                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            void ask(question);
                        }}
                        className="flex gap-2"
                    >
                        <input
                            value={question}
                            onChange={(e) => setQuestion(e.target.value)}
                            placeholder="Ex.: quais contratos exigem aviso prévio de 90 dias?"
                            className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400"
                        />
                        <button
                            type="submit"
                            disabled={asking || !question.trim()}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-40"
                        >
                            {asking ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Search className="h-4 w-4" />
                            )}
                            Perguntar
                        </button>
                    </form>

                    {!answer && !asking && (
                        <div className="mt-3 flex flex-wrap gap-2">
                            {EXAMPLES.map((e) => (
                                <button
                                    key={e}
                                    onClick={() => {
                                        setQuestion(e);
                                        void ask(e);
                                    }}
                                    className="rounded-full border border-gray-200 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50"
                                >
                                    {e}
                                </button>
                            ))}
                        </div>
                    )}

                    {error && (
                        <div className="mt-4 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                            <AlertCircle className="h-4 w-4 shrink-0" />
                            {error}
                        </div>
                    )}

                    {asking && (
                        <p className="mt-6 text-sm text-gray-400">
                            Lendo os contratos mais relevantes…
                        </p>
                    )}

                    {answer && (
                        <div className="mt-6">
                            <p className="text-sm leading-relaxed text-gray-800">
                                {answer.answer ||
                                    "Não encontrei essa informação nos contratos consultados."}
                            </p>

                            {answer.sources.length > 0 && (
                                <section className="mt-5">
                                    <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-gray-500">
                                        Fontes · {answer.sources.length}
                                    </h2>
                                    <div className="space-y-2">
                                        {answer.sources.map((s, i) => (
                                            <button
                                                key={i}
                                                onClick={() =>
                                                    s.project_id &&
                                                    router.push(`/projects/${s.project_id}/review`)
                                                }
                                                className="block w-full rounded-lg border border-gray-200 bg-white p-3 text-left hover:border-gray-300"
                                            >
                                                <div className="flex items-baseline gap-2">
                                                    <span className="text-sm text-gray-800">
                                                        {s.contract}
                                                    </span>
                                                    {s.ref && (
                                                        <span className="text-[11px] uppercase text-gray-400">
                                                            {s.ref}
                                                        </span>
                                                    )}
                                                </div>
                                                {s.quote && (
                                                    <blockquote className="mt-1 border-l-2 border-gray-200 pl-2 text-[12px] italic leading-relaxed text-gray-500">
                                                        {s.quote}
                                                    </blockquote>
                                                )}
                                            </button>
                                        ))}
                                    </div>
                                </section>
                            )}

                            {/* Saying how much was read keeps the answer honest: it is
                                drawn from the most relevant contracts, not all of them. */}
                            <p className="mt-4 text-[11px] text-gray-400">
                                Respondido a partir de {answer.searched} contrato
                                {answer.searched === 1 ? "" : "s"} mais relevante
                                {answer.searched === 1 ? "" : "s"}.
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
