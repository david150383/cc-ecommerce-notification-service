import nodemailer, { type Transporter } from "nodemailer";
import type { Logger } from "../lib/logger.js";

export interface OutgoingMessage {
  /** Our notification id: used as the provider message id, so a re-send is recognisable. */
  notificationId: string;
  to: string;
  subject: string;
  text: string;
}

/** The provider said "never": retrying cannot help (bad address, rejected content). */
export class PermanentDeliveryError extends Error {}

export interface ChannelSender {
  send(message: OutgoingMessage): Promise<{ providerMessageId: string }>;
}

/** SMTP: Mailpit locally (UI on :8025); SES or another provider's SMTP endpoint later. */
export class SmtpEmailSender implements ChannelSender {
  private readonly transport: Transporter;

  constructor(
    config: { host: string; port: number; secure: boolean; user?: string; password?: string; timeoutMs?: number },
    private readonly from: string,
    private readonly messageIdDomain = "notifications.shop.local",
  ) {
    this.transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.user && { auth: { user: config.user, pass: config.password } }),
      connectionTimeout: config.timeoutMs ?? 10_000,
      greetingTimeout: config.timeoutMs ?? 10_000,
      socketTimeout: config.timeoutMs ?? 10_000,
    });
  }

  async send(m: OutgoingMessage): Promise<{ providerMessageId: string }> {
    const messageId = `<${m.notificationId}@${this.messageIdDomain}>`;
    try {
      await this.transport.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text, messageId });
    } catch (err) {
      const code = (err as { responseCode?: number }).responseCode;
      // 5xx SMTP replies (e.g. 550 mailbox unavailable) are permanent; 4xx and network errors are not.
      if (code !== undefined && code >= 500) throw new PermanentDeliveryError(`SMTP ${code}`, { cause: err });
      throw err;
    }
    return { providerMessageId: messageId };
  }

  async verify(): Promise<void> {
    await this.transport.verify();
  }
}

/**
 * Local SMS stand-in: writes a delivery line to the log. Logs the masked number and length only:
 * message bodies stay out of logs on principle, even though no secret is ever sent by SMS.
 */
export class ConsoleSmsSender implements ChannelSender {
  constructor(private readonly logger: Logger) {}

  async send(m: OutgoingMessage): Promise<{ providerMessageId: string }> {
    this.logger.info({ notificationId: m.notificationId, to: maskPhone(m.to), length: m.text.length }, "SMS sent (console adapter)");
    return { providerMessageId: `console-${m.notificationId}` };
  }
}

export function maskPhone(phone: string): string {
  return phone.length <= 4 ? "****" : `${"*".repeat(phone.length - 4)}${phone.slice(-4)}`;
}
