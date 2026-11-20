import { z } from "zod";

/**
 * All configuration comes from environment variables (see .env.example). No secrets in code or Git.
 *
 * In a Claude cloud environment, the Callyzer and WhatsApp tokens can be stored as network secrets:
 * the proxy adds the Authorization header itself, so these variables can hold any placeholder value.
 */
const list = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean));

const schema = z.object({
  CALLYZER_API_TOKEN: z.string().min(1, "CALLYZER_API_TOKEN is required"),
  CALLYZER_BASE_URL: z.string().url().default("https://api1.callyzer.co/api/v2.3"),
  CALLYZER_INCLUDE_WHATSAPP_CALLS: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  DEFAULT_COUNTRY_CODE: z.string().default("91"),
  STALE_SYNC_MINUTES: z.coerce.number().int().positive().default(90),
  /** Names (as in Callyzer) to leave out of the report, comma-separated. */
  EXCLUDE_EMPLOYEES: list,
  /** Optional renames to combine phones registered under different names: "Old Name=New Name;Other=New". */
  EMPLOYEE_ALIASES: z.string().default(""),
  REPORT_TITLE: z.string().default("Call Report"),

  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().default("v23.0"),
  WHATSAPP_API_BASE: z.string().url().default("https://graph.facebook.com"),
  /** "template" (approved template with IMAGE header; works any time) or "image" (plain image + caption). */
  WHATSAPP_MESSAGE_TYPE: z.enum(["template", "image"]).default("template"),
  WHATSAPP_TEMPLATE_NAME: z.string().default("call_report"),
  WHATSAPP_TEMPLATE_LANGUAGE: z.string().default("en"),
  /** Comma-separated targets: phone numbers with country code (919876543210) or group:<GROUP_ID>. */
  WHATSAPP_TEST_TARGETS: list,
  WHATSAPP_LIVE_TARGETS: list,

  /** Used only to build keyed hashes of phone numbers in memory; any long random string. */
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
