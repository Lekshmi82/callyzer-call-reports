/**
 * One command does everything: fetch today's Callyzer data (00:00 IST → now or --at), compute the
 * metrics, render the report image, and send it on WhatsApp.
 *
 *   npm run report                      # build the image only (saved in ./out), send nothing
 *   npm run report -- --target test     # send to WHATSAPP_TEST_TARGETS
 *   npm run report -- --target live     # send to WHATSAPP_LIVE_TARGETS
 *   npm run report -- --sample          # fake data (watermarked), no Callyzer needed
 *   npm run report -- --at 14:00        # data up to 2:00 PM IST today
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { CallyzerClient, callKinds, type CallRecord, type Employee, type EmployeeSummaryRow } from "./callyzer/client.js";
import { loadConfig, parseAliases } from "./config.js";
import { Crypto } from "./lib/crypto.js";
import { sleep } from "./lib/http.js";
import { isValidSlot, isoDate, slotInstant, startOfDay } from "./lib/time.js";
import { createLogger } from "./logger.js";
import { computeReport } from "./report/metrics.js";
import { ReportRenderer } from "./report/render.js";
import { sampleDataset } from "./report/sample.js";
import { renderReportHtml, summaryLine } from "./report/template.js";
import { MetaWhatsApp } from "./whatsapp/meta.js";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      target: { type: "string", default: "none" },
      at: { type: "string" },
      sample: { type: "boolean", default: false },
    },
  });
  const target = values.target as string;
  if (!["none", "test", "live"].includes(target)) throw new Error("--target must be none, test or live");
  if (values.sample && target === "live") throw new Error("Refusing to send sample data to the live targets");

  const env = values.sample && !process.env.CALLYZER_API_TOKEN ? { ...process.env, CALLYZER_API_TOKEN: "unused" } : process.env;
  const cfg = loadConfig(env);
  const log = createLogger(cfg.LOG_LEVEL);
  const crypto = new Crypto(cfg.HASH_SALT.padEnd(32, "#"));

  // ---- Time window (IST) ----
  const now = new Date();
  let cutoff = now;
  if (values.at) {
    if (!isValidSlot(values.at)) throw new Error("--at must be HH:mm (24h)");
    const at = slotInstant(isoDate(now), values.at);
    cutoff = at.getTime() < now.getTime() ? at : now;
  }
  const from = startOfDay(cutoff);
  log.info({ from: from.toISOString(), cutoff: cutoff.toISOString(), target, sample: values.sample }, "building report");

  // ---- Data ----
  let employees: Employee[];
  let summaries: EmployeeSummaryRow[];
  let records: CallRecord[];
  if (values.sample) {
    ({ employees, summaries, records } = sampleDataset(from, cutoff));
  } else {
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

  // ---- Renames / exclusions (by Callyzer employee name) ----
  const aliases = parseAliases(cfg.EMPLOYEE_ALIASES);
  const excluded = new Set(cfg.EXCLUDE_EMPLOYEES.map((x) => x.toLowerCase()));
  const fix = <T extends { empName: string }>(rows: T[]) =>
    rows
      .map((r) => ({ ...r, empName: aliases.get(r.empName.trim().toLowerCase()) ?? r.empName }))
      .filter((r) => !excluded.has(r.empName.trim().toLowerCase()));
  employees = fix(employees);
  summaries = fix(summaries);
  records = fix(records);

  // ---- Metrics + image ----
  const result = computeReport({
    title: cfg.REPORT_TITLE,
    cutoff,
    generatedAt: now,
    source: values.sample ? "sample" : "callyzer",
    employees,
    summaries,
    records,
    overrides: new Map(),
    phoneKey: (n) => crypto.phoneKey(n),
    defaultCountryCode: cfg.DEFAULT_COUNTRY_CODE,
    staleSyncMinutes: cfg.STALE_SYNC_MINUTES,
    includesWhatsApp: cfg.CALLYZER_INCLUDE_WHATSAPP_CALLS,
  });
  for (const w of result.warnings) log.warn(w);
  const m = result.model;
  log.info({ ...result.stats, totalCalls: m.team.totalCalls, connected: m.team.connectedCalls }, "computed metrics");

  const renderer = new ReportRenderer(log, cfg.CHROMIUM_EXECUTABLE_PATH);
  const { png } = await renderer.renderPng(renderReportHtml(m)).finally(() => renderer.close());
  fs.mkdirSync(cfg.OUTPUT_DIR, { recursive: true });
  const stamp = `${isoDate(cutoff)}-${m.asOfLabel.replace(/[: ]/g, "")}`;
  const file = path.join(cfg.OUTPUT_DIR, `report-${stamp}${values.sample ? "-sample" : ""}.png`);
  fs.writeFileSync(file, png);
  log.info({ file, bytes: png.length }, "report image saved");
  if (target === "none") return 0;

  // ---- WhatsApp ----
  const targets = target === "live" ? cfg.WHATSAPP_LIVE_TARGETS : cfg.WHATSAPP_TEST_TARGETS;
  if (!targets.length) throw new Error(`No WhatsApp targets configured (WHATSAPP_${target.toUpperCase()}_TARGETS)`);
  if (!cfg.WHATSAPP_TOKEN || !cfg.WHATSAPP_PHONE_NUMBER_ID) throw new Error("WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required to send");
  const wa = new MetaWhatsApp({ token: cfg.WHATSAPP_TOKEN, phoneNumberId: cfg.WHATSAPP_PHONE_NUMBER_ID, apiVersion: cfg.WHATSAPP_API_VERSION, baseUrl: cfg.WHATSAPP_API_BASE });

  let imageId = "";
  for (let attempt = 1; ; attempt++) {
    try {
      imageId = await wa.uploadPng(png, path.basename(file));
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      log.warn({ attempt, err: (e as Error).message }, "image upload failed; retrying");
      await sleep(5_000 * attempt);
    }
  }

  const caption = `${m.title} · ${m.dateLabel}, as of ${m.asOfLabel} IST\n${summaryLine(m)}`;
  let failures = 0;
  for (const t of targets) {
    const label = t.startsWith("group:") ? "group" : `••••${t.slice(-4)}`;
    try {
      const id = await wa.send(
        t,
        cfg.WHATSAPP_MESSAGE_TYPE === "template"
          ? { kind: "template", name: cfg.WHATSAPP_TEMPLATE_NAME, language: cfg.WHATSAPP_TEMPLATE_LANGUAGE, imageId, bodyParams: [m.dateLabel, m.asOfLabel, summaryLine(m)] }
          : { kind: "image", imageId, caption },
      );
      log.info({ to: label, messageId: id }, "sent");
    } catch (e) {
      failures++;
      log.error({ to: label, err: (e as Error).message }, "send failed");
    }
  }
  log.info({ sent: targets.length - failures, failed: failures }, "done");
  return failures ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(JSON.stringify({ level: "fatal", msg: (err as Error).message }));
    process.exit(1);
  },
);
