import { afterEach, describe, expect, it, vi } from "vitest";

const nodemailer = vi.hoisted(() => {
    const sendMail = vi.fn(async () => ({}));
    return { sendMail, createTransport: vi.fn(() => ({ sendMail })) };
});
vi.mock("nodemailer", () => ({ default: nodemailer }));

import { mailerEnabled, sendMail, setMailTransport } from "../mailer";

afterEach(() => {
    delete process.env.SMTP_URL;
    delete process.env.MAIL_FROM;
    setMailTransport(null);
});

describe("mailer", () => {
    it("is off without SMTP_URL and refuses to send", async () => {
        expect(mailerEnabled()).toBe(false);
        await expect(sendMail({ to: "a@b.c", subject: "s", text: "t" })).rejects.toThrow("smtp_not_configured");
    });

    it("sends through one SMTP URL, from MAIL_FROM", async () => {
        process.env.SMTP_URL = "smtp://mailpit:1025";
        process.env.MAIL_FROM = "Mike Legal <legal@avenia.io>";
        expect(mailerEnabled()).toBe(true);
        await sendMail({ to: "a@b.c", subject: "s", text: "t", html: "<p>t</p>" });
        await sendMail({ to: "d@e.f", subject: "s2", text: "t2" });
        expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
        expect(nodemailer.createTransport).toHaveBeenCalledWith("smtp://mailpit:1025");
        expect(nodemailer.sendMail).toHaveBeenNthCalledWith(1, {
            from: "Mike Legal <legal@avenia.io>",
            to: "a@b.c",
            subject: "s",
            text: "t",
            html: "<p>t</p>",
        });
        delete process.env.MAIL_FROM;
        await sendMail({ to: "g@h.i", subject: "s3", text: "t3" });
        expect(nodemailer.sendMail).toHaveBeenLastCalledWith(
            expect.objectContaining({ from: "Mike <no-reply@mike.local>" }),
        );
    });

    it("lets tests replace the transport", async () => {
        const sent: unknown[] = [];
        setMailTransport(async (mail) => void sent.push(mail));
        expect(mailerEnabled()).toBe(true);
        await sendMail({ to: "a@b.c", subject: "s", text: "t" });
        expect(sent).toEqual([{ to: "a@b.c", subject: "s", text: "t" }]);
    });
});
