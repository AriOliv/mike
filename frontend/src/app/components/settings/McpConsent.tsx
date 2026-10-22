"use client";

// "Conectar um aplicativo ao Mike" (doc 09 §3.4): an MCP client such as
// Claude.ai sent the person here to approve it. The screen says who asks,
// for what, in which space, and where the answer goes; the person allows or
// refuses, and the browser goes back to the app. Signed in as usual, with
// the second factor when the person has one.

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Check, Plug } from "lucide-react";
import { MfaVerificationPopup, needsMfaVerification } from "@/app/components/popups/MfaVerificationPopup";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { EmptyState } from "@/app/components/ui/empty-state";
import { SETTINGS_CONTROL_CLASS } from "@/app/components/settings/SettingsTextInput";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { SCOPE_OPTIONS } from "@/app/lib/mcpTokens";
import {
    decideMcpAuthorization,
    getMcpAuthorization,
    isMfaRequiredError,
    type McpAuthorizationRequest,
} from "@/app/lib/mikeApi";
import { describeError } from "@/app/lib/userFacingError";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

/** Where the browser goes next; a seam for the tests. */
export const navigation = { go: (url: string) => window.location.assign(url) };

export function McpConsent() {
    const requestId = useSearchParams().get("pedido") ?? "";
    const { organizations, workspaceId } = useWorkspace();
    const teams = useMemo(() => (organizations ?? []).filter((o) => o.kind !== "personal"), [organizations]);
    const [request, setRequest] = useState<McpAuthorizationRequest | null>(null);
    const [error, setError] = useState<string | null>(
        requestId ? null : "Este pedido está incompleto. Volte ao aplicativo e conecte de novo.",
    );
    const [space, setSpace] = useState<string>("personal");
    const [busy, setBusy] = useState<"aprovar" | "recusar" | null>(null);
    const [mfaOpen, setMfaOpen] = useState(false);
    const [leaving, setLeaving] = useState<"aprovado" | "recusado" | null>(null);

    // Start in the space the person is working in, once: never over their choice.
    const [defaulted, setDefaulted] = useState(false);
    useEffect(() => {
        if (defaulted || !workspaceId || !teams.some((o) => o.id === workspaceId)) return;
        setSpace(workspaceId);
        setDefaulted(true);
    }, [workspaceId, teams, defaulted]);

    useEffect(() => {
        if (!requestId) return;
        let live = true;
        getMcpAuthorization(requestId)
            .then((r) => live && setRequest(r))
            .catch((e) => live && setError(describeError(e, { lang: "pt", action: "abrir este pedido de acesso" }).message));
        return () => {
            live = false;
        };
    }, [requestId]);

    const answer = async (approve: boolean) => {
        if (busy) return;
        setBusy(approve ? "aprovar" : "recusar");
        try {
            if (approve && (await needsMfaVerification())) {
                setMfaOpen(true);
                return;
            }
            const { redirect } = await decideMcpAuthorization({ pedido: requestId, aprovar: approve, espaco: approve ? space : undefined });
            setLeaving(approve ? "aprovado" : "recusado");
            navigation.go(redirect);
        } catch (e) {
            if (isMfaRequiredError(e)) {
                setMfaOpen(true);
                return;
            }
            setError(describeError(e, { lang: "pt", action: approve ? "conectar o aplicativo" : "recusar o pedido" }).message);
        } finally {
            setBusy(null);
        }
    };

    const appName = request?.client.client_name || "Um aplicativo";
    const labels = (request?.scopes ?? []).map((s) => SCOPE_OPTIONS.find((o) => o.scope === s) ?? { scope: s, label: s, hint: "" });

    return (
        <div className="flex h-full flex-col">
            <PageHeader>Conectar um aplicativo</PageHeader>
            <div className="mx-auto w-full max-w-md px-4 py-12">
                {error ? (
                    <EmptyState tone="error" icon={<Plug />} title="Não deu para conectar" description={error} />
                ) : leaving ? (
                    <EmptyState
                        icon={<Check />}
                        title={leaving === "aprovado" ? "Aplicativo conectado" : "Pedido recusado"}
                        description="Voltando ao aplicativo…"
                    />
                ) : request ? (
                    <section aria-labelledby="mcp-consent-title" className="space-y-5 rounded-2xl border border-gray-200 bg-app-surface p-5">
                        <div className="space-y-1">
                            <h1 id="mcp-consent-title" className="text-base font-medium text-gray-900">
                                {appName} quer acessar o Mike em seu nome
                            </h1>
                            <p className="text-xs text-gray-600">
                                Depois de aprovar, a resposta volta para{" "}
                                <strong className="font-mono text-gray-900">{request.client.redirect_host}</strong>. Só aprove se
                                foi você que pediu para conectar, agora, nesse aplicativo.
                            </p>
                        </div>

                        <div className="space-y-1">
                            <p className="text-xs font-medium text-gray-700">O aplicativo vai poder, só lendo:</p>
                            <ul className="space-y-1" aria-label="Permissões pedidas">
                                {labels.map((o) => (
                                    <li key={o.scope} className="text-xs text-gray-800">
                                        • {o.label}
                                        {o.hint ? <span className="text-gray-500"> — {o.hint}</span> : null}
                                    </li>
                                ))}
                            </ul>
                            <p className="text-[11px] text-gray-500">Ele vê só o que você vê na tela e não muda nada no Mike.</p>
                        </div>

                        <div className="space-y-1">
                            <label htmlFor="mcp-consent-space" className="block text-xs font-medium text-gray-700">
                                Espaço
                            </label>
                            <select
                                id="mcp-consent-space"
                                className={SETTINGS_CONTROL_CLASS}
                                value={space}
                                onChange={(e) => {
                                    setDefaulted(true);
                                    setSpace(e.target.value);
                                }}
                            >
                                <option value="personal">Pessoal</option>
                                {teams.map((o) => (
                                    <option key={o.id} value={o.id}>
                                        {o.name}
                                    </option>
                                ))}
                            </select>
                            <span className="block text-[11px] text-gray-500">O aplicativo vê só os contratos deste espaço.</span>
                        </div>

                        <div className="flex flex-wrap justify-end gap-2">
                            <PillButtonUI tone="white" size="sm" onClick={() => void answer(false)} loading={busy === "recusar"} disabled={busy !== null}>
                                Recusar
                            </PillButtonUI>
                            <PillButtonUI tone="black" size="sm" onClick={() => void answer(true)} loading={busy === "aprovar"} disabled={busy !== null}>
                                Permitir acesso
                            </PillButtonUI>
                        </div>
                        <p className="text-[11px] text-gray-400">
                            Você desconecta quando quiser, em Configurações → Tokens para agentes.
                        </p>
                    </section>
                ) : (
                    <div className="h-48 animate-pulse rounded-2xl bg-gray-100" aria-label="Carregando" />
                )}
            </div>
            <MfaVerificationPopup
                open={mfaOpen}
                title="Confirme que é você"
                message="Digite o código do seu app autenticador para conectar o aplicativo."
                onCancel={() => setMfaOpen(false)}
                onVerified={() => {
                    setMfaOpen(false);
                    void answer(true);
                }}
            />
        </div>
    );
}
