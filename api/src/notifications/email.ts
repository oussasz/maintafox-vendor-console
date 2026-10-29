/**
 * Email delivery for desktop notifications (deploy/NOTIFICATION_EMAIL.md). The provider is plain
 * SMTP configured from the environment; nothing about a provider is hard-coded.
 *
 *   EMAIL_DELIVERY_MODE = disabled | smtp            (required)
 *   SMTP_HOST, SMTP_PORT, SMTP_SECURE (true|false), EMAIL_FROM     (required with smtp)
 *   SMTP_USER + SMTP_PASSWORD                        (optional, both or neither)
 */
import nodemailer from "nodemailer";

export type EmailConfig =
  | { mode: "disabled" }
  | {
      mode: "smtp";
      host: string;
      port: number;
      secure: boolean;
      from: string;
      auth: { user: string; pass: string } | null;
    };

/** SMTP connection, greeting and socket timeout: a stuck server cannot hold a request open. */
export const SMTP_TIMEOUT_MS = 20_000;

export function loadEmailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  const mode = env["EMAIL_DELIVERY_MODE"]?.trim();
  if (mode === "disabled") return { mode };
  if (mode !== "smtp") {
    throw new Error("EMAIL_DELIVERY_MODE is required: 'disabled' or 'smtp' (see .env.example).");
  }
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`${name} is required when EMAIL_DELIVERY_MODE=smtp.`);
    return v;
  };
  const port = Number(need("SMTP_PORT"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SMTP_PORT must be a port number.");
  const secure = need("SMTP_SECURE");
  if (secure !== "true" && secure !== "false") throw new Error("SMTP_SECURE must be 'true' or 'false'.");
  const from = need("EMAIL_FROM");
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(from) && !/^[^<>]*<[^\s@<>]+@[^\s@<>]+>$/.test(from)) {
    throw new Error("EMAIL_FROM must be an address (name@domain or Name <name@domain>).");
  }
  const user = env["SMTP_USER"]?.trim();
  const pass = env["SMTP_PASSWORD"];
  if (Boolean(user) !== Boolean(pass)) throw new Error("SMTP_USER and SMTP_PASSWORD go together (both or neither).");
  return {
    mode,
    host: need("SMTP_HOST"),
    port,
    secure: secure === "true",
    from,
    auth: user && pass ? { user, pass } : null,
  };
}

export type OutgoingEmail = { to: string; subject: string; text: string };

export type EmailSender = { send(mail: OutgoingEmail): Promise<{ messageId: string }> };

export function createEmailSender(config: Extract<EmailConfig, { mode: "smtp" }>): EmailSender {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth ?? undefined,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
  return {
    async send(mail) {
      const info = await transport.sendMail({ from: config.from, to: mail.to, subject: mail.subject, text: mail.text });
      if (info.rejected.length > 0) {
        throw new Error(`the SMTP server rejected the recipient`);
      }
      return { messageId: info.messageId };
    },
  };
}

/** Plain-text rendering of one notification (no HTML: nothing to sanitize, nothing to track). */
export function renderNotificationEmail(input: {
  tenantName: string;
  severity: string;
  title: string;
  body: string | null;
  categoryCode: string;
  sourceModule: string;
  occurredAt: string;
  actionUrl: string | null;
}): { subject: string; text: string } {
  const prefix = input.severity === "critical" ? "[Maintafox - CRITICAL] " : "[Maintafox] ";
  const lines = [
    input.title,
    "",
    ...(input.body ? [input.body, ""] : []),
    `Site: ${input.tenantName}`,
    `Module: ${input.sourceModule} - category ${input.categoryCode}`,
    `Severity: ${input.severity}`,
    `Time (UTC): ${input.occurredAt}`,
    ...(input.actionUrl ? [`Open in Maintafox: ${input.actionUrl}`] : []),
    "",
    "Sent by Maintafox because email is enabled for this category in your notification settings.",
  ];
  return { subject: `${prefix}${input.title}`.slice(0, 200), text: lines.join("\n") };
}
