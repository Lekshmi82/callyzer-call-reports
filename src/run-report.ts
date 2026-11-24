/**
 * Build the report image once and save it to ./out. Sends NOTHING.
 *
 *   npm run report                 # today, 00:00 IST → now (needs CALLYZER_API_TOKEN)
 *   npm run report -- --at 14:00   # data up to 2:00 PM IST today
 *   npm run report -- --sample     # fake data (watermarked), no Callyzer needed
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { isValidSlot, isoDate, slotInstant } from "./lib/time.js";
import { createLogger } from "./logger.js";
import { buildReport } from "./report/build.js";
import { ReportRenderer } from "./report/render.js";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { at: { type: "string" }, sample: { type: "boolean", default: false } } });
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL);

  const now = new Date();
  let cutoff = now;
  if (values.at) {
    if (!isValidSlot(values.at)) throw new Error("--at must be HH:mm (24h)");
    const at = slotInstant(isoDate(now), values.at);
    cutoff = at.getTime() < now.getTime() ? at : now;
  }

  const renderer = new ReportRenderer(log, cfg.CHROMIUM_EXECUTABLE_PATH);
  try {
    const r = await buildReport(cfg, log, renderer, { cutoff, sample: values.sample });
    fs.mkdirSync(cfg.OUTPUT_DIR, { recursive: true });
    const stamp = `${isoDate(cutoff)}-${r.model.asOfLabel.replace(/[: ]/g, "")}`;
    const file = path.join(cfg.OUTPUT_DIR, `report-${stamp}${values.sample ? "-sample" : ""}.png`);
    fs.writeFileSync(file, r.png);
    log.info({ file, bytes: r.png.length, caption: r.caption }, "report image saved (nothing sent)");
  } finally {
    await renderer.close();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ level: "fatal", msg: (err as Error).message }));
  process.exit(1);
});
