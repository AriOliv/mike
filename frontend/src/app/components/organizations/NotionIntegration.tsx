"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Unplug } from "lucide-react";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { SettingsDescription, SettingsLabel } from "@/app/components/settings/SettingsText";
import { EmptyState } from "@/app/components/ui/empty-state";
import { showToast } from "@/app/components/ui/toast";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import {
    connectNotion,
    describeNotionBoard,
    disconnectNotion,
    getNotionConnection,
    listNotionDatabases,
    saveNotionMapping,
    previewNotionImport,
    applyNotionImport,
    type NotionImportPlan,
    type NotionBoardSchema,
    type NotionConnection,
    type NotionLane,
    type NotionStageTarget,
} from "@/app/lib/mikeApi";
import { assign, LANE_LABEL, looksLikeToken, mappingProblems, MATCH_LABEL, OWNER_LABEL, propertiesFor, propertyOf } from "@/app/lib/notionIntegration";
import { describeError, notifyError } from "@/app/lib/userFacingError";
import { useOrganizationSettings } from "./OrganizationSettingsShell";

const FIELD =
    "w-full rounded-lg border border-gray-200 bg-app-surface px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-60";

// The organization's own Notion board, in three steps: connect with the
// integration's token (kept encrypted, never shown again), pick the board the
// legal team already uses, and map its properties and stages onto Mike's
// cards. Import and the two-way sync come after the mapping.

export function NotionIntegration() {
    const { orgId } = useOrganizationSettings();
    const [conn, setConn] = useState<NotionConnection | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [token, setToken] = useState("");
    const [busy, setBusy] = useState(false);
    const [bases, setBases] = useState<{ id: string; title: string }[] | null>(null);
    const [board, setBoard] = useState<NotionBoardSchema | null>(null);
    const [fieldMap, setFieldMap] = useState<Record<string, string>>({});
    const [stageMap, setStageMap] = useState<Record<string, NotionStageTarget>>({});
    const [poll, setPoll] = useState(10);
    const [plan, setPlan] = useState<NotionImportPlan | null>(null);

    const load = useCallback(async () => {
        try {
            setConn(await getNotionConnection(orgId));
            setError(null);
        } catch (e) {
            setError(describeError(e, { lang: "pt", action: "carregar a integração com o Notion" }).message);
        }
    }, [orgId]);

    useEffect(() => {
        void load();
    }, [load]);

    if (error && !conn)
        return (
            <EmptyState
                tone="error"
                title="Não consegui carregar a integração"
                description={error}
                action={
                    <PillButtonUI tone="white" onClick={() => void load()}>
                        Tentar de novo
                    </PillButtonUI>
                }
            />
        );
    if (!conn) return <div className="h-40 animate-pulse rounded-xl bg-gray-100" aria-label="Carregando" />;

    const run = async <T,>(action: string, fn: () => Promise<T>): Promise<T | null> => {
        setBusy(true);
        try {
            return await fn();
        } catch (e) {
            notifyError(e, { lang: "pt", action });
            return null;
        } finally {
            setBusy(false);
        }
    };

    const connect = async () => {
        const next = await run("conectar o Notion", () => connectNotion(orgId, token.trim()));
        if (next) {
            setConn(next);
            setToken("");
            showToast({ tone: "success", message: "Notion conectado." });
        }
    };

    const disconnect = async () => {
        const next = await run("desconectar o Notion", () => disconnectNotion(orgId));
        if (next) {
            setConn(next);
            setBases(null);
            setBoard(null);
        }
    };

    const loadBases = async () => {
        const list = await run("listar as bases do Notion", () => listNotionDatabases(orgId));
        if (list) setBases(list);
    };

    const pickBase = async (databaseId: string) => {
        const schema = await run("ler a base do Notion", () => describeNotionBoard(orgId, databaseId));
        if (!schema) return;
        setBoard(schema);
        const sameBase = conn.database_id === databaseId;
        setFieldMap(sameBase && Object.keys(conn.field_map).length ? conn.field_map : schema.suggested_field_map);
        setStageMap(sameBase && Object.keys(conn.stage_map).length ? conn.stage_map : schema.suggested_stage_map);
        setPoll(conn.poll_minutes);
    };

    // The options of whichever property the person picked for the stage.
    const stageProperty = propertyOf(fieldMap).lane;
    const stageOptions = board?.properties.find((p) => p.name === stageProperty)?.options ?? [];
    const problems = board ? mappingProblems(fieldMap, stageOptions, stageMap) : [];

    const save = async () => {
        if (!board) return;
        const next = await run("salvar o mapeamento", () =>
            saveNotionMapping(orgId, { database_id: board.database_id, field_map: fieldMap, stage_map: stageMap, poll_minutes: poll }),
        );
        if (next) {
            setConn(next);
            showToast({ tone: "success", message: "Mapeamento salvo. O próximo passo é a importação." });
        }
    };

    const preview = async () => {
        const next = await run("simular a importação", () => previewNotionImport(orgId));
        if (next) setPlan(next);
    };

    const importNow = async () => {
        const done = await run("importar do Notion", () => applyNotionImport(orgId));
        if (!done) return;
        showToast({
            tone: done.failed ? "error" : "success",
            message:
                `Importação feita: ${done.created} novos, ${done.linked} ligados a cards existentes` +
                (done.failed ? `, ${done.failed} com erro (tente de novo; os já importados não se repetem).` : "."),
        });
        setPlan(await previewNotionImport(orgId).catch(() => null));
    };

    const canManage = conn.can_manage;
    const ready = !!conn.database_id && Object.values(conn.field_map).includes("lane");
    const byField = propertyOf(fieldMap);

    return (
        <div className="space-y-8">
            <section aria-labelledby="notion-connect" className="space-y-3">
                <SettingsHeading id="notion-connect">Notion</SettingsHeading>
                <p className="text-sm text-gray-500">
                    Use a base do Notion que o Legal já usa. O Mike lê os cards, mantém os dois lados iguais e registra cada mudança
                    na Atividade.
                    {!canManage ? " Só quem administra a organização pode mudar a integração." : ""}
                </p>
                <GlassCardUI>
                    {conn.connected ? (
                        <SettingsRow>
                            <div className="space-y-1">
                                <SettingsLabel>Conectado</SettingsLabel>
                                <SettingsDescription>
                                    Token da integração terminado em {conn.token_last4}. Ele fica criptografado e não é mostrado de novo.
                                </SettingsDescription>
                            </div>
                            {canManage ? (
                                <PillButtonUI tone="white" size="sm" onClick={() => void disconnect()} disabled={busy}>
                                    <Unplug aria-hidden="true" className="h-3.5 w-3.5" />
                                    Desconectar
                                </PillButtonUI>
                            ) : null}
                        </SettingsRow>
                    ) : canManage ? (
                        <SettingsRow layout="stacked">
                            <label className="block space-y-1 text-sm">
                                <SettingsLabel>Token da integração interna</SettingsLabel>
                                <input
                                    type="password"
                                    autoComplete="off"
                                    className={FIELD}
                                    value={token}
                                    onChange={(e) => setToken(e.target.value)}
                                    placeholder="ntn_…"
                                />
                                <SettingsDescription>
                                    No Notion: Configurações → Conexões → Desenvolver integrações → Nova integração interna. Depois abra a
                                    base do Legal e conecte a integração em ••• → Conexões.
                                </SettingsDescription>
                            </label>
                            <PillButtonUI tone="black" size="sm" onClick={() => void connect()} loading={busy} disabled={!looksLikeToken(token)}>
                                Conectar
                            </PillButtonUI>
                        </SettingsRow>
                    ) : (
                        <SettingsRow>
                            <SettingsDescription>O Notion ainda não está conectado nesta organização.</SettingsDescription>
                        </SettingsRow>
                    )}
                </GlassCardUI>
            </section>

            {conn.connected && canManage ? (
                <section aria-labelledby="notion-base" className="space-y-3">
                    <SettingsHeading id="notion-base">Base</SettingsHeading>
                    <GlassCardUI>
                        <SettingsRow>
                            <div className="space-y-1">
                                <SettingsLabel>{conn.database_title ?? "Nenhuma base escolhida"}</SettingsLabel>
                                <SettingsDescription>A base que o Legal usa hoje. O Mike não cria outra.</SettingsDescription>
                            </div>
                            <PillButtonUI tone="white" size="sm" onClick={() => void loadBases()} disabled={busy}>
                                {conn.database_title ? "Trocar base" : "Escolher base"}
                            </PillButtonUI>
                        </SettingsRow>
                        {bases ? (
                            bases.length === 0 ? (
                                <SettingsRow>
                                    <SettingsDescription>
                                        A integração ainda não vê nenhuma base. No Notion, abra a base e conecte a integração em ••• → Conexões.
                                    </SettingsDescription>
                                </SettingsRow>
                            ) : (
                                <SettingsRow layout="stacked">
                                    <ul className="space-y-1" aria-label="Bases do Notion">
                                        {bases.map((b) => (
                                            <li key={b.id}>
                                                <button
                                                    type="button"
                                                    onClick={() => void pickBase(b.id)}
                                                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-app-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                                >
                                                    {board?.database_id === b.id ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : null}
                                                    {b.title}
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                </SettingsRow>
                            )
                        ) : null}
                    </GlassCardUI>
                </section>
            ) : null}

            {board && canManage ? (
                <section aria-labelledby="notion-map" className="space-y-3">
                    <SettingsHeading id="notion-map">Mapeamento: {board.title}</SettingsHeading>
                    <p className="text-sm text-gray-500">Sugeri pelos nomes das propriedades. Confira e ajuste.</p>
                    <GlassCardUI>
                        {conn.fields.map((field) => (
                            <SettingsRow key={field.field}>
                                <div className="min-w-0 space-y-1">
                                    <SettingsLabel>{field.label}</SettingsLabel>
                                    <SettingsDescription>{OWNER_LABEL[field.owner]}</SettingsDescription>
                                </div>
                                <select
                                    aria-label={`Propriedade para ${field.label}`}
                                    className={`${FIELD} sm:w-60`}
                                    value={byField[field.field] ?? ""}
                                    onChange={(e) => setFieldMap(assign(fieldMap, field.field, e.target.value || null))}
                                >
                                    <option value="">Não usar</option>
                                    {propertiesFor(board.properties, field.types).map((name) => (
                                        <option key={name} value={name}>
                                            {name}
                                        </option>
                                    ))}
                                </select>
                            </SettingsRow>
                        ))}
                    </GlassCardUI>

                    {stageOptions.length > 0 ? (
                        <>
                            <SettingsLabel>Etapas</SettingsLabel>
                            <p className="text-sm text-gray-500">
                                Uma etapa que o Mike não tem fica na etapa escolhida com o nome dela como etiqueta, e volta ao Notion com o
                                mesmo nome.
                            </p>
                            <GlassCardUI>
                                {stageOptions.map((option) => (
                                    <SettingsRow key={option}>
                                        <div className="min-w-0 space-y-1">
                                            <SettingsLabel>{option}</SettingsLabel>
                                            {stageMap[option]?.tag ? <SettingsDescription>Etiqueta: {stageMap[option].tag}</SettingsDescription> : null}
                                        </div>
                                        <select
                                            aria-label={`Etapa do Mike para ${option}`}
                                            className={`${FIELD} sm:w-60`}
                                            value={stageMap[option]?.lane ?? ""}
                                            onChange={(e) =>
                                                setStageMap({
                                                    ...stageMap,
                                                    // A stage with no lane of its own keeps its name as the tag.
                                                    [option]: { lane: e.target.value as NotionLane, tag: stageMap[option]?.tag ?? null },
                                                })
                                            }
                                        >
                                            <option value="" disabled>
                                                Escolha
                                            </option>
                                            {(Object.keys(LANE_LABEL) as NotionLane[]).map((lane) => (
                                                <option key={lane} value={lane}>
                                                    {LANE_LABEL[lane]}
                                                </option>
                                            ))}
                                        </select>
                                    </SettingsRow>
                                ))}
                            </GlassCardUI>
                        </>
                    ) : null}

                    <label className="flex items-center gap-2 text-sm">
                        <span className="text-gray-700">Buscar mudanças do Notion a cada</span>
                        <input
                            type="number"
                            min={5}
                            max={1440}
                            aria-label="Minutos entre sincronias"
                            className={`${FIELD} w-24`}
                            value={poll}
                            onChange={(e) => setPoll(Number(e.target.value))}
                        />
                        <span className="text-gray-700">minutos</span>
                    </label>

                    {problems.length ? (
                        <ul className="space-y-1 text-xs text-amber-700" aria-label="O que falta">
                            {problems.map((p) => (
                                <li key={p}>{p}</li>
                            ))}
                        </ul>
                    ) : null}
                    <div className="flex justify-end">
                        <PillButtonUI tone="black" onClick={() => void save()} loading={busy} disabled={problems.length > 0}>
                            Salvar mapeamento
                        </PillButtonUI>
                    </div>
                </section>
            ) : null}

            {ready && canManage ? (
                <section aria-labelledby="notion-import" className="space-y-3">
                    <SettingsHeading id="notion-import">Importar</SettingsHeading>
                    <p className="text-sm text-gray-500">
                        Primeiro uma simulação: nada muda no Mike nem no Notion. Confira os números e só então importe. Importar de
                        novo não duplica nada.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <PillButtonUI tone="white" size="sm" onClick={() => void preview()} loading={busy && !plan}>
                            Simular importação
                        </PillButtonUI>
                        {plan ? (
                            <PillButtonUI tone="black" size="sm" onClick={() => void importNow()} disabled={busy || plan.counts.new + plan.counts.project + plan.counts.duplicate === 0}>
                                Importar agora
                            </PillButtonUI>
                        ) : null}
                    </div>
                    {plan ? (
                        <GlassCardUI>
                            <SettingsRow layout="stacked">
                                <SettingsLabel>{plan.total} páginas na base</SettingsLabel>
                                <ul className="grid gap-2 sm:grid-cols-2" aria-label="Resumo da simulação">
                                    {(Object.keys(MATCH_LABEL) as (keyof typeof MATCH_LABEL)[]).map((m) => (
                                        <li key={m} className="text-sm">
                                            <span className="font-medium text-gray-900">
                                                {plan.counts[m]} {MATCH_LABEL[m].label.toLowerCase()}
                                            </span>
                                            <span className="block text-xs text-gray-500">{MATCH_LABEL[m].hint}</span>
                                        </li>
                                    ))}
                                    {plan.counts.skipped ? (
                                        <li className="text-sm">
                                            <span className="font-medium text-amber-700">{plan.counts.skipped} ficam de fora</span>
                                            <span className="block text-xs text-gray-500">sem nome de contrato</span>
                                        </li>
                                    ) : null}
                                </ul>
                            </SettingsRow>
                            {plan.items.some((i) => i.warnings.length) ? (
                                <SettingsRow layout="stacked">
                                    <SettingsLabel>Para conferir</SettingsLabel>
                                    <ul className="max-h-64 space-y-2 overflow-y-auto text-xs" aria-label="Avisos da importação">
                                        {plan.items
                                            .filter((i) => i.warnings.length)
                                            .map((i) => (
                                                <li key={i.page_id}>
                                                    <span className="font-medium text-gray-900">{i.name}</span>
                                                    {i.warnings.map((w) => (
                                                        <span key={w} className="block text-gray-600">
                                                            {w}
                                                        </span>
                                                    ))}
                                                </li>
                                            ))}
                                    </ul>
                                </SettingsRow>
                            ) : null}
                        </GlassCardUI>
                    ) : null}
                </section>
            ) : null}
        </div>
    );
}
