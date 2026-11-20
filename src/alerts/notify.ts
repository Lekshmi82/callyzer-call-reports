import nodemailer from "nodemailer";
import type { AppConfig } from "../config.js";
import { request } from "../lib/http.js";
import type { Logger } from "../logger.js";
import type { SettingsStore } from "../settings/store.js";

/** Failure alerts: email (SMTP_URL) and/or an incoming webhook (Slack / Google Chat / Teams style {text}). */
export class Alerter {
  constructor(
    private readonly config: AppConfig,
    private readonly settings: SettingsStore,
    private readonly log: Logger,
  ) {}

  async send(subject: string, text: string): Promise<void> {
    const alerts = await this.settings.get("alerts");
    const prefix = this.config.isProduction ? "" : `[${this.config.APP_ENV}] `;
    const tasks: Promise<unknown>[] = [];
    if (alerts.webhookUrl) {
      tasks.push(
        request({ method: "POST", url: alerts.webhookUrl, json: { text: `${prefix}${subject}\n${text}` }, timeoutMs: 15_000 }).then((r) => {
          if (r.status >= 300) throw new Error(`alert webhook returned ${r.status}`);
        }),
      );
    }
    if (alerts.emails.length && this.config.SMTP_URL) {
      const transport = nodemailer.createTransport(this.config.SMTP_URL);
      tasks.push(
        transport.sendMail({
          from: this.config.ALERT_EMAIL_FROM ?? "Callyzer Reports <no-reply@localhost>",
          to: alerts.emails.join(", "),
          subject: `${prefix}${subject}`,
          text,
        }),
      );
    }
    if (!tasks.length) {
      this.log.warn({ subject }, "alert not sent: no alert email/webhook configured");
      return;
    }
    const results = await Promise.allSettled(tasks);
    for (const r of results) if (r.status === "rejected") this.log.error({ err: String(r.reason) }, "failed to deliver alert");
  }
}
