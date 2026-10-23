import type { Obligation } from "@/app/lib/mikeApi";

/** Days until `date` (YYYY-MM-DD) from `today`; negative when overdue. */
export function daysUntil(date: string, today: Date = new Date()): number {
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const due = new Date(`${date}T00:00:00`);
    return Math.round((due.getTime() - start.getTime()) / 86_400_000);
}

/** "vence hoje", "vence em 5 dias", "venceu há 2 dias". */
export function dueLabel(days: number): string {
    if (days === 0) return "vence hoje";
    if (days === 1) return "vence amanhã";
    if (days > 1) return `vence em ${days} dias`;
    if (days === -1) return "venceu ontem";
    return `venceu há ${-days} dias`;
}

/** The warning starts N days before: "avisa 30 dias antes". */
export function alertLabel(days: number): string {
    if (days === 0) return "avisa no dia";
    return days === 1 ? "avisa 1 dia antes" : `avisa ${days} dias antes`;
}

/** Whose deadline it is, for a row: "Você", the person's name, or their e-mail. */
export function ownerLabel(
    item: Pick<Obligation, "owner_email">,
    me?: string | null,
    people: { email: string; name: string }[] = [],
): string {
    if (!item.owner_email) return "Sem responsável";
    if (me && item.owner_email === me.toLowerCase()) return "Você";
    return people.find((p) => p.email === item.owner_email)?.name ?? item.owner_email;
}

/** The lead times offered in the picker; anything else goes through "Outro…". */
export const ALERT_DAY_CHOICES = [0, 7, 15, 30, 60, 90] as const;

export function parseAlertDays(value: string): number | null {
    if (!/^\d{1,3}$/.test(value.trim())) return null;
    const n = Number(value);
    return n >= 0 && n <= 365 ? n : null;
}
