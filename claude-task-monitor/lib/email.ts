/**
 * Email alert service backed by nodemailer.
 * Gated on smtp_host being set in SystemConfig.
 */

import nodemailer from "nodemailer";
import { prisma } from "@/lib/prisma";

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  to: string;
}

export async function getSmtpConfig(): Promise<SmtpConfig | null> {
  const keys = ["smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_from", "alert_email_to"];
  const rows = await prisma.systemConfig.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true },
  });
  const cfg: Record<string, string> = {};
  for (const row of rows) cfg[row.key] = row.value;

  // Gate on smtp_host and alert_email_to being set
  if (!cfg.smtp_host?.trim() || !cfg.alert_email_to?.trim()) return null;

  return {
    host: cfg.smtp_host.trim(),
    port: parseInt(cfg.smtp_port ?? "587", 10) || 587,
    user: cfg.smtp_user?.trim() ?? "",
    pass: cfg.smtp_pass?.trim() ?? "",
    from: cfg.smtp_from?.trim() || cfg.smtp_user?.trim() || "workerai@localhost",
    to: cfg.alert_email_to.trim(),
  };
}

function createTransport(cfg: SmtpConfig) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
}

export async function sendAlertEmail(opts: {
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  const cfg = await getSmtpConfig();
  if (!cfg) return;

  const transport = createTransport(cfg);
  await transport.sendMail({
    from: cfg.from,
    to: cfg.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
  });
}

/** Send a test email to verify SMTP configuration. */
export async function sendTestEmail(): Promise<void> {
  const cfg = await getSmtpConfig();
  if (!cfg) throw new Error("SMTP not configured (smtp_host or alert_email_to missing)");

  const transport = createTransport(cfg);
  await transport.sendMail({
    from: cfg.from,
    to: cfg.to,
    subject: "[WorkerAI] Test email",
    text: "This is a test email from WorkerAI. Your SMTP configuration is working correctly.",
    html: "<p>This is a test email from <strong>WorkerAI</strong>. Your SMTP configuration is working correctly.</p>",
  });
}
