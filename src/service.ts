/**
 * Always-on service: keeps the WhatsApp Web login, posts the report to the WhatsApp group at the
 * scheduled IST times, and serves a password-protected status page (QR login, test sends, switches).
 *
 *   npm start
 *
 * Safety defaults: schedule OFF and target = TEST group until switched on the status page.
 */
import http from "node:http";
import { chromium } from "playwright";
import { loadConfig, type AppConfig } from "./config.js";
import { safeEqual } from "./lib/crypto.js";
import { escapeHtml } from "./lib/html.js";
import { clockLabel, isoDate, upcomingSlots } from "./lib/time.js";
import { createLogger } from "./logger.js";
import { buildReport } from "./report/build.js";
import { PuppeteerPageRenderer, ReportRenderer, type PngRenderer } from "./report/render.js";
import { dueSlots, StateStore } from "./schedule.js";
import { WhatsAppGroupSender } from "./whatsapp/web.js";

const cfg: AppConfig = loadConfig();
const log = createLogger(cfg.LOG_LEVEL);
const state = new StateStore(cfg.DATA_DIR);
const chromePath = cfg.CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
const wa = new WhatsAppGroupSender(cfg.DATA_DIR, chromePath, log);

const settings = () => {
  const s = state.settings();
  return { scheduleEnabled: s.scheduleEnabled ?? cfg.SCHEDULE_ENABLED, sendTo: s.sendTo ?? cfg.SEND_TO };
};
const groupFor = (to: "test" | "live") => (to === "live" ? cfg.WHATSAPP_LIVE_GROUP : cfg.WHATSAPP_TEST_GROUP);

/** Prefer WhatsApp's own browser (one Chromium in memory); fall back to a temporary Playwright browser. */
async function withRenderer<T>(fn: (r: PngRenderer) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pup = (wa as any).client?.pupBrowser;
  if (wa.state === "ready" && pup) return fn(new PuppeteerPageRenderer(() => pup));
  const r = new ReportRenderer(log, chromePath);
  try {
    return await fn(r);
  } finally {
    await r.close();
  }
}

let busy = false;
const lastAttempt = new Map<string, number>();

async function sendReport(kind: "scheduled" | "manual", key: string, to: "test" | "live", cutoff: Date): Promise<void> {
  const group = groupFor(to);
  // Without a Callyzer key, only a watermarked SAMPLE report may go to the TEST group (to check the WhatsApp link).
  const sample = !cfg.CALLYZER_API_TOKEN;
  busy = true;
  try {
    if (sample && (kind === "scheduled" || to === "live")) throw new Error("CALLYZER_API_TOKEN is not set: only a sample report to the TEST group is allowed.");
    if (wa.state !== "ready") throw new Error(`WhatsApp is not connected (${wa.state}). Open the status page and scan the QR code.`);
    const report = await withRenderer((r) => buildReport(cfg, log, r, { cutoff, sample }));
    await wa.sendToGroup(group, report.png, report.caption, `call-report-${isoDate(cutoff)}.png`);
    if (kind === "scheduled") state.markSent(key);
    state.addHistory({ kind, key, group: to, status: "sent", detail: `${sample ? "SAMPLE data · " : ""}${report.model.team.totalCalls} calls, ${report.model.team.connectedCalls} connected` });
    log.info({ kind, key, to }, "report sent");
  } catch (e) {
    const msg = (e as Error).message;
    state.addHistory({ kind, key, group: to, status: kind === "scheduled" ? "retrying" : "failed", detail: msg.slice(0, 300) });
    log.error({ kind, key, to, err: msg }, "report failed");
    throw e;
  } finally {
    busy = false;
  }
}

async function tick(): Promise<void> {
  const s = settings();
  if (!s.scheduleEnabled || busy) return;
  for (const slot of dueSlots(new Date(), cfg.REPORT_SLOTS, cfg.REPORT_DAYS, cfg.GRACE_MINUTES)) {
    if (state.isSent(slot.key)) continue;
    if (Date.now() - (lastAttempt.get(slot.key) ?? 0) < 3 * 60_000) continue; // retry every 3 min within the grace window
    lastAttempt.set(slot.key, Date.now());
    await sendReport("scheduled", slot.key, s.sendTo, slot.cutoff).catch(() => undefined);
    return; // one at a time
  }
}

// ---------------- Status page ----------------

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Call Report Bot</title><style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#16181d;--mute:#5f6670;--line:#e3e6ea;--ok:#127a3a;--bad:#b42318;--btn:#1f4f9e}
@media (prefers-color-scheme:dark){:root{--bg:#111316;--card:#1b1e23;--fg:#e9ecef;--mute:#9aa3ad;--line:#2b3037;--ok:#4cc27a;--bad:#ff7a6e;--btn:#5b8def}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 Inter,system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:16px}h1{font-size:20px;margin:6px 0 14px}h2{font-size:15px;margin:0 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:12px}
.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}.mute{color:var(--mute);font-size:13px}
button{background:var(--btn);color:#fff;border:0;border-radius:8px;padding:9px 14px;font:inherit;font-weight:600;cursor:pointer;margin:4px 6px 4px 0}
button.alt{background:transparent;color:var(--btn);border:1px solid var(--btn)}form{display:inline}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px 4px;border-bottom:1px solid var(--line);vertical-align:top}
img.qr{background:#fff;padding:8px;border-radius:8px;max-width:100%}code{font-size:13px}
</style></head><body><main>${body}</main></body></html>`;
}

async function statusHtml(flash: string): Promise<string> {
  const s = settings();
  const groups = await wa.groupNames().catch(() => []);
  const has = (n: string) => n && groups.some((g) => g.trim().toLowerCase() === n.trim().toLowerCase());
  const waBlock =
    wa.state === "ready"
      ? `<span class="ok">Connected</span> <span class="mute">(${escapeHtml(wa.me ?? "")})</span>`
      : wa.state === "qr" && wa.qrDataUrl
        ? `<span class="bad">Not logged in</span><p>On the phone with the sending number: WhatsApp → <b>Linked devices</b> → <b>Link a device</b>, then scan:</p><img class="qr" src="${wa.qrDataUrl}" alt="WhatsApp QR code"><p class="mute">Page refreshes every 20 s.</p>`
        : `<span class="bad">${escapeHtml(wa.state)}</span> <span class="mute">${escapeHtml(wa.lastError ?? "starting… refresh in a few seconds")}</span>`;
  const groupRow = (label: string, name: string) =>
    `<tr><td>${label}</td><td>${name ? escapeHtml(name) : '<span class="bad">not set</span>'}</td><td>${wa.state !== "ready" ? "–" : has(name) ? '<span class="ok">found</span>' : '<span class="bad">not found</span>'}</td></tr>`;
  const next = upcomingSlots(cfg.REPORT_SLOTS, cfg.REPORT_DAYS, new Date(), 4).map((d) => `${isoDate(d)} ${clockLabel(d)}`);
  const hist = state
    .history()
    .slice(0, 15)
    .map((h) => `<tr><td>${escapeHtml(new Date(h.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }))}</td><td>${h.kind}</td><td>${h.group}</td><td class="${h.status === "sent" ? "ok" : "bad"}">${h.status}</td><td>${escapeHtml(h.detail)}</td></tr>`)
    .join("");
  return page(`
<h1>Call Report Bot</h1>
${flash ? `<div class="card"><b>${escapeHtml(flash)}</b></div>` : ""}
<div class="card"><h2>WhatsApp</h2>${waBlock}</div>
<div class="card"><h2>Groups</h2><table>${groupRow("Test group", cfg.WHATSAPP_TEST_GROUP)}${groupRow("Main group", cfg.WHATSAPP_LIVE_GROUP)}</table>
${wa.state === "ready" && groups.length ? `<p class="mute">Groups on this number: ${groups.map(escapeHtml).join(" · ")}</p>` : ""}</div>
<div class="card"><h2>Send now</h2>
<form method="post" action="/send/test"><button>${cfg.CALLYZER_API_TOKEN ? "Send report to TEST group" : "Send SAMPLE report to TEST group"}</button></form>
<form method="post" action="/send/live" onsubmit="return confirm('Send the report to the MAIN group now?')"><button class="alt">Send report to MAIN group</button></form>
<a href="/preview.png" target="_blank"><button class="alt" type="button">Preview image (no send)</button></a>
<p class="mute">Callyzer token: ${cfg.CALLYZER_API_TOKEN ? '<span class="ok">set</span>' : '<span class="bad">missing (set CALLYZER_API_TOKEN)</span>'}</p></div>
<div class="card"><h2>Automatic schedule</h2>
<p>Status: ${s.scheduleEnabled ? '<span class="ok">ON</span>' : '<span class="bad">OFF</span>'} · Sends to: <b>${s.sendTo === "live" ? "MAIN group" : "TEST group"}</b> · Times (IST): ${cfg.REPORT_SLOTS.join(", ")}</p>
<form method="post" action="/schedule/${s.scheduleEnabled ? "off" : "on"}"><button class="${s.scheduleEnabled ? "alt" : ""}">${s.scheduleEnabled ? "Turn schedule OFF" : "Turn schedule ON"}</button></form>
<form method="post" action="/target/${s.sendTo === "live" ? "test" : "live"}" ${s.sendTo === "live" ? "" : `onsubmit="return confirm('Scheduled reports will go to the MAIN group. Continue?')"`}><button class="alt">Switch to ${s.sendTo === "live" ? "TEST" : "MAIN"} group</button></form>
<p class="mute">Next times: ${next.join(" · ") || "none"}</p></div>
<div class="card"><h2>Recent activity</h2>${hist ? `<table><tr><th>When</th><th>Type</th><th>Group</th><th>Result</th><th>Detail</th></tr>${hist}</table>` : '<p class="mute">Nothing sent yet.</p>'}</div>
<div class="card"><form method="post" action="/logout" onsubmit="return confirm('Log this number out of the bot? A new QR scan will be needed.')"><button class="alt">Log out WhatsApp</button></form></div>`);
}

function authorised(req: http.IncomingMessage): boolean {
  if (!cfg.ADMIN_PASSWORD) return false;
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Basic ")) return false;
  const [user, ...rest] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":");
  return user === "admin" && safeEqual(rest.join(":"), cfg.ADMIN_PASSWORD);
}

/** Blocks cross-site form posts (basic auth is sent automatically by browsers). */
function sameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return req.headers["sec-fetch-site"] === undefined || req.headers["sec-fetch-site"] === "same-origin";
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (status: number, body: string | Buffer, type = "text/html; charset=utf-8", extra: Record<string, string> = {}) => {
    res.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...extra,
    });
    res.end(body);
  };
  const back = (msg: string) => send(303, "", "text/plain", { Location: `/?m=${encodeURIComponent(msg)}` });

  if (url.pathname === "/healthz") return send(200, JSON.stringify({ ok: true, whatsapp: wa.state }), "application/json");
  if (!cfg.ADMIN_PASSWORD) return send(503, page("<h1>Set the ADMIN_PASSWORD variable to use this page.</h1>"));
  if (!authorised(req)) return send(401, "Login required", "text/plain", { "WWW-Authenticate": 'Basic realm="Call Report Bot", charset="UTF-8"' });

  try {
    if (req.method === "GET" && url.pathname === "/") {
      const html = await statusHtml(url.searchParams.get("m") ?? "");
      return send(200, wa.state === "ready" ? html : html.replace("<head>", '<head><meta http-equiv="refresh" content="20">'));
    }
    if (req.method === "GET" && url.pathname === "/preview.png") {
      const sample = !cfg.CALLYZER_API_TOKEN;
      const r = await withRenderer((rr) => buildReport(cfg, log, rr, { cutoff: new Date(), sample }));
      return send(200, r.png, "image/png");
    }
    if (req.method === "POST") {
      if (!sameOrigin(req)) return send(403, "Cross-site request blocked", "text/plain");
      const m = /^\/(send|schedule|target)\/(test|live|on|off)$/.exec(url.pathname);
      if (url.pathname === "/logout") {
        await wa.logout();
        return back("Logged out. Scan the new QR code to log in again.");
      }
      if (m?.[1] === "send" && (m[2] === "test" || m[2] === "live")) {
        if (busy) return back("A report is already being sent. Try again in a minute.");
        await sendReport("manual", `manual ${new Date().toISOString()}`, m[2], new Date());
        return back(`Report sent to the ${m[2] === "live" ? "MAIN" : "TEST"} group.`);
      }
      if (m?.[1] === "schedule" && (m[2] === "on" || m[2] === "off")) {
        state.updateSettings({ scheduleEnabled: m[2] === "on" });
        return back(`Schedule turned ${m[2].toUpperCase()}.`);
      }
      if (m?.[1] === "target" && (m[2] === "test" || m[2] === "live")) {
        state.updateSettings({ sendTo: m[2] });
        return back(`Scheduled reports now go to the ${m[2] === "live" ? "MAIN" : "TEST"} group.`);
      }
    }
    return send(404, "Not found", "text/plain");
  } catch (e) {
    return back(`Failed: ${(e as Error).message}`);
  }
});

server.listen(cfg.PORT, () => log.info({ port: cfg.PORT }, "status page listening"));
void wa.start();
const timer = setInterval(() => void tick().catch((e) => log.error({ err: String(e) }, "tick failed")), 30_000);

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    log.info({ sig }, "shutting down");
    clearInterval(timer);
    server.close();
    await wa.stop();
    process.exit(0);
  });
}
