import { CallyzerClient, callKinds, type CallRecord, type Employee, type EmployeeSummaryRow } from "../callyzer/client.js";
import { parseAliases, type AppConfig } from "../config.js";
import { Crypto } from "../lib/crypto.js";
import { startOfDay } from "../lib/time.js";
import type { Logger } from "../logger.js";
import { computeReport, type ReportModel } from "./metrics.js";
import type { PngRenderer } from "./render.js";
import { sampleDataset } from "./sample.js";
import { renderReportHtml, summaryLine } from "./template.js";

export interface BuiltReport {
  png: Buffer;
  model: ReportModel;
  caption: string;
  warnings: string[];
}

/** Fetch Callyzer data for 00:00 IST → cutoff, compute metrics and render the report image. */
export async function buildReport(
  cfg: AppConfig,
  log: Logger,
  renderer: PngRenderer,
  opts: { cutoff: Date; sample?: boolean },
): Promise<BuiltReport> {
  const cutoff = opts.cutoff;
  const from = startOfDay(cutoff);
  let employees: Employee[];
  let summaries: EmployeeSummaryRow[];
  let records: CallRecord[];

  if (opts.sample) {
    ({ employees, summaries, records } = sampleDataset(from, cutoff));
  } else {
    if (!cfg.CALLYZER_API_TOKEN) throw new Error("CALLYZER_API_TOKEN is not set");
    const client = new CallyzerClient({ baseUrl: cfg.CALLYZER_BASE_URL, token: cfg.CALLYZER_API_TOKEN, log });
    employees = await client.listEmployees();
    // Working/idle hours come from phone calls (Callyzer reports them per call kind).
    summaries = await client.employeeSummary(from, cutoff, { call_method: "PhoneCall", call_mode: "Voice" });
    records = [];
    for (const kind of callKinds(cfg.CALLYZER_INCLUDE_WHATSAPP_CALLS)) {
      const r = await client.callHistory(from, cutoff, kind);
      log.info({ kind, records: r.records.length, via: r.via }, "fetched call history");
      records.push(...r.records);
    }
  }

  // Renames (to combine phones registered under different names) and exclusions, by Callyzer name.
  const aliases = parseAliases(cfg.EMPLOYEE_ALIASES);
  const excluded = new Set(cfg.EXCLUDE_EMPLOYEES.map((x) => x.toLowerCase()));
  const fix = <T extends { empName: string }>(rows: T[]) =>
    rows
      .map((r) => ({ ...r, empName: aliases.get(r.empName.trim().toLowerCase()) ?? r.empName }))
      .filter((r) => !excluded.has(r.empName.trim().toLowerCase()));

  const crypto = new Crypto(cfg.HASH_SALT.padEnd(32, "#"));
  const result = computeReport({
    title: cfg.REPORT_TITLE,
    cutoff,
    generatedAt: new Date(),
    source: opts.sample ? "sample" : "callyzer",
    employees: fix(employees),
    summaries: fix(summaries),
    records: fix(records),
    overrides: new Map(),
    phoneKey: (n) => crypto.phoneKey(n),
    defaultCountryCode: cfg.DEFAULT_COUNTRY_CODE,
    staleSyncMinutes: cfg.STALE_SYNC_MINUTES,
    includesWhatsApp: cfg.CALLYZER_INCLUDE_WHATSAPP_CALLS,
  });
  for (const w of result.warnings) log.warn(w);
  log.info({ ...result.stats, totalCalls: result.model.team.totalCalls }, "computed metrics");

  const { png } = await renderer.renderPng(renderReportHtml(result.model));
  const m = result.model;
  const caption = `*${m.title} · ${m.dateLabel}*\nAs of ${m.asOfLabel} IST · ${summaryLine(m)}`;
  return { png, model: m, caption, warnings: result.warnings };
}
