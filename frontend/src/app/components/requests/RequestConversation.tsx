"use client";

import { useState } from "react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { UserAvatar } from "@/app/components/ui/user-avatar";
import type { RequestMessage } from "@/app/lib/mikeApi";
import { relativeTime } from "@/app/lib/activityFeed";

const LABEL: Record<RequestMessage["kind"], string> = {
    question: "perguntou",
    answer: "respondeu",
    note: "escreveu",
};

/**
 * The thread between the team and whoever asked. The team can send a note or
 * a question (which pauses the SLA); the requester's message is always an
 * answer.
 */
export function RequestConversation({
    messages,
    mode,
    disabled,
    onSend,
    now,
}: {
    messages: RequestMessage[];
    /** "team" offers "Perguntar ao solicitante"; "requester" only answers; "readonly" shows. */
    mode: "team" | "requester" | "readonly";
    disabled?: boolean;
    onSend?: (body: string, kind: "question" | "note") => Promise<void>;
    now?: number;
}) {
    const [text, setText] = useState("");
    const [busy, setBusy] = useState<"question" | "note" | null>(null);

    async function send(kind: "question" | "note") {
        if (!text.trim() || !onSend) return;
        setBusy(kind);
        try {
            await onSend(text.trim(), kind);
            setText("");
        } finally {
            setBusy(null);
        }
    }

    return (
        <div className="text-xs">
            {messages.length === 0 ? (
                <p className="text-gray-500">
                    {mode === "team"
                        ? "Nenhuma conversa ainda. Se faltar algo, pergunte aqui: o prazo pausa até a resposta."
                        : "Nenhuma mensagem ainda. Se o Legal precisar de algo, a pergunta aparece aqui e no seu e-mail."}
                </p>
            ) : (
                <ol className="space-y-3">
                    {messages.map((m) => (
                        <li key={m.id} className="flex gap-2">
                            <UserAvatar size="sm" name={m.author_name} email={m.author_email} />
                            <div className="min-w-0 flex-1">
                                <p className="text-gray-500">
                                    <span className="text-gray-900">{m.author_name ?? m.author_email}</span> {LABEL[m.kind]} ·{" "}
                                    {relativeTime(m.created_at, now)}
                                </p>
                                <p
                                    className={
                                        "mt-0.5 whitespace-pre-wrap break-words " +
                                        (m.kind === "question" ? "text-amber-800" : "text-gray-800")
                                    }
                                >
                                    {m.body}
                                </p>
                            </div>
                        </li>
                    ))}
                </ol>
            )}
            {mode !== "readonly" && onSend ? (
                <div className="mt-3">
                    <label className="sr-only" htmlFor="request-message">
                        Mensagem
                    </label>
                    <textarea
                        id="request-message"
                        value={text}
                        disabled={disabled}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                e.preventDefault();
                                void send(mode === "team" ? "note" : "note");
                            }
                        }}
                        placeholder={mode === "team" ? "Escreva ao solicitante…" : "Responda ao Legal…"}
                        className="min-h-[64px] w-full resize-y rounded-lg border border-gray-200 bg-app-surface px-3 py-2 text-xs text-gray-900 placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-50"
                    />
                    <div className="mt-2 flex flex-wrap gap-2">
                        {mode === "team" ? (
                            <>
                                <PillButtonUI
                                    tone="black"
                                    size="xs"
                                    disabled={disabled || !text.trim()}
                                    loading={busy === "question"}
                                    onClick={() => send("question")}
                                >
                                    Perguntar ao solicitante
                                </PillButtonUI>
                                <PillButtonUI
                                    tone="white"
                                    size="xs"
                                    disabled={disabled || !text.trim()}
                                    loading={busy === "note"}
                                    onClick={() => send("note")}
                                >
                                    Enviar recado
                                </PillButtonUI>
                            </>
                        ) : (
                            <PillButtonUI
                                tone="black"
                                size="xs"
                                disabled={disabled || !text.trim()}
                                loading={busy !== null}
                                onClick={() => send("note")}
                            >
                                Responder
                            </PillButtonUI>
                        )}
                    </div>
                </div>
            ) : null}
        </div>
    );
}
