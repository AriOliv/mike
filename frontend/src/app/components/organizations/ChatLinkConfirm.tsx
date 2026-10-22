"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Check, Link2 } from "lucide-react";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { confirmChatLink, previewChatLink } from "@/app/lib/mikeApi";
import { CHANNEL_LABEL } from "@/app/lib/legalAgent";
import { describeError } from "@/app/lib/userFacingError";

type Preview = Awaited<ReturnType<typeof previewChatLink>>;

/**
 * "Sou eu": the person, logged in, confirms the chat account that opened this
 * link is theirs. The link is made for the logged-in account, whoever opened
 * it, so a link opened by someone else only links them.
 */
export function ChatLinkConfirm() {
    const token = useSearchParams().get("t") ?? "";
    const [preview, setPreview] = useState<Preview | null>(null);
    const [error, setError] = useState<string | null>(token ? null : "Este link está incompleto. Peça um novo ao assistente no chat.");
    const [done, setDone] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!token) return;
        let live = true;
        previewChatLink(token)
            .then((p) => live && setPreview(p))
            .catch((e) => live && setError(describeError(e, { lang: "pt", action: "abrir este link" }).message));
        return () => {
            live = false;
        };
    }, [token]);

    const confirm = async () => {
        setSaving(true);
        try {
            await confirmChatLink(token);
            setDone(true);
        } catch (e) {
            setError(describeError(e, { lang: "pt", action: "ligar a conta" }).message);
        } finally {
            setSaving(false);
        }
    };

    const channel = preview ? CHANNEL_LABEL[preview.platform].label : "";
    return (
        <div className="flex h-full flex-col">
            <PageHeader>Ligar conta de chat</PageHeader>
            <div className="mx-auto w-full max-w-md px-4 py-16">
                {error ? (
                    <EmptyState tone="error" icon={<Link2 />} title="Não deu para ligar a conta" description={error} />
                ) : done ? (
                    <EmptyState
                        icon={<Check />}
                        title="Conta ligada"
                        description={`Pode voltar ao ${channel}. O assistente do Legal agora fala com você como ${preview?.email ?? "você"}.`}
                    />
                ) : preview ? (
                    <EmptyState
                        icon={<Link2 />}
                        title={`Ligar sua conta do ${channel}`}
                        description={`O assistente do Legal de ${preview.org_name} vai falar com você no ${channel} como ${preview.email ?? "sua conta do Mike"}: abre e acompanha os seus pedidos. Você pode desligar quando quiser, em Configurações.`}
                        action={
                            <PillButtonUI tone="black" onClick={() => void confirm()} loading={saving}>
                                Sou eu, ligar a conta
                            </PillButtonUI>
                        }
                    />
                ) : (
                    <div className="h-32 animate-pulse rounded-xl bg-gray-100" aria-label="Carregando" />
                )}
            </div>
        </div>
    );
}
