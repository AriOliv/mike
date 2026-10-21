// E-mail on the four moments a person outside the team cares about: the
// request was received, someone took it, the team has a question, the work
// is delivered (plus the invitation of an outside participant).
//
// Writing goes to an outbox (legal_request_notifications) inside the same
// request that changed the state; a job sends it. The outbox's dedupe key
// keeps a retried event from mailing twice, and a failed send never fails
// the change that caused it.

import type { Db } from "../../lib/supabase";
import { mailerEnabled, sendMail } from "../../lib/mailer";
import { enqueueDbJob } from "../../lib/dbq/enqueue";
import { safeError } from "../../lib/safeError";
import { requestCode } from "./requests.shared";

export type NotificationTemplate =
    | "request.created"
    | "request.assigned"
    | "request.question"
    | "request.delivered"
    | "request.invited";

export type NotificationInput = {
    requestId: string;
    number: number;
    title: string;
    template: NotificationTemplate;
    recipient: string;
    /** Unique per event: the same key never mails twice. */
    dedupeKey: string;
    payload?: Record<string, string | null | undefined>;
};

export const SEND_JOB_KIND = "request.notify";

function appUrl(path: string): string {
    const base = (process.env.APP_BASE_URL?.trim() || process.env.FRONTEND_URL?.trim() || "http://localhost:3000").replace(
        /\/$/,
        "",
    );
    return `${base}${path}`;
}

/** Subject and body of each e-mail, in Portuguese, always with the link. */
export function renderNotification(
    template: NotificationTemplate,
    number: number,
    title: string,
    requestId: string,
    payload: Record<string, unknown> = {},
): { subject: string; text: string } {
    const code = requestCode(number);
    const link = appUrl(`/pedidos/${requestId}`);
    const str = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string) : "");
    switch (template) {
        case "request.created":
            return {
                subject: `${code} recebido: ${title}`,
                text:
                    `Recebemos seu pedido ${code} ("${title}").\n` +
                    `Prazo previsto: ${str("due")}.\n\n` +
                    `Acompanhe por aqui: ${link}\n`,
            };
        case "request.assigned":
            return {
                subject: `${code}: ${str("assignee")} está cuidando do seu pedido`,
                text: `${str("assignee")} vai cuidar do pedido ${code} ("${title}").\n\nAcompanhe: ${link}\n`,
            };
        case "request.question":
            return {
                subject: `${code}: o Legal tem uma pergunta`,
                text:
                    `${str("author")} perguntou sobre o pedido ${code} ("${title}"):\n\n` +
                    `${str("question")}\n\n` +
                    `Responda por aqui (o prazo fica pausado até você responder): ${link}\n`,
            };
        case "request.delivered":
            return {
                subject: `${code} entregue: ${title}`,
                text:
                    `O Legal concluiu o pedido ${code} ("${title}").\n\n` +
                    (str("message") ? `${str("message")}\n\n` : "") +
                    `Veja a entrega: ${link}\n`,
            };
        case "request.invited":
            return {
                subject: `Convite para acompanhar ${code}: ${title}`,
                text:
                    `${str("inviter")} convidou você para acompanhar o pedido ${code} ("${title}") ` +
                    `até ${str("expires")}.\n\nEntre com este e-mail para ver: ${link}\n`,
            };
    }
}

/**
 * Put e-mails on the outbox and wake the sender. Never throws: the request
 * already changed; a notification that cannot be queued is logged.
 */
export async function queueNotifications(db: Db, items: NotificationInput[]): Promise<void> {
    const rows = items
        .filter((i) => i.recipient)
        .map((i) => ({
            request_id: i.requestId,
            template: i.template,
            recipient: i.recipient.toLowerCase(),
            payload: { ...(i.payload ?? {}), number: i.number, title: i.title },
            dedupe_key: i.dedupeKey,
        }));
    if (rows.length === 0) return;
    try {
        const { error } = await db
            .from("legal_request_notifications")
            .upsert(rows, { onConflict: "dedupe_key", ignoreDuplicates: true });
        if (error) throw error;
        await enqueueDbJob(db, { kind: SEND_JOB_KIND, payload: {}, dedupeKey: SEND_JOB_KIND });
    } catch (err) {
        console.error("[requests] notification queue failed", { error: safeError(err) });
    }
}

type OutboxRow = {
    id: string;
    request_id: string;
    template: NotificationTemplate;
    recipient: string;
    payload: Record<string, unknown>;
    attempts: number;
};

const MAX_ATTEMPTS = 5;

/**
 * Job handler (kind "request.notify"): send what is pending. Without SMTP
 * the rows are marked skipped so the outbox does not grow forever and the
 * card can say "e-mail desligado".
 */
export async function handleRequestNotify(db: Db): Promise<Record<string, unknown>> {
    const { data, error } = await db
        .from("legal_request_notifications")
        .select("id, request_id, template, recipient, payload, attempts")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(50);
    if (error) throw error;
    const rows = (data ?? []) as OutboxRow[];
    let sent = 0;
    let failed = 0;
    for (const row of rows) {
        if (!mailerEnabled()) {
            await db
                .from("legal_request_notifications")
                .update({ status: "skipped", last_error: "smtp_not_configured" })
                .eq("id", row.id);
            continue;
        }
        const number = Number(row.payload.number ?? 0);
        const title = String(row.payload.title ?? "");
        const mail = renderNotification(row.template, number, title, row.request_id, row.payload);
        try {
            await sendMail({ to: row.recipient, ...mail });
            await db
                .from("legal_request_notifications")
                .update({ status: "sent", sent_at: new Date().toISOString(), attempts: row.attempts + 1 })
                .eq("id", row.id);
            sent += 1;
        } catch (err) {
            failed += 1;
            const attempts = row.attempts + 1;
            await db
                .from("legal_request_notifications")
                .update({
                    status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
                    attempts,
                    last_error: String((err as Error)?.message ?? "send_failed").slice(0, 200),
                })
                .eq("id", row.id);
        }
    }
    return { sent, failed, pending: rows.length - sent - failed };
}
