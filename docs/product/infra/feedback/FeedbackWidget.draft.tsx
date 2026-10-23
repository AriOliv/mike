// RASCUNHO — frontend/src/app/components/shared/FeedbackWidget.tsx. Não compilado.
// Botão flutuante "Dar feedback", visível só quando NEXT_PUBLIC_FEEDBACK_ENABLED=true
// (staging e prévias). Montar uma vez no layout de (pages).
// Mostra também um selo do ambiente ("staging" / "pr-12") para ninguém achar
// que está em produção.
"use client";

import { useState } from "react";
import { usePathname, useParams } from "next/navigation";
import { sendFeedback } from "@/app/lib/mikeApi";
// Em mikeApi.ts (segue o padrão das outras funções):
//   export async function sendFeedback(body: FeedbackInput): Promise<{ id: string }> {
//       return apiRequest("/feedback", { method: "POST", body: JSON.stringify(body) });
//   }

const ENABLED = process.env.NEXT_PUBLIC_FEEDBACK_ENABLED === "true";
const ENV_LABEL = process.env.NEXT_PUBLIC_ENV_LABEL ?? "";

const KINDS = [
    { value: "bug", label: "Algo quebrou" },
    { value: "sugestao", label: "Sugestão" },
    { value: "duvida", label: "Dúvida" },
    { value: "elogio", label: "Gostei" },
] as const;

type Kind = (typeof KINDS)[number]["value"];

export function FeedbackWidget() {
    const pathname = usePathname();
    const params = useParams<{ projectId?: string; id?: string }>();
    const [open, setOpen] = useState(false);
    const [kind, setKind] = useState<Kind>("sugestao");
    const [message, setMessage] = useState("");
    const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

    if (!ENABLED) return null;

    async function submit() {
        setState("sending");
        try {
            await sendFeedback({
                kind,
                message,
                route: pathname,
                project_id: params.projectId ?? params.id,
                viewport: `${window.innerWidth}x${window.innerHeight}`,
            });
            setState("sent");
            setMessage("");
            setTimeout(() => {
                setOpen(false);
                setState("idle");
            }, 1800);
        } catch {
            setState("error");
        }
    }

    return (
        <>
            <div className="fixed left-3 bottom-3 z-50 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                {ENV_LABEL} · dados de teste
            </div>
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="fixed right-4 bottom-4 z-50 rounded-full bg-neutral-900 px-4 py-2 text-sm text-white shadow-lg hover:bg-neutral-700"
            >
                Dar feedback
            </button>
            {open && (
                <div
                    role="dialog"
                    aria-label="Enviar feedback"
                    className="fixed right-4 bottom-16 z-50 w-[min(360px,calc(100vw-2rem))] rounded-lg border bg-white p-4 shadow-xl"
                >
                    <p className="mb-2 text-sm font-medium">O que você achou desta tela?</p>
                    <div className="mb-3 flex flex-wrap gap-1.5">
                        {KINDS.map((k) => (
                            <button
                                key={k.value}
                                type="button"
                                onClick={() => setKind(k.value)}
                                className={`rounded-full border px-2.5 py-1 text-xs ${
                                    kind === k.value ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-300"
                                }`}
                            >
                                {k.label}
                            </button>
                        ))}
                    </div>
                    <textarea
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        rows={4}
                        placeholder="Descreva com suas palavras. A tela e o card atual vão junto."
                        className="mb-3 w-full resize-none rounded border p-2 text-sm"
                    />
                    <div className="flex items-center justify-between">
                        <span className="text-xs text-neutral-500">
                            {state === "sent" && "Recebido, obrigado!"}
                            {state === "error" && "Não consegui enviar. Tenta de novo?"}
                        </span>
                        <button
                            type="button"
                            disabled={message.trim().length < 3 || state === "sending"}
                            onClick={submit}
                            className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
                        >
                            {state === "sending" ? "Enviando…" : "Enviar"}
                        </button>
                    </div>
                </div>
            )}
        </>
    );
}
