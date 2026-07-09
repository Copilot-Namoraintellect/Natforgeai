import nodemailer from "nodemailer";
import type { SentMessageInfo } from "nodemailer";
import { env } from "./env";

const transporter = nodemailer.createTransport({
  host: env.smtpHost,
  port: env.smtpPort,
  secure: env.smtpPort === 465,
  auth: {
    user: env.smtpUser,
    pass: env.smtpPass,
  },
});

export async function sendEmail({
  to,
  subject,
  html,
  text,
}: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<SentMessageInfo> {
  if (!env.smtpHost || !env.smtpUser || !env.smtpPass) {
    throw new Error("SMTP is not configured");
  }

  return transporter.sendMail({
    from: `"${env.smtpFromName || "NatForgeAI"}" <${env.smtpFromEmail || env.smtpUser}>`,
    to,
    subject,
    html,
    text,
  });
}

export function sendTwoFactorCodeEmail({
  to,
  code,
}: {
  to: string;
  code: string;
}): Promise<SentMessageInfo> {
  return sendEmail({
    to,
    subject: "Your NatForgeAI verification code",
    html: `<p>Your verification code is:</p><h1 style="font-size:2rem;letter-spacing:0.2em">${code}</h1><p>This code expires in 10 minutes.</p>`,
    text: `Your verification code is: ${code}. This code expires in 10 minutes.`,
  });
}
