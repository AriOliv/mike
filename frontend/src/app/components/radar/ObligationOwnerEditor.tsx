"use client";

import { useState } from "react";
import { updateObligation, type Obligation } from "@/app/lib/mikeApi";
import { alertLabel, ownerLabel, parseAlertDays } from "@/app/lib/obligations";

/** Who looks after a deadline and how early it warns; edits in place. */
export function ObligationOwnerEditor({
    item,
    me,
    onSaved,
}: {
    item: Obligation;
    me?: string | null;
    onSaved: (next: Obligation) => void;
}) {
    const [open, setOpen] = useState(false);
    const [owner, setOwner] = useState(item.owner_email ?? "");
    const [days, setDays] = useState(String(item.alert_days));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function save() {
        const alertDays = parseAlertDays(days);
        if (alertDays === null) return setError("Use um número de dias entre 0 e 365.");
        setSaving(true);
        setError(null);
        try {
            const next = await updateObligation(item.id, {
                owner_email: owner.trim() || null,
                alert_days: alertDays,
            });
            onSaved({ ...item, ...next });
            setOpen(false);
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
                className="mt-1 text-[11px] text-gray-500 hover:text-gray-700 hover:underline"
            >
                {ownerLabel(item, me)} · {alertLabel(item.alert_days)}
            </button>
        );
    }

    return (
        <div className="mt-2 flex flex-wrap items-end gap-2 text-xs">
            <label className="flex flex-col gap-0.5 text-gray-500">
                Responsável (e-mail)
                <input
                    value={owner}
                    onChange={(e) => setOwner(e.target.value)}
                    placeholder="nome@empresa.com"
                    className="w-56 rounded border border-gray-200 px-2 py-1 text-gray-800"
                />
            </label>
            <label className="flex flex-col gap-0.5 text-gray-500">
                Avisar antes (dias)
                <input
                    value={days}
                    onChange={(e) => setDays(e.target.value)}
                    inputMode="numeric"
                    className="w-20 rounded border border-gray-200 px-2 py-1 text-gray-800"
                />
            </label>
            <button
                onClick={() => void save()}
                disabled={saving}
                className="rounded bg-gray-900 px-2.5 py-1 text-white disabled:opacity-50"
            >
                Salvar
            </button>
            <button onClick={() => setOpen(false)} className="px-1 py-1 text-gray-500 hover:text-gray-700">
                Cancelar
            </button>
            {error && <span className="basis-full text-red-600">{error}</span>}
        </div>
    );
}
