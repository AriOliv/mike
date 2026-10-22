"use client";

// Configurações → Tokens de acesso para agentes (doc 09 §3.1). A person
// creates a token for Claude Code or Codex to work in the Mike in their name,
// sees it exactly once, and can see when each one was last used and revoke
// it. Creating asks for the second factor; an account without one cannot.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, KeyRound } from "lucide-react";
import { MfaVerificationPopup, needsMfaVerification } from "@/app/components/popups/MfaVerificationPopup";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { Modal } from "@/app/components/modals/Modal";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { SettingsDescription, SettingsLabel } from "@/app/components/settings/SettingsText";
import { SETTINGS_CONTROL_CLASS } from "@/app/components/settings/SettingsTextInput";
import { EmptyState } from "@/app/components/ui/empty-state";
import { StatusChip, type ChipStatus } from "@/app/components/ui/status-chip";
import { showToast } from "@/app/components/ui/toast";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import {
    clientSetup,
    DEFAULT_SCOPES,
    lastUseLabel,
    mcpServerUrl,
    SCOPE_OPTIONS,
    STATE_LABEL,
    tokenState,
    validityLabel,
    VALIDITY_OPTIONS,
    type TokenState,
} from "@/app/lib/mcpTokens";
import {
    createMcpToken,
    isMfaRequiredError,
    listMcpTokens,
    revokeMcpToken,
    type McpAccessToken,
    type McpScope,
} from "@/app/lib/mikeApi";
import { errorCode, notifyError } from "@/app/lib/userFacingError";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

const PT = (action: string) => ({ lang: "pt" as const, action });

const CHIP: Record<TokenState, ChipStatus> = {
    ativo: "concluido",
    expira_em_breve: "aguardando",
    expirado: "a_fazer",
    revogado: "erro",
};

type Draft = { name: string; workspace: string; scopes: McpScope[]; days: number };

const EMPTY_DRAFT: Draft = { name: "", workspace: "personal", scopes: [...DEFAULT_SCOPES], days: 30 };

function CopyBlock({ label, text }: { label: string; text: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-gray-700">{label}</span>
                <PillButtonUI
                    tone="white"
                    size="xs"
                    onClick={() => {
                        void navigator.clipboard?.writeText(text).then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 2000);
                        });
                    }}
                >
                    {copied ? <Check aria-hidden="true" className="h-3 w-3" /> : <Copy aria-hidden="true" className="h-3 w-3" />}
                    {copied ? "Copiado" : "Copiar"}
                </PillButtonUI>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-gray-200 bg-gray-50 p-2 font-mono text-[11px] text-gray-800">
                {text}
            </pre>
        </div>
    );
}

export default function AgentTokensPage() {
    const router = useRouter();
    const { organizations } = useWorkspace();
    const [tokens, setTokens] = useState<McpAccessToken[] | null>(null);
    const [creating, setCreating] = useState(false);
    const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
    const [saving, setSaving] = useState(false);
    const [mfaOpen, setMfaOpen] = useState(false);
    const [needsEnrollment, setNeedsEnrollment] = useState(false);
    const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
    const [revoking, setRevoking] = useState<McpAccessToken | null>(null);
    const [revokeBusy, setRevokeBusy] = useState(false);

    const teams = useMemo(() => (organizations ?? []).filter((o) => o.kind !== "personal"), [organizations]);
    const workspaceName = useCallback(
        (id: string) => (id === "personal" ? "Pessoal" : (teams.find((o) => o.id === id)?.name ?? "Organização")),
        [teams],
    );
    const url = useMemo(
        () => mcpServerUrl(process.env.NEXT_PUBLIC_MCP_URL, typeof window === "undefined" ? "" : window.location.origin),
        [],
    );

    const load = useCallback(async () => {
        try {
            setTokens(await listMcpTokens());
        } catch (e) {
            setTokens([]);
            notifyError(e, PT("carregar seus tokens"));
        }
    }, []);
    useEffect(() => {
        void load();
    }, [load]);

    const submit = async () => {
        if (saving) return;
        setSaving(true);
        try {
            if (await needsMfaVerification()) {
                setMfaOpen(true);
                return;
            }
            const result = await createMcpToken({
                name: draft.name.trim(),
                workspace: draft.workspace,
                scopes: draft.scopes,
                expires_in_days: draft.days,
            });
            setCreating(false);
            setDraft(EMPTY_DRAFT);
            setCreated({ token: result.token, name: result.access_token.name });
            setTokens((list) => [result.access_token, ...(list ?? [])]);
        } catch (e) {
            if (isMfaRequiredError(e)) {
                setMfaOpen(true);
                return;
            }
            if (errorCode(e) === "mfa_enrollment_required") {
                setCreating(false);
                setNeedsEnrollment(true);
                return;
            }
            notifyError(e, PT("criar o token"));
        } finally {
            setSaving(false);
        }
    };

    const revoke = async () => {
        if (!revoking || revokeBusy) return;
        setRevokeBusy(true);
        try {
            const updated = await revokeMcpToken(revoking.id);
            setTokens((list) => (list ?? []).map((t) => (t.id === updated.id ? updated : t)));
            showToast({ tone: "success", message: `Token “${updated.name}” revogado. O agente perde o acesso na próxima chamada.` });
            setRevoking(null);
        } catch (e) {
            notifyError(e, PT("revogar o token"));
        } finally {
            setRevokeBusy(false);
        }
    };

    const canSubmit = draft.name.trim().length > 0 && draft.name.trim().length <= 80 && draft.scopes.length > 0 && !saving;
    const active = (tokens ?? []).filter((t) => tokenState(t) === "ativo" || tokenState(t) === "expira_em_breve");
    const inactive = (tokens ?? []).filter((t) => !active.includes(t));

    return (
        <div className="space-y-8">
            <section className="space-y-3" aria-labelledby="agent-tokens-heading">
                <div className="flex flex-wrap items-end justify-between gap-3">
                    <div className="space-y-1">
                        <SettingsHeading id="agent-tokens-heading">Tokens de acesso para agentes</SettingsHeading>
                        <SettingsDescription>
                            Um token deixa o Claude Code, o Codex ou outro agente trabalhar no Mike em seu nome, pelo
                            protocolo MCP. O agente vê só o que você vê na tela e, por enquanto, só lê: não muda nada.
                        </SettingsDescription>
                    </div>
                    <PillButtonUI tone="black" size="sm" onClick={() => setCreating(true)}>
                        <KeyRound aria-hidden="true" className="h-3.5 w-3.5" />
                        Criar token
                    </PillButtonUI>
                </div>

                <GlassCardUI>
                    {tokens === null ? (
                        <p className="p-4 text-xs text-gray-500" aria-busy="true">
                            Carregando…
                        </p>
                    ) : tokens.length === 0 ? (
                        <EmptyState
                            icon={<KeyRound aria-hidden="true" className="h-5 w-5" />}
                            title="Nenhum token ainda"
                            description="Crie um token para conectar o Claude Code ou o Codex ao Mike."
                        />
                    ) : (
                        <ul aria-label="Tokens de acesso">
                            {[...active, ...inactive].map((t) => {
                                const state = tokenState(t);
                                const live = state === "ativo" || state === "expira_em_breve";
                                return (
                                    <li key={t.id}>
                                        <SettingsRow>
                                            <div className="min-w-0 space-y-1">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <SettingsLabel>{t.name}</SettingsLabel>
                                                    <StatusChip status={CHIP[state]} label={STATE_LABEL[state]} />
                                                </div>
                                                <p className="break-words text-xs text-gray-500">
                                                    <span className="font-mono">{t.prefix}</span> · {workspaceName(t.workspace)} ·{" "}
                                                    {lastUseLabel(t)} · {validityLabel(t)}
                                                </p>
                                                <p className="text-[11px] text-gray-400">
                                                    {t.scopes
                                                        .map((s) => SCOPE_OPTIONS.find((o) => o.scope === s)?.label ?? s)
                                                        .join(" · ")}
                                                </p>
                                            </div>
                                            {live ? (
                                                <PillButtonUI tone="white" size="xs" onClick={() => setRevoking(t)} aria-label={`Revogar ${t.name}`}>
                                                    Revogar
                                                </PillButtonUI>
                                            ) : null}
                                        </SettingsRow>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </GlassCardUI>
                <p className="text-[11px] text-gray-400">
                    O token aparece uma única vez, na criação. Guarde-o como uma senha; se perder, revogue e crie outro.
                    Cada uso fica registrado na sua atividade como “agente em seu nome”.
                </p>
            </section>

            <Modal
                open={creating}
                onClose={() => !saving && setCreating(false)}
                breadcrumbs={["Novo token de acesso"]}
                primaryAction={{ label: saving ? "Criando…" : "Criar token", onClick: () => void submit(), disabled: !canSubmit }}
                cancelAction={{ label: "Cancelar", onClick: () => setCreating(false), disabled: saving }}
            >
                <form
                    className="space-y-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (canSubmit) void submit();
                    }}
                >
                    <label className="block space-y-1">
                        <span className="text-xs font-medium text-gray-700">Nome</span>
                        <input
                            className={SETTINGS_CONTROL_CLASS}
                            value={draft.name}
                            maxLength={80}
                            placeholder="Ex.: Claude Code do notebook"
                            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                            autoFocus
                        />
                    </label>
                    <label className="block space-y-1">
                        <span className="text-xs font-medium text-gray-700">Workspace</span>
                        <select
                            className={SETTINGS_CONTROL_CLASS}
                            value={draft.workspace}
                            onChange={(e) => setDraft({ ...draft, workspace: e.target.value })}
                        >
                            <option value="personal">Pessoal</option>
                            {teams.map((o) => (
                                <option key={o.id} value={o.id}>
                                    {o.name}
                                </option>
                            ))}
                        </select>
                        <span className="block text-[11px] text-gray-500">O agente vê só os contratos deste workspace.</span>
                    </label>
                    <fieldset className="space-y-1">
                        <legend className="text-xs font-medium text-gray-700">O que o agente pode fazer</legend>
                        {SCOPE_OPTIONS.map((o) => (
                            <label key={o.scope} className="flex items-start gap-2 py-0.5 text-xs text-gray-800">
                                <input
                                    type="checkbox"
                                    className="mt-0.5"
                                    checked={draft.scopes.includes(o.scope)}
                                    onChange={(e) =>
                                        setDraft({
                                            ...draft,
                                            scopes: e.target.checked
                                                ? [...draft.scopes, o.scope]
                                                : draft.scopes.filter((s) => s !== o.scope),
                                        })
                                    }
                                />
                                <span>
                                    {o.label} <span className="text-gray-500">— {o.hint}</span>
                                </span>
                            </label>
                        ))}
                        {draft.scopes.length === 0 ? <p className="text-[11px] text-red-700">Escolha ao menos uma permissão.</p> : null}
                    </fieldset>
                    <label className="block space-y-1">
                        <span className="text-xs font-medium text-gray-700">Validade</span>
                        <select
                            className={SETTINGS_CONTROL_CLASS}
                            value={draft.days}
                            onChange={(e) => setDraft({ ...draft, days: Number(e.target.value) })}
                        >
                            {VALIDITY_OPTIONS.map((v) => (
                                <option key={v.days} value={v.days}>
                                    {v.label}
                                </option>
                            ))}
                        </select>
                    </label>
                </form>
            </Modal>

            <Modal
                open={created !== null}
                onClose={() => setCreated(null)}
                breadcrumbs={[created ? `Token “${created.name}” criado` : ""]}
                primaryAction={{ label: "Já guardei o token", onClick: () => setCreated(null) }}
                cancelAction={false}
            >
                {created ? (
                    <div className="space-y-4">
                        <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
                            Copie agora: este token não aparece de novo. Não cole em chats, documentos ou repositórios.
                        </p>
                        <CopyBlock label="Token" text={created.token} />
                        {clientSetup(url, created.token).map((c) => (
                            <CopyBlock key={c.label} label={c.label} text={c.text} />
                        ))}
                        <p className="text-[11px] text-gray-500">
                            Depois de conectar, peça ao agente “mike_quem_sou” para conferir em nome de quem ele age.
                        </p>
                    </div>
                ) : null}
            </Modal>

            <MfaVerificationPopup
                open={mfaOpen}
                title="Confirme que é você"
                message="Digite o código do seu app autenticador para criar o token."
                onCancel={() => setMfaOpen(false)}
                onVerified={() => {
                    setMfaOpen(false);
                    void submit();
                }}
            />

            <ConfirmPopup
                open={needsEnrollment}
                title="Ative a verificação em duas etapas"
                message="Um token dá acesso aos seus contratos fora do navegador. Para criá-lo, sua conta precisa da verificação em duas etapas."
                confirmLabel="Ir para Segurança"
                cancelLabel="Agora não"
                onConfirm={() => {
                    setNeedsEnrollment(false);
                    router.push("/settings/security");
                }}
                onCancel={() => setNeedsEnrollment(false)}
            />

            <ConfirmPopup
                open={revoking !== null}
                title={revoking ? `Revogar “${revoking.name}”?` : ""}
                message="O agente que usa este token perde o acesso na próxima chamada. Não dá para desfazer; para voltar, crie outro token."
                confirmLabel="Revogar"
                confirmVariant="danger"
                confirmStatus={revokeBusy ? "loading" : "idle"}
                cancelLabel="Cancelar"
                onConfirm={() => void revoke()}
                onCancel={() => !revokeBusy && setRevoking(null)}
            />
        </div>
    );
}
