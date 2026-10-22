"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { updateObligation, type Obligation, type ObligationOwner } from "@/app/lib/mikeApi";
import { ALERT_DAY_CHOICES, alertLabel, ownerLabel, parseAlertDays } from "@/app/lib/obligations";
import { notifyError } from "@/app/lib/userFacingError";
import { showToast } from "@/app/components/ui/toast";

const OTHER = "outro";
const FIELD = "rounded border border-gray-200 bg-white px-2 py-1 text-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gray-900";

/** Who looks after a deadline and how early it warns; edits in place. */
export function ObligationOwnerEditor({
    item,
    me,
    people,
    onSaved,
}: {
    item: Obligation;
    me?: string | null;
    people: ObligationOwner[];
    onSaved: (next: Obligation) => void;
}) {
    const [open, setOpen] = useState(false);
    const [owner, setOwner] = useState(item.owner_email ?? "");
    const preset = (ALERT_DAY_CHOICES as readonly number[]).includes(item.alert_days);
    const [choice, setChoice] = useState(preset ? String(item.alert_days) : OTHER);
    const [custom, setCustom] = useState(String(item.alert_days));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // The current owner stays selectable even if they have left the team.
    const options = item.owner_email && !people.some((p) => p.email === item.owner_email)
        ? [...people, { user_id: item.owner_email, email: item.owner_email, name: item.owner_email }]
        : people;

    async function write(patch: { owner_email: string | null; alert_days: number }) {
        const next = await updateObligation(item.id, patch);
        onSaved({ ...item, ...next });
        return next;
    }

    async function save() {
        const alertDays = choice === OTHER ? parseAlertDays(custom) : Number(choice);
        if (alertDays === null) return setError("Use um número de dias entre 0 e 365.");
        const before = { owner_email: item.owner_email, alert_days: item.alert_days };
        setSaving(true);
        setError(null);
        try {
            await write({ owner_email: owner || null, alert_days: alertDays });
            setOpen(false);
            showToast({
                tone: "success",
                message: owner ? "Responsável atualizado." : "Responsável removido.",
                durationMs: 10_000,
                actions: [
                    {
                        label: "Desfazer",
                        onClick: async () => {
                            try {
                                await write(before);
                            } catch (e) {
                                notifyError(e, { lang: "pt", action: "desfazer a mudança" });
                            }
                        },
                    },
                ],
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : "Não foi possível salvar.");
        } finally {
            setSaving(false);
        }
    }

    if (!open) {
        return (
            <button
                onClick={() => setOpen(true)}
                title="Mudar responsável e antecedência"
                className="mt-1 inline-flex items-center gap-1 rounded text-[11px] text-gray-500 underline decoration-dotted underline-offset-2 hover:text-gray-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gray-900"
            >
                <Pencil className="h-3 w-3" aria-hidden />
                {ownerLabel(item, me, people)} · {alertLabel(item.alert_days)}
            </button>
        );
    }

    return (
        <div className="mt-2 flex flex-wrap items-end gap-2 text-xs">
            <label className="flex flex-col gap-0.5 text-gray-500">
                Responsável
                <select value={owner} onChange={(e) => setOwner(e.target.value)} className={`${FIELD} w-56`}>
                    <option value="">Sem responsável</option>
                    {options.map((p) => (
                        <option key={p.email} value={p.email}>
                            {p.name}
                        </option>
                    ))}
                </select>
            </label>
            <label className="flex flex-col gap-0.5 text-gray-500">
                Avisar antes
                <select value={choice} onChange={(e) => setChoice(e.target.value)} className={`${FIELD} w-32`}>
                    {ALERT_DAY_CHOICES.map((d) => (
                        <option key={d} value={d}>
                            {d === 0 ? "No dia" : `${d} dias`}
                        </option>
                    ))}
                    <option value={OTHER}>Outro…</option>
                </select>
            </label>
            {choice === OTHER && (
                <label className="flex flex-col gap-0.5 text-gray-500">
                    Dias
                    <input
                        value={custom}
                        onChange={(e) => setCustom(e.target.value)}
                        inputMode="numeric"
                        className={`${FIELD} w-20`}
                    />
                </label>
            )}
            <button
                onClick={() => void save()}
                disabled={saving}
                className="rounded bg-gray-900 px-2.5 py-1 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 disabled:opacity-50"
            >
                Salvar
            </button>
            <button
                onClick={() => setOpen(false)}
                className="rounded px-1 py-1 text-gray-500 hover:text-gray-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gray-900"
            >
                Cancelar
            </button>
            {error && <span className="basis-full text-red-600">{error}</span>}
        </div>
    );
}
