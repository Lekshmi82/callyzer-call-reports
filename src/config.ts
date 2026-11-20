import { z } from "zod";

/**
 * All environment-level configuration. Business settings (credentials, schedule,
 * recipients) live in the database and are edited from the admin dashboard.
 */
const boolish = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

const schema = z.object({
  NODE_ENV: z.string().default("production"),
  APP_ENV: z.enum(["production", "staging", "development"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  /** "disable" (default; e.g. private network), "require" (TLS, verified) or "no-verify" (TLS, unverified cert). */
  DATABASE_SSL: z.enum(["disable", "require", "no-verify"]).default("disable"),
  APP_ENCRYPTION_KEY: z
    .string()
    .min(32, "APP_ENCRYPTION_KEY must be at least 32 characters (use: openssl rand -base64 32)"),
  PUBLIC_BASE_URL: z.string().url().optional(),
  TRUST_PROXY: boolish.default(true),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  SCHEDULER_ENABLED: boolish.default(true),
  /** Outside production, deliveries go to test recipients only unless this is true. */
  ALLOW_LIVE_DELIVERY: boolish.default(false),
  ADMIN_BOOTSTRAP_EMAIL: z.string().email().optional(),
  ADMIN_BOOTSTRAP_PASSWORD: z.string().min(12).optional(),
  CHROMIUM_EXECUTABLE_PATH: z.string().optional(),
  /** Optional: credentials from a secret manager take precedence over dashboard values. */
  CALLYZER_API_TOKEN: z.string().optional(),
  WATI_API_TOKEN: z.string().optional(),
  /** Optional SMTP connection string for failure alerts, e.g. smtps://user:pass@smtp.example.com:465 */
  SMTP_URL: z.string().optional(),
  ALERT_EMAIL_FROM: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema> & {
  isProduction: boolean;
  liveDeliveryAllowed: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Treat empty strings as "unset" so .env templates with blank values behave.
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== "") cleaned[k] = v;
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const c = parsed.data;
  const isProduction = c.APP_ENV === "production";
  return { ...c, isProduction, liveDeliveryAllowed: isProduction || c.ALLOW_LIVE_DELIVERY };
}
