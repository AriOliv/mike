// What the home screen ("Início") says, kept out of the components so every
// sentence and filter is tested: the greeting, the agent's step, the queue's
// tabs and counter filters, and the notice-deadline badge.

import type { ChipStatus } from "@/app/components/ui/status-chip";
import type { HomeReview, HomeSummary } from "./mikeApi";

/** "1 contrato" / "3 contratos". */
export function contracts(n: number): string {
    return `${n} ${n === 1 ? "contrato" : "contratos"}`;
}

/**
 * The first line of the home screen: what the agents did since the last
 * visit, in the first person and with the next step.
 */
export function greeting(home: Pick<HomeSummary, "since" | "greeting" | "reviews">): {
    lead: string;
    detail: string | null;
} {
    const { reviewed, failed, notices_closing, ready } = home.greeting;
    if (home.reviews.length === 0)
        return {
            lead: "Ainda não revisei nenhum contrato.",
            detail: "Envie contratos ou monitore uma pasta e eu reviso cada um assim que chegar.",
        };
    const parts: string[] = [];
    if (notices_closing > 0)
        parts.push(
            `${notices_closing} ${notices_closing === 1 ? "aviso prévio fecha" : "avisos prévios fecham"} em até 30 dias`,
        );
    if (ready > 0) parts.push(`${contracts(ready)} ${ready === 1 ? "espera" : "esperam"} sua revisão`);
    if (failed > 0) parts.push(`${failed === 1 ? "1 falhou" : `${failed} falharam`} e ${failed === 1 ? "precisa" : "precisam"} de outra tentativa`);
    const detail = parts.length ? `${capitalize(parts.join(", "))}.` : null;
    if (reviewed > 0)
        return {
            lead: `Revisei ${contracts(reviewed)} para você ${home.since ? "desde sua última visita" : "até agora"}.`,
            detail,
        };
    return { lead: "Nada novo desde sua última visita.", detail };
}

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

const STEP_LABEL = {
    lendo: "Lendo o contrato…",
    ficha: "Preenchendo a Ficha…",
    playbook: "Comparando com o playbook…",
} as const;

/** The status chip of a review row: the agent's step while it runs. */
export function reviewChip(review: Pick<HomeReview, "status" | "step">): { status: ChipStatus; label?: string } {
    switch (review.status) {
        case "queued":
            return { status: "a_fazer", label: "Na fila" };
        case "running":
            return { status: "rodando", label: review.step ? STEP_LABEL[review.step] : "Lendo o contrato…" };
        case "ready":
            return { status: "pronto" };
        case "done":
            return { status: "concluido", label: "Revisado" };
        default:
            return { status: "erro" };
    }
}

export type HomeTab = "minhas" | "todas";
export type HomeFilter = "prontos" | "meus" | "avisos" | "pastas" | null;

/** The rows a tab and a counter filter leave, ready first, then newest. */
export function filterReviews(
    reviews: HomeReview[],
    opts: { tab: HomeTab; filter: HomeFilter; me: string | null; query?: string },
    today: string = new Date().toISOString().slice(0, 10),
): HomeReview[] {
    const me = opts.me?.toLowerCase() ?? null;
    const query = opts.query?.trim().toLowerCase() ?? "";
    const rank: Record<HomeReview["status"], number> = { ready: 0, running: 1, queued: 2, failed: 3, done: 4 };
    return reviews
        .filter((r) => (opts.tab === "minhas" ? !!me && r.assignee_email === me : true))
        .filter((r) => {
            switch (opts.filter) {
                case "prontos":
                    return r.status === "ready";
                case "meus":
                    return !!me && r.assignee_email === me && r.status !== "done";
                case "avisos": {
                    const days = r.notice_deadline ? daysUntil(r.notice_deadline, today) : null;
                    return days !== null && days >= 0 && days <= 30;
                }
                case "pastas":
                    return !!r.watched_folder_id;
                default:
                    return true;
            }
        })
        .filter((r) =>
            query
                ? [r.filename, r.project_name, r.counterparty, r.assignee_email]
                      .filter(Boolean)
                      .some((v) => v!.toLowerCase().includes(query))
                : true,
        )
        .sort((a, b) => rank[a.status] - rank[b.status] || b.updated_at.localeCompare(a.updated_at));
}

/** Whole days from `today` to a YYYY-MM-DD date; negative once past. */
export function daysUntil(date: string, today: string = new Date().toISOString().slice(0, 10)): number {
    return Math.round(
        (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
    );
}

/** The D-xx badge: text, tone, and the sentence its tooltip explains it with. */
export function deadlineBadge(
    noticeDeadline: string,
    today: string = new Date().toISOString().slice(0, 10),
): { text: string; tone: "neutro" | "atencao" | "critico"; title: string } {
    const days = daysUntil(noticeDeadline, today);
    const title = `Aviso de não renovação até ${brDate(noticeDeadline)}`;
    if (days < 0) return { text: "vencido", tone: "critico", title };
    return { text: `D-${days}`, tone: days <= 7 ? "critico" : days <= 60 ? "atencao" : "neutro", title };
}

/** "2026-10-20" → "20/10/2026". */
export function brDate(iso: string): string {
    const [y, m, d] = iso.slice(0, 10).split("-");
    return `${d}/${m}/${y}`;
}

/** The part of an e-mail a table can show, "duda@avenia.io" → "duda". */
export function personName(email: string | null): string | null {
    return email ? email.split("@")[0] : null;
}
