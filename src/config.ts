import { z } from "zod";

/** All configuration comes from environment variables (see .env.example). No secrets in code or Git. */
const listOf = (def: string) =>
  z
    .string()
    .default(def)
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean));
const list = listOf("");

const schema = z.object({
  // --- Callyzer
  CALLYZER_API_TOKEN: z.string().optional(),
  CALLYZER_BASE_URL: z.string().url().default("https://api1.callyzer.co/api/v2.3"),
  CALLYZER_INCLUDE_WHATSAPP_CALLS: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  DEFAULT_COUNTRY_CODE: z.string().default("91"),
  STALE_SYNC_MINUTES: z.coerce.number().int().positive().default(90),
  /** Callyzer names to leave out of the report, comma-separated. */
  EXCLUDE_EMPLOYEES: list,
  /** Combine phones registered under different names: "Old Name=New Name;Other=New". */
  EMPLOYEE_ALIASES: z.string().default(""),
  REPORT_TITLE: z.string().default("Call Report"),

  // --- WhatsApp group (whatsapp-web.js)
  /** Exact WhatsApp group names. */
  WHATSAPP_TEST_GROUP: z.string().default(""),
  WHATSAPP_LIVE_GROUP: z.string().default(""),
  /** Which group the scheduled reports go to: "test" or "live". */
  SEND_TO: z.enum(["test", "live"]).default("test"),

  // --- Schedule (IST)
  SCHEDULE_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  REPORT_SLOTS: listOf("14:00,16:00,18:00,20:00"),
  /** ISO weekdays to send on: 1=Mon … 7=Sun */
  REPORT_DAYS: listOf("1,2,3,4,5,6,7").transform((a) => a.map(Number).filter((n) => n >= 1 && n <= 7)),
  /** Keep retrying a failed slot for this many minutes. */
  GRACE_MINUTES: z.coerce.number().int().min(5).max(180).default(45),

  // --- Service
  PORT: z.coerce.number().int().positive().default(3000),
  /** Password for the status/QR page (username: admin). */
  ADMIN_PASSWORD: z.string().optional(),
  /** Persistent folder for the WhatsApp login session and sent-log (mount a volume here). */
  DATA_DIR: z.string().default("data"),
  HASH_SALT: z.string().default("callyzer-call-reports"),
  OUTPUT_DIR: z.string().default("out"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug"]).default("info"),
  CHROMIUM_EXECUTABLE_PATH: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== "") cleaned[k] = v;
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  return parsed.data;
}

export function parseAliases(s: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const pair of s.split(";")) {
    const [from, to] = pair.split("=").map((x) => x?.trim());
    if (from && to) m.set(from.toLowerCase(), to);
  }
  return m;
}
