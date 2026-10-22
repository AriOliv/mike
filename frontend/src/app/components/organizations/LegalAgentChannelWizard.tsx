"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { ModalUI } from "@/shared/ui/ModalUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import {
    saveLegalAgentChannel,
    type LegalAgentChannel,
    type LegalAgentChannelKind,
    type LegalAgentChannelSetup,
} from "@/app/lib/mikeApi";
import { CHANNEL_LABEL, channelConfig, channelDraft } from "@/app/lib/legalAgent";
import { describeError } from "@/app/lib/userFacingError";

const FIELD =
    "w-full rounded-lg border border-gray-200 bg-app-surface px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40";

const FIELDS: Record<LegalAgentChannelKind, { key: string; label: string; placeholder: string; hint?: string }[]> = {
    slack: [
        { key: "workspace", label: "Workspace do Slack", placeholder: "Avenia" },
        { key: "channels", label: "Canais onde ele atende", placeholder: "juridico, pedidos-legal", hint: "Vazio: só mensagens diretas." },
        { key: "bot_name", label: "Nome do bot", placeholder: "advogado-mike" },
    ],
    telegram: [{ key: "bot_username", label: "Usuário do bot", placeholder: "acme_juridico_bot" }],
    whatsapp: [
        { key: "business_name", label: "Empresa na conta do WhatsApp Business", placeholder: "Avenia" },
        { key: "phone_last4", label: "4 últimos dígitos do número", placeholder: "1234" },
    ],
};

/**
 * The installation assistant for one chat channel, in two steps: the details
 * that are safe to keep (never a token), then the generated files and the
 * steps to follow. Nothing is connected from here.
 */
export function LegalAgentChannelWizard({
    orgId,
    channel,
    initialSetup,
    onClose,
    onSaved,
}: {
    orgId: string;
    /** An existing channel to edit or to see the setup of; null for a new one. */
    channel: LegalAgentChannel | null;
    /** The setup already loaded, to open straight on the files. */
    initialSetup?: LegalAgentChannelSetup | null;
    onClose: () => void;
    onSaved: (channel: LegalAgentChannel) => void;
}) {
    const [kind, setKind] = useState<LegalAgentChannelKind>(channel?.kind ?? "slack");
    const [name, setName] = useState(channel?.name ?? "");
    const [draft, setDraft] = useState<Record<string, string>>(() => channelDraft(channel?.kind ?? "slack", channel?.config));
    const [setup, setSetup] = useState<LegalAgentChannelSetup | null>(initialSetup ?? null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState<string | null>(null);

    const pickKind = (next: LegalAgentChannelKind) => {
        setKind(next);
        setDraft(channelDraft(next));
        setError(null);
    };

    const generate = async () => {
        setSaving(true);
        setError(null);
        try {
            const saved = await saveLegalAgentChannel(orgId, {
                id: channel?.id,
                kind,
                name: name.trim(),
                config: channelConfig(kind, draft),
            });
            setSetup(saved.setup);
            onSaved(saved.channel);
        } catch (e) {
            setError(describeError(e, { lang: "pt", action: "gerar a configuração do canal" }).message);
        } finally {
            setSaving(false);
        }
    };

    const copy = async (fileName: string, content: string) => {
        try {
            await navigator.clipboard.writeText(content);
            setCopied(fileName);
        } catch {
            setError("Não consegui copiar. Selecione o texto e copie à mão.");
        }
    };

    return (
        <ModalUI
            open
            onClose={onClose}
            size="lg"
            ariaLabel="Conectar canal"
            breadcrumbs={["Agente do Legal", setup ? "Instalação" : "Conectar canal"]}
            footerStatus={
                error ? (
                    <span role="alert" className="text-xs text-red-600">
                        {error}
                    </span>
                ) : (
                    <span className="text-xs text-gray-500">Tokens e segredos ficam no cofre do deploy, nunca no Mike.</span>
                )
            }
            cancelAction={
                <PillButtonUI tone="white" onClick={onClose}>
                    {setup ? "Fechar" : "Cancelar"}
                </PillButtonUI>
            }
            primaryAction={
                setup ? (
                    <PillButtonUI tone="white" onClick={() => setSetup(null)}>
                        Editar dados
                    </PillButtonUI>
                ) : (
                    <PillButtonUI tone="black" onClick={() => void generate()} loading={saving} disabled={!name.trim()}>
                        Gerar configuração
                    </PillButtonUI>
                )
            }
        >
            {setup ? (
                <div className="space-y-5">
                    {setup.warnings.length > 0 ? (
                        <ul className="space-y-1 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
                            {setup.warnings.map((w) => (
                                <li key={w}>{w}</li>
                            ))}
                        </ul>
                    ) : null}
                    <ol className="space-y-3">
                        {setup.steps.map((step, i) => (
                            <li key={step.title} className="flex gap-3 text-sm">
                                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-900 text-[11px] text-white">
                                    {i + 1}
                                </span>
                                <span>
                                    <span className="block font-medium text-gray-900">{step.title}</span>
                                    <span className="block text-gray-600">{step.detail}</span>
                                </span>
                            </li>
                        ))}
                    </ol>
                    {setup.files.map((file) => (
                        <section key={file.name} aria-label={file.name} className="space-y-1">
                            <div className="flex items-center justify-between gap-2">
                                <h3 className="font-mono text-xs text-gray-700">{file.name}</h3>
                                <PillButtonUI tone="white" size="xs" onClick={() => void copy(file.name, file.content)}>
                                    {copied === file.name ? (
                                        <Check aria-hidden="true" className="h-3 w-3" />
                                    ) : (
                                        <Copy aria-hidden="true" className="h-3 w-3" />
                                    )}
                                    {copied === file.name ? "Copiado" : "Copiar"}
                                </PillButtonUI>
                            </div>
                            <pre className="max-h-64 overflow-auto rounded-lg bg-gray-50 p-3 text-[11px] leading-relaxed text-gray-800">
                                {file.content}
                            </pre>
                        </section>
                    ))}
                </div>
            ) : (
                <div className="space-y-4">
                    <div role="group" aria-label="Canal" className="flex flex-wrap gap-2">
                        {(Object.keys(CHANNEL_LABEL) as LegalAgentChannelKind[]).map((k) => (
                            <TabPillButtonUI key={k} active={kind === k} onClick={() => pickKind(k)} disabled={!!channel}>
                                {CHANNEL_LABEL[k].label}
                            </TabPillButtonUI>
                        ))}
                    </div>
                    <p className="text-xs text-gray-500">{CHANNEL_LABEL[kind].hint}</p>
                    <label className="block space-y-1 text-sm">
                        <span className="text-gray-700">Nome do canal no Mike</span>
                        <input
                            className={FIELD}
                            value={name}
                            maxLength={80}
                            onChange={(e) => setName(e.target.value)}
                            placeholder={`${CHANNEL_LABEL[kind].label} do Legal`}
                        />
                    </label>
                    {FIELDS[kind].map((field) => (
                        <label key={field.key} className="block space-y-1 text-sm">
                            <span className="text-gray-700">{field.label}</span>
                            <input
                                className={FIELD}
                                value={draft[field.key] ?? ""}
                                onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
                                placeholder={field.placeholder}
                            />
                            {field.hint ? <span className="block text-xs text-gray-500">{field.hint}</span> : null}
                        </label>
                    ))}
                    {kind === "telegram" ? (
                        <div role="group" aria-label="Como recebe mensagens" className="flex flex-wrap gap-2">
                            <TabPillButtonUI active={draft.mode !== "webhook"} onClick={() => setDraft({ ...draft, mode: "polling" })}>
                                Busca mensagens (sem endereço público)
                            </TabPillButtonUI>
                            <TabPillButtonUI active={draft.mode === "webhook"} onClick={() => setDraft({ ...draft, mode: "webhook" })}>
                                Webhook
                            </TabPillButtonUI>
                        </div>
                    ) : null}
                </div>
            )}
        </ModalUI>
    );
}
