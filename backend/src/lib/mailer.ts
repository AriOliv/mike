// Outgoing e-mail over SMTP. Configured by one URL so every environment
// differs only in a secret: SMTP_URL=smtp://user:pass@host:587 (or smtps://
// for implicit TLS); locally Compose's Mailpit catches everything at
// smtp://mailpit:1025. MAIL_FROM is the sender ("Mike Legal <legal@...>").
//
// Unconfigured is a normal state, not an error: callers check
// mailerEnabled() and record the notification as skipped.

import nodemailer, { type Transporter } from "nodemailer";

export type OutgoingMail = {
    to: string;
    subject: string;
    text: string;
    html?: string;
};

let transporter: Transporter | null = null;
let override: ((mail: OutgoingMail) => Promise<void>) | null = null;

export function mailerEnabled(): boolean {
    return !!override || !!process.env.SMTP_URL?.trim();
}

/** Tests replace the transport; pass null to restore. */
export function setMailTransport(send: ((mail: OutgoingMail) => Promise<void>) | null): void {
    override = send;
}

export async function sendMail(mail: OutgoingMail): Promise<void> {
    if (override) return override(mail);
    const url = process.env.SMTP_URL?.trim();
    if (!url) throw new Error("smtp_not_configured");
    transporter ??= nodemailer.createTransport(url);
    await transporter.sendMail({
        from: process.env.MAIL_FROM?.trim() || "Mike <no-reply@mike.local>",
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        ...(mail.html ? { html: mail.html } : {}),
    });
}
