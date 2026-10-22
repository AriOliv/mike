"use client";

import { useCallback, useEffect, useState } from "react";
import { Lock, Plus, Trash2 } from "lucide-react";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { SettingsDescription, SettingsLabel } from "@/app/components/settings/SettingsText";
import { EmptyState } from "@/app/components/ui/empty-state";
import { StatusChip } from "@/app/components/ui/status-chip";
import { showToast } from "@/app/components/ui/toast";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";
import {
    deleteLegalAgentChannel,
    getLegalAgent,
    getLegalAgentChannelSetup,
    saveLegalAgentSettings,
    setLegalAgentChannelStatus,
    type LegalAgentChannel,
    type LegalAgentChannelSetup,
    type LegalAgentSettings as Settings,
    type LegalAgentTone,
    type LegalAgentView,
} from "@/app/lib/mikeApi";
import {
    CHANNEL_LABEL,
    CHANNEL_STATUS_LABEL,
    hoursSummary,
    KIND_LABEL,
    parseDays,
    RISK_LABEL,
    TONE_LABEL,
    toggle,
    toPayload,
    WEEKDAYS,
} from "@/app/lib/legalAgent";
import { describeError, notifyError } from "@/app/lib/userFacingError";
import { LegalAgentChannelWizard } from "./LegalAgentChannelWizard";
import { useOrganizationSettings } from "./OrganizationSettingsShell";

const FIELD =
    "w-full rounded-lg border border-gray-200 bg-app-surface px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-60";

// The legal team's chat agent, in an organization's settings: who it is, how
// it talks, when it answers, who may ask for what, when it hands over to a
// person, and the chat channels it is set up for. Every member sees it (it is
// what the agent tells them it does); owners and admins change it.

export function LegalAgentSettings() {
    const { orgId } = useOrganizationSettings();
    const [view, setView] = useState<LegalAgentView | null>(null);
    const [form, setForm] = useState<Settings | null>(null);
    const [deadlineText, setDeadlineText] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [wizard, setWizard] = useState<{ channel: LegalAgentChannel | null; setup: LegalAgentChannelSetup | null } | null>(null);
    const [newArea, setNewArea] = useState("");

    const load = useCallback(async () => {
        try {
            const next = await getLegalAgent(orgId);
            setView(next);
            setForm(next.settings);
            setDeadlineText(next.settings.proactive.deadline_days.join(", "));
            setError(null);
        } catch (e) {
            setError(describeError(e, { lang: "pt", action: "carregar o agente do Legal" }).message);
        }
    }, [orgId]);

    useEffect(() => {
        void load();
    }, [load]);

    if (error && !view)
        return (
            <EmptyState
                tone="error"
                title="Não consegui carregar o agente do Legal"
                description={error}
                action={
                    <PillButtonUI tone="white" onClick={() => void load()}>
                        Tentar de novo
                    </PillButtonUI>
                }
            />
        );
    if (!view || !form) return <div className="h-40 animate-pulse rounded-xl bg-gray-100" aria-label="Carregando" />;

    const canManage = view.can_manage;
    const set = (patch: Partial<Settings>) => setForm({ ...form, ...patch });
    const deadlines = parseDays(deadlineText);

    const save = async () => {
        if (!deadlines) return;
        setSaving(true);
        try {
            const saved = await saveLegalAgentSettings(orgId, toPayload({ ...form, proactive: { ...form.proactive, deadline_days: deadlines } }));
            setForm(saved);
            setView({ ...view, settings: saved });
            setDeadlineText(saved.proactive.deadline_days.join(", "));
            showToast({ tone: "success", message: "Configurações do agente salvas." });
        } catch (e) {
            notifyError(e, { lang: "pt", action: "salvar o agente do Legal" });
        } finally {
            setSaving(false);
        }
    };

    const replaceChannel = (channel: LegalAgentChannel) => {
        const others = view.channels.filter((c) => c.id !== channel.id);
        setView({ ...view, channels: [...others, channel].sort((a, b) => a.created_at.localeCompare(b.created_at)) });
    };

    const openSetup = async (channel: LegalAgentChannel) => {
        try {
            setWizard({ channel, setup: await getLegalAgentChannelSetup(orgId, channel.id) });
        } catch (e) {
            notifyError(e, { lang: "pt", action: "abrir a instalação do canal" });
        }
    };

    const changeStatus = async (channel: LegalAgentChannel, status: LegalAgentChannel["status"]) => {
        try {
            replaceChannel(await setLegalAgentChannelStatus(orgId, channel.id, status));
        } catch (e) {
            notifyError(e, { lang: "pt", action: "mudar a situação do canal" });
        }
    };

    const remove = async (channel: LegalAgentChannel) => {
        try {
            await deleteLegalAgentChannel(orgId, channel.id);
            setView({ ...view, channels: view.channels.filter((c) => c.id !== channel.id) });
        } catch (e) {
            notifyError(e, { lang: "pt", action: "remover o canal" });
        }
    };

    const addArea = () => {
        const area = newArea.trim();
        if (!area || form.permissions.some((p) => p.area.toLowerCase() === area.toLowerCase())) return;
        set({ permissions: [...form.permissions, { area, kinds: [] }] });
        setNewArea("");
    };

    return (
        <div className="space-y-8">
            <section aria-labelledby="agent-identity" className="space-y-3">
                <SettingsHeading id="agent-identity">Agente do Legal</SettingsHeading>
                <p className="text-sm text-gray-500">
                    O assistente que atende as áreas no chat. Ele conversa no Slack, no WhatsApp ou no Telegram; o trabalho e o
                    registro ficam no Mike.
                    {!canManage ? " Só quem administra a organização pode mudar estas configurações." : ""}
                </p>
                <GlassCardUI>
                    <SettingsRow>
                        <div className="space-y-1">
                            <SettingsLabel>Agente ligado</SettingsLabel>
                            <SettingsDescription>Desligado, ele não responde em nenhum canal.</SettingsDescription>
                        </div>
                        <ToggleSwitchUI
                            checked={form.enabled}
                            onCheckedChange={(enabled) => set({ enabled })}
                            disabled={!canManage}
                            aria-label="Agente ligado"
                        />
                    </SettingsRow>
                    <SettingsRow layout="stacked">
                        <label className="block space-y-1 text-sm">
                            <SettingsLabel>Nome</SettingsLabel>
                            <input
                                className={FIELD}
                                value={form.display_name}
                                maxLength={60}
                                disabled={!canManage}
                                onChange={(e) => set({ display_name: e.target.value })}
                            />
                            <SettingsDescription>Ele se apresenta como assistente com IA, nunca como advogado.</SettingsDescription>
                        </label>
                        <label className="block space-y-1 text-sm">
                            <SettingsLabel>Como ele se apresenta e trabalha</SettingsLabel>
                            <textarea
                                className={`${FIELD} min-h-28`}
                                value={form.persona}
                                maxLength={2000}
                                disabled={!canManage}
                                onChange={(e) => set({ persona: e.target.value })}
                            />
                        </label>
                        <div className="space-y-1">
                            <SettingsLabel>Tom</SettingsLabel>
                            <div role="group" aria-label="Tom" className="flex flex-wrap gap-2">
                                {(Object.keys(TONE_LABEL) as LegalAgentTone[]).map((tone) => (
                                    <TabPillButtonUI
                                        key={tone}
                                        active={form.tone === tone}
                                        disabled={!canManage}
                                        onClick={() => set({ tone })}
                                    >
                                        {TONE_LABEL[tone].label}
                                    </TabPillButtonUI>
                                ))}
                            </div>
                            <SettingsDescription>{TONE_LABEL[form.tone].hint}</SettingsDescription>
                        </div>
                        <p className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
                            Em toda resposta: “{view.options.disclaimer}”
                        </p>
                    </SettingsRow>
                </GlassCardUI>
            </section>

            <section aria-labelledby="agent-hours" className="space-y-3">
                <SettingsHeading id="agent-hours">Horário</SettingsHeading>
                <GlassCardUI>
                    <SettingsRow layout="stacked">
                        <div role="group" aria-label="Dias de atendimento" className="flex flex-wrap gap-2">
                            {WEEKDAYS.map(({ day, short }) => (
                                <TabPillButtonUI
                                    key={day}
                                    active={form.hours.days.includes(day)}
                                    disabled={!canManage}
                                    onClick={() => set({ hours: { ...form.hours, days: toggle(form.hours.days, day) } })}
                                >
                                    {short}
                                </TabPillButtonUI>
                            ))}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                            <label className="flex items-center gap-2">
                                <span className="text-gray-700">Das</span>
                                <input
                                    type="time"
                                    aria-label="Início"
                                    className={`${FIELD} w-28`}
                                    value={form.hours.start}
                                    disabled={!canManage}
                                    onChange={(e) => set({ hours: { ...form.hours, start: e.target.value } })}
                                />
                            </label>
                            <label className="flex items-center gap-2">
                                <span className="text-gray-700">às</span>
                                <input
                                    type="time"
                                    aria-label="Fim"
                                    className={`${FIELD} w-28`}
                                    value={form.hours.end}
                                    disabled={!canManage}
                                    onChange={(e) => set({ hours: { ...form.hours, end: e.target.value } })}
                                />
                            </label>
                            <span className="text-xs text-gray-500">{hoursSummary(form.hours)} · {form.hours.timezone}</span>
                        </div>
                        <div role="group" aria-label="Fora do horário" className="flex flex-wrap gap-2">
                            <TabPillButtonUI
                                active={form.hours.outside === "avisa_e_registra"}
                                disabled={!canManage}
                                onClick={() => set({ hours: { ...form.hours, outside: "avisa_e_registra" } })}
                            >
                                Fora do horário: avisa e registra o pedido
                            </TabPillButtonUI>
                            <TabPillButtonUI
                                active={form.hours.outside === "so_registra"}
                                disabled={!canManage}
                                onClick={() => set({ hours: { ...form.hours, outside: "so_registra" } })}
                            >
                                Só registra
                            </TabPillButtonUI>
                        </div>
                    </SettingsRow>
                </GlassCardUI>
            </section>

            <section aria-labelledby="agent-permissions" className="space-y-3">
                <SettingsHeading id="agent-permissions">Quem pode pedir o quê</SettingsHeading>
                <GlassCardUI>
                    {form.permissions.length === 0 ? (
                        <SettingsRow>
                            <SettingsDescription>Sem regras: qualquer área pode pedir qualquer tipo de pedido.</SettingsDescription>
                        </SettingsRow>
                    ) : (
                        form.permissions.map((rule, index) => (
                            <SettingsRow key={rule.area} layout="stacked">
                                <div className="flex items-center justify-between gap-2">
                                    <SettingsLabel>{rule.area}</SettingsLabel>
                                    {canManage ? (
                                        <PillButtonUI
                                            tone="white"
                                            size="xs"
                                            aria-label={`Remover a área ${rule.area}`}
                                            onClick={() => set({ permissions: form.permissions.filter((_, i) => i !== index) })}
                                        >
                                            <Trash2 aria-hidden="true" className="h-3 w-3" />
                                        </PillButtonUI>
                                    ) : null}
                                </div>
                                <div role="group" aria-label={`Pedidos de ${rule.area}`} className="flex flex-wrap gap-2">
                                    {view.options.kinds.map((kind) => (
                                        <TabPillButtonUI
                                            key={kind}
                                            active={rule.kinds.includes(kind)}
                                            disabled={!canManage}
                                            onClick={() =>
                                                set({
                                                    permissions: form.permissions.map((p, i) =>
                                                        i === index ? { ...p, kinds: toggle(p.kinds, kind) } : p,
                                                    ),
                                                })
                                            }
                                        >
                                            {KIND_LABEL[kind] ?? kind}
                                        </TabPillButtonUI>
                                    ))}
                                </div>
                            </SettingsRow>
                        ))
                    )}
                    {canManage ? (
                        <SettingsRow>
                            <input
                                className={FIELD}
                                aria-label="Nova área"
                                placeholder="Área (ex.: Comercial)"
                                value={newArea}
                                onChange={(e) => setNewArea(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        addArea();
                                    }
                                }}
                            />
                            <PillButtonUI tone="white" size="sm" onClick={addArea} disabled={!newArea.trim()} className="shrink-0">
                                <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                                Adicionar área
                            </PillButtonUI>
                        </SettingsRow>
                    ) : null}
                </GlassCardUI>
            </section>

            <section aria-labelledby="agent-escalation" className="space-y-3">
                <SettingsHeading id="agent-escalation">Quando passa para uma pessoa</SettingsHeading>
                <GlassCardUI>
                    <SettingsRow layout="stacked">
                        <SettingsLabel>Sempre, em qualquer organização</SettingsLabel>
                        <ul className="space-y-1">
                            {view.options.fixed_escalations.map((rule) => (
                                <li key={rule} className="flex items-center gap-2 text-sm text-gray-600">
                                    <Lock aria-hidden="true" className="h-3 w-3 shrink-0 text-gray-400" />
                                    {rule}
                                </li>
                            ))}
                        </ul>
                    </SettingsRow>
                    <SettingsRow layout="stacked">
                        <SettingsLabel>Também quando o risco é</SettingsLabel>
                        <div role="group" aria-label="Riscos que escalam" className="flex flex-wrap gap-2">
                            {view.options.risk_levels.map((level) => (
                                <TabPillButtonUI
                                    key={level}
                                    active={form.escalation.risk_levels.includes(level)}
                                    disabled={!canManage}
                                    onClick={() =>
                                        set({ escalation: { ...form.escalation, risk_levels: toggle(form.escalation.risk_levels, level) } })
                                    }
                                >
                                    {RISK_LABEL[level] ?? level}
                                </TabPillButtonUI>
                            ))}
                        </div>
                        <SettingsLabel>E nestes tipos de pedido</SettingsLabel>
                        <div role="group" aria-label="Pedidos que escalam" className="flex flex-wrap gap-2">
                            {view.options.kinds.map((kind) => (
                                <TabPillButtonUI
                                    key={kind}
                                    active={form.escalation.kinds.includes(kind)}
                                    disabled={!canManage}
                                    onClick={() => set({ escalation: { ...form.escalation, kinds: toggle(form.escalation.kinds, kind) } })}
                                >
                                    {KIND_LABEL[kind] ?? kind}
                                </TabPillButtonUI>
                            ))}
                        </div>
                        <ToggleSwitchUI
                            checked={form.escalation.low_confidence}
                            disabled={!canManage}
                            onCheckedChange={(low_confidence) => set({ escalation: { ...form.escalation, low_confidence } })}
                        >
                            Quando não tiver certeza da resposta
                        </ToggleSwitchUI>
                        <label className="block space-y-1 text-sm">
                            <SettingsLabel>Avisar quem</SettingsLabel>
                            <input
                                type="email"
                                className={FIELD}
                                placeholder="Vazio: vai para a fila do Legal"
                                value={form.escalation.escalate_to_email}
                                disabled={!canManage}
                                onChange={(e) => set({ escalation: { ...form.escalation, escalate_to_email: e.target.value } })}
                            />
                        </label>
                    </SettingsRow>
                </GlassCardUI>
            </section>

            <section aria-labelledby="agent-proactive" className="space-y-3">
                <SettingsHeading id="agent-proactive">Avisos que ele dá sozinho</SettingsHeading>
                <GlassCardUI>
                    <SettingsRow layout="stacked">
                        <label className="block space-y-1 text-sm">
                            <SettingsLabel>Prazos de aviso, em dias antes</SettingsLabel>
                            <input
                                className={FIELD}
                                value={deadlineText}
                                disabled={!canManage}
                                aria-invalid={!deadlines}
                                onChange={(e) => setDeadlineText(e.target.value)}
                            />
                            <SettingsDescription>
                                {deadlines ? "Ao responsável pelo contrato. Ex.: 30, 15, 7." : "Use números de 1 a 180, separados por vírgula."}
                            </SettingsDescription>
                        </label>
                        <ToggleSwitchUI
                            checked={form.proactive.renewals}
                            disabled={!canManage}
                            onCheckedChange={(renewals) => set({ proactive: { ...form.proactive, renewals } })}
                        >
                            Renovações automáticas
                        </ToggleSwitchUI>
                        <ToggleSwitchUI
                            checked={form.proactive.radar}
                            disabled={!canManage}
                            onCheckedChange={(radar) => set({ proactive: { ...form.proactive, radar } })}
                        >
                            Mudanças do radar regulatório
                        </ToggleSwitchUI>
                        <label className="flex items-center gap-2 text-sm">
                            <span className="text-gray-700">Resumo diário às</span>
                            <input
                                type="time"
                                aria-label="Resumo diário"
                                className={`${FIELD} w-28`}
                                value={form.proactive.digest_time}
                                disabled={!canManage}
                                onChange={(e) => set({ proactive: { ...form.proactive, digest_time: e.target.value } })}
                            />
                        </label>
                        <SettingsDescription>Cobra quem pediu no máximo duas vezes; depois o pedido fica aguardando a pessoa.</SettingsDescription>
                    </SettingsRow>
                </GlassCardUI>
            </section>

            {canManage ? (
                <div className="flex justify-end">
                    <PillButtonUI tone="black" onClick={() => void save()} loading={saving} disabled={!deadlines}>
                        Salvar
                    </PillButtonUI>
                </div>
            ) : null}

            <section aria-labelledby="agent-channels" className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                    <SettingsHeading id="agent-channels">Canais</SettingsHeading>
                    {canManage ? (
                        <PillButtonUI tone="white" size="sm" onClick={() => setWizard({ channel: null, setup: null })}>
                            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                            Conectar canal
                        </PillButtonUI>
                    ) : null}
                </div>
                <GlassCardUI>
                    {view.channels.length === 0 ? (
                        <SettingsRow>
                            <SettingsDescription>
                                Nenhum canal ainda. O assistente de instalação gera o app do Slack, o bot do Telegram ou o webhook
                                do WhatsApp em poucos passos, sem ligar nada até você instalar.
                            </SettingsDescription>
                        </SettingsRow>
                    ) : (
                        view.channels.map((channel) => {
                            const status = CHANNEL_STATUS_LABEL[channel.status];
                            return (
                                <SettingsRow key={channel.id}>
                                    <div className="min-w-0 space-y-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <SettingsLabel>{channel.name}</SettingsLabel>
                                            <StatusChip status={status.status} label={status.label} />
                                        </div>
                                        <SettingsDescription>{CHANNEL_LABEL[channel.kind].label}</SettingsDescription>
                                    </div>
                                    {canManage ? (
                                        <div className="flex flex-wrap gap-2">
                                            <PillButtonUI tone="white" size="xs" onClick={() => void openSetup(channel)}>
                                                Ver instalação
                                            </PillButtonUI>
                                            {channel.status === "configurado" ? (
                                                <PillButtonUI tone="white" size="xs" onClick={() => void changeStatus(channel, "pausado")}>
                                                    Pausar
                                                </PillButtonUI>
                                            ) : (
                                                <PillButtonUI tone="white" size="xs" onClick={() => void changeStatus(channel, "configurado")}>
                                                    Marcar como instalado
                                                </PillButtonUI>
                                            )}
                                            <PillButtonUI
                                                tone="white"
                                                size="xs"
                                                aria-label={`Remover ${channel.name}`}
                                                onClick={() => void remove(channel)}
                                            >
                                                <Trash2 aria-hidden="true" className="h-3 w-3" />
                                            </PillButtonUI>
                                        </div>
                                    ) : null}
                                </SettingsRow>
                            );
                        })
                    )}
                </GlassCardUI>
            </section>

            {wizard ? (
                <LegalAgentChannelWizard
                    orgId={orgId}
                    channel={wizard.channel}
                    initialSetup={wizard.setup}
                    onClose={() => setWizard(null)}
                    onSaved={replaceChannel}
                />
            ) : null}
        </div>
    );
}
