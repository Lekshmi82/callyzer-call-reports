import { z } from "zod";
import type { Db } from "../db/pool.js";
import type { Crypto } from "../lib/crypto.js";
import { isValidSlot } from "../lib/time.js";

/** Non-secret settings, each validated with zod on read and write. */
export const SettingsSchemas = {
  callyzer: z.object({
    baseUrl: z.string().url().default("https://api1.callyzer.co/api/v2.3"),
    /** Which call kinds to include. Callyzer requires one request per (method, mode) pair. */
    includeWhatsAppCalls: z.boolean().default(false),
    /** Flag a phone in the footer if its last sync is older than this many minutes before the cutoff. */
    staleSyncMinutes: z.number().int().min(5).max(24 * 60).default(90),
  }),
  wati: z.object({
    apiHost: z.string().url().default("https://live-mt-server.wati.io"),
    /** Optional sending channel number; blank = workspace default channel. */
    channel: z.string().default(""),
    templateName: z.string().default(""),
    /** WATI custom param name mapped to the template's image header link, e.g. "report_image". */
    imageParam: z.string().default(""),
    /** Optional custom param names for body text. */
    dateParam: z.string().default(""),
    timeParam: z.string().default(""),
    summaryParam: z.string().default(""),
  }),
  schedule: z.object({
    enabled: z.boolean().default(false),
    slots: z.array(z.string().refine(isValidSlot, "Use HH:mm (24h)")).default(["14:00", "16:00", "18:00", "20:00"]),
    /** ISO weekdays: 1 = Mon ... 7 = Sun */
    daysOfWeek: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5, 6, 7]),
    /** How long after a slot we keep trying (also covers catch-up after downtime). */
    graceMinutes: z.number().int().min(10).max(180).default(60),
  }),
  alerts: z.object({
    emails: z.array(z.string().email()).default([]),
    /** Optional incoming-webhook URL (Slack / Google Chat / Teams compatible JSON {text}). */
    webhookUrl: z.string().url().or(z.literal("")).default(""),
  }),
  report: z.object({
    title: z.string().max(60).default("Call Report"),
    retentionDays: z.number().int().min(7).max(365).default(60),
  }),
} as const;

export type SettingsKey = keyof typeof SettingsSchemas;
export type Settings<K extends SettingsKey> = z.infer<(typeof SettingsSchemas)[K]>;

export const SECRET_NAMES = ["callyzer_api_token", "wati_api_token", "wati_webhook_token"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export class SettingsStore {
  constructor(
    private readonly db: Db,
    private readonly crypto: Crypto,
    private readonly envSecrets: Partial<Record<SecretName, string>> = {},
  ) {}

  async get<K extends SettingsKey>(key: K): Promise<Settings<K>> {
    const r = await this.db.query<{ value: unknown }>("SELECT value FROM settings WHERE key = $1", [key]);
    const schema = SettingsSchemas[key];
    const parsed = schema.safeParse(r.rows[0]?.value ?? {});
    // If stored data is somehow invalid, fall back to defaults rather than crash the scheduler.
    return (parsed.success ? parsed.data : schema.parse({})) as Settings<K>;
  }

  async set<K extends SettingsKey>(key: K, value: unknown, by: string): Promise<Settings<K>> {
    const data = SettingsSchemas[key].parse(value) as Settings<K>;
    await this.db.query(
      `INSERT INTO settings(key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(data), by],
    );
    return data;
  }

  async getSecret(name: SecretName): Promise<string | null> {
    const fromEnv = this.envSecrets[name];
    if (fromEnv) return fromEnv;
    const r = await this.db.query<{ ciphertext: string }>("SELECT ciphertext FROM secrets WHERE name = $1", [name]);
    const row = r.rows[0];
    if (!row) return null;
    try {
      return this.crypto.decrypt(row.ciphertext);
    } catch {
      throw new Error(
        `Stored secret "${name}" cannot be decrypted. APP_ENCRYPTION_KEY probably changed; re-enter it in Settings.`,
      );
    }
  }

  async setSecret(name: SecretName, value: string, by: string): Promise<void> {
    await this.db.query(
      `INSERT INTO secrets(name, ciphertext, updated_at, updated_by) VALUES ($1, $2, now(), $3)
       ON CONFLICT (name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [name, this.crypto.encrypt(value), by],
    );
  }

  async deleteSecret(name: SecretName): Promise<void> {
    await this.db.query("DELETE FROM secrets WHERE name = $1", [name]);
  }

  /** Safe description for the UI: never includes the value. */
  async describeSecret(name: SecretName): Promise<{ configured: boolean; source: "env" | "dashboard" | null; updatedAt: Date | null }> {
    if (this.envSecrets[name]) return { configured: true, source: "env", updatedAt: null };
    const r = await this.db.query<{ updated_at: Date }>("SELECT updated_at FROM secrets WHERE name = $1", [name]);
    const row = r.rows[0];
    return row ? { configured: true, source: "dashboard", updatedAt: row.updated_at } : { configured: false, source: null, updatedAt: null };
  }

  async setStatus(key: string, value: Record<string, unknown>): Promise<void> {
    await this.db.query(
      `INSERT INTO integration_status(key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = integration_status.value || EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  async getStatus(key: string): Promise<Record<string, unknown>> {
    const r = await this.db.query<{ value: Record<string, unknown> }>("SELECT value FROM integration_status WHERE key = $1", [key]);
    return r.rows[0]?.value ?? {};
  }
}
