"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CircleCheck, FileText, MessageCircleQuestion } from "lucide-react";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { RequestConversation } from "@/app/components/requests/RequestConversation";
import { RequestSteps } from "@/app/components/requests/RequestSteps";
import { getRequest, MikeApiError, postRequestMessage, type LegalRequest } from "@/app/lib/mikeApi";
import { formatDate, slaText } from "@/app/lib/requests";
import { notifyError } from "@/app/lib/userFacingError";

interface Props {
    params: Promise<{ id: string }>;
}

/**
 * One request, as whoever asked (or an invited outside participant) sees it:
 * where it stands in four steps, who is on it, the Legal's questions, and
 * what was delivered. The team is sent to the queue's panel instead.
 */
export default function PedidoPage({ params }: Props) {
    const { id } = use(params);
    const router = useRouter();
    const search = useSearchParams();
    const [request, setRequest] = useState<LegalRequest | null>(null);
    const [missing, setMissing] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);

    useEffect(() => {
        let cancelled = false;
        getRequest(id)
            .then((data) => {
                if (cancelled) return;
                if (data.audience === "team") router.replace(`/pedidos?pedido=${id}`);
                else setRequest(data);
            })
            .catch((err) => {
                if (cancelled) return;
                if (err instanceof MikeApiError && err.status === 404) setMissing(true);
                else notifyError(err, { lang: "pt", action: "abrir este pedido", onRetry: () => setReloadKey((k) => k + 1) });
            });
        return () => {
            cancelled = true;
        };
    }, [id, router, reloadKey]);

    if (missing) {
        return (
            <div className="flex h-full flex-col">
                <PageHeader>Pedido</PageHeader>
                <div className="mx-3 py-16 md:mx-6.5">
                    <EmptyState
                        title="Pedido não encontrado"
                        description="Ele não existe ou você não tem acesso. Se foi convidado, entre com o e-mail do convite."
                        action={
                            <Link href="/pedidos">
                                <PillButtonUI tone="white">Ver meus pedidos</PillButtonUI>
                            </Link>
                        }
                    />
                </div>
            </div>
        );
    }

    if (!request) {
        return (
            <div className="flex h-full flex-col">
                <PageHeader loading>Pedido</PageHeader>
                <div className="mx-3 max-w-2xl space-y-3 py-4 md:mx-6.5" aria-busy="true">
                    <div className="h-7 w-72 animate-pulse rounded bg-gray-100" />
                    <div className="h-4 w-96 max-w-full animate-pulse rounded bg-gray-100" />
                    <div className="h-24 w-full animate-pulse rounded bg-gray-100" />
                </div>
            </div>
        );
    }

    const r = request;
    const waiting = r.status === "aguardando_solicitante";
    const closed = r.status === "entregue" || r.status === "cancelado";
    const canAnswer = !closed && r.audience === "requester";

    return (
        <div className="flex h-full flex-col">
            <PageHeader
                breadcrumbs={[
                    { label: r.audience === "guest" ? "Pedido compartilhado" : "Meus pedidos", onClick: () => router.push("/pedidos") },
                    { label: r.code },
                ]}
            />
            <div className="mx-3 min-h-0 flex-1 overflow-y-auto pb-10 md:mx-6.5">
                <article className="max-w-2xl">
                    {search.get("criado") === "1" ? (
                        <p role="status" className="mb-4 flex items-start gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                            <CircleCheck aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
                            Pedido enviado. Você recebe um e-mail a cada novidade; esta página mostra tudo também.
                        </p>
                    ) : null}
                    <h1 className="break-words font-serif text-2xl text-gray-900">{r.title}</h1>
                    <p className="mt-1 text-xs text-gray-500">
                        <span className="font-mono">{r.code}</span> · {r.kind_label}
                        {r.counterparty ? ` · ${r.counterparty}` : ""} · pedido em {formatDate(r.created_at)}
                    </p>

                    <RequestSteps step={r.step} className="mt-4" />

                    <dl className="mt-5 grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                        <dt className="text-gray-500">Quem cuida</dt>
                        <dd className="text-gray-900">{r.assignee_name ?? "o Legal está distribuindo"}</dd>
                        <dt className="text-gray-500">Prazo</dt>
                        <dd className="text-gray-900">
                            {closed ? "encerrado" : `${formatDate(r.due_at)} · ${slaText(r.sla, r.due_at)}`}
                        </dd>
                        {r.audience === "guest" ? (
                            <>
                                <dt className="text-gray-500">Pedido por</dt>
                                <dd className="text-gray-900">{r.requester_name ?? r.requester_email}</dd>
                            </>
                        ) : null}
                    </dl>

                    {waiting ? (
                        <p className="mt-5 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
                            <MessageCircleQuestion aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
                            O Legal precisa de uma resposta sua para seguir. O prazo fica pausado até você responder.
                        </p>
                    ) : null}

                    {r.delivery ? (
                        <section className="mt-6 rounded-xl border border-gray-200 bg-app-surface p-4">
                            <h2 className="flex items-center gap-1.5 text-sm font-medium text-gray-900">
                                <CircleCheck aria-hidden="true" className="h-4 w-4 text-emerald-600" />
                                Entrega do Legal
                                {r.delivery.delivered_at ? (
                                    <span className="text-xs font-normal text-gray-500">· {formatDate(r.delivery.delivered_at)}</span>
                                ) : null}
                            </h2>
                            {r.delivery.message ? (
                                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-gray-800">{r.delivery.message}</p>
                            ) : null}
                            {r.delivery.documents.length ? (
                                <ul className="mt-3 space-y-1">
                                    {r.delivery.documents.map((d) => (
                                        <li key={d.id} className="flex items-center gap-1.5 text-xs text-gray-700">
                                            <FileText aria-hidden="true" className="h-3.5 w-3.5 text-gray-400" />
                                            <span className="break-all">{d.filename}</span>
                                        </li>
                                    ))}
                                </ul>
                            ) : null}
                        </section>
                    ) : null}

                    {r.summary ? (
                        <section className="mt-6">
                            <h2 className="mb-1 text-xs font-medium text-gray-500">Como o Legal entendeu o pedido</h2>
                            <p className="text-sm text-gray-800">{r.summary}</p>
                        </section>
                    ) : null}

                    <section className="mt-6">
                        <h2 className="mb-2 text-xs font-medium text-gray-500">Conversa com o Legal</h2>
                        <RequestConversation
                            messages={r.messages}
                            mode={canAnswer || (r.audience === "guest" && !closed) ? "requester" : "readonly"}
                            onSend={async (body) => {
                                try {
                                    setRequest(await postRequestMessage(r.id, body));
                                } catch (err) {
                                    notifyError(err, { lang: "pt", action: "enviar sua resposta" });
                                    throw err;
                                }
                            }}
                        />
                    </section>

                    {r.context ? (
                        <details className="mt-6 text-xs text-gray-600">
                            <summary className="cursor-pointer text-gray-500">O que foi pedido</summary>
                            <p className="mt-1 whitespace-pre-wrap break-words">{r.context}</p>
                        </details>
                    ) : null}
                </article>
            </div>
        </div>
    );
}
