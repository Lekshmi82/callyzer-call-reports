# Handoff: Callyzer → WhatsApp group call report bot

_Last updated: 24 Nov 2026_

## What this is

A Node.js service that, at **2, 4, 6 and 8 PM IST**, pulls today's calling data from the **Callyzer API**, builds a report image (employee table + Team row) and posts it into a **WhatsApp group** from **+91 90081 28705** using **whatsapp-web.js** (a WhatsApp Web session linked by QR, like "Linked devices").

It currently runs **on a Windows PC** (`C:\Users\ELCOT\callyzer-call-reports`). The PC must be on, awake and running `npm.cmd start` at the report times. Moving to an always-on cloud host is planned (see "Next steps").

Repo: `github.com/Lekshmi82/callyzer-call-reports` (personal account; to be moved to the office GitHub).

## Current state

| Area | State |
|---|---|
| Report image layout | Done. Matches requested format (see "Report format") |
| WhatsApp link (QR) | **Working on the PC.** Sample report delivered to the test group |
| Test group | `RevOps Automation Test/Alerts` |
| Main group | **Not set yet** (`WHATSAPP_LIVE_GROUP` empty → main sends are refused) |
| Callyzer API key | **Not added yet.** Without it only a watermarked SAMPLE report can be sent, and only to the test group |
| Schedule | OFF by default; turned on from the status page. Was being tested with 3-minute test slots (`REPORT_SLOTS`) |
| Real Callyzer data | **Never run against the live API.** Client is built from the official v2.3 docs and tested against a mock only |

## How to run locally

Prereqs: **Node.js 22 LTS**, **Git**. On Windows PowerShell with script execution disabled, use `npm.cmd` / `npx.cmd` instead of `npm` / `npx`.

```bash
git clone https://github.com/Lekshmi82/callyzer-call-reports
cd callyzer-call-reports
npm ci
npx playwright install chromium
cp .env.example .env        # Windows: copy .env.example .env
# edit .env (see below)
npm start                   # status page: http://localhost:3000  (user: admin / ADMIN_PASSWORD)
```

First start: a QR appears on the status page (or in the visible browser if `WHATSAPP_SHOW_BROWSER=true`). Scan it from the sending phone: WhatsApp → Linked devices → Link a device. The login is saved in `data/wwebjs/` so later restarts don't need a scan.

Other commands:

```bash
npm run report              # build today's image into ./out (sends nothing)
npm run report -- --sample  # fake, watermarked data
npm run report -- --at 14:00
npm test                    # 20 tests: metrics, Callyzer client vs mock, end-to-end, schedule
npm run typecheck
npm run mock:callyzer       # mock Callyzer API on :4010 (token: mock-callyzer-token)
```

## Configuration (`.env`, never committed)

| Variable | Notes |
|---|---|
| `CALLYZER_API_TOKEN` | From Callyzer admin: Connectors → API & Webhook → API Config → Generate API Access Key. Needs the API add-on |
| `CALLYZER_BASE_URL` | Default `https://api1.callyzer.co/api/v2.3` (from the docs). Callyzer's own Postman collection uses `https://api1.callyzer.co/v2.1`; try that if you get a 404 |
| `WHATSAPP_TEST_GROUP` / `WHATSAPP_LIVE_GROUP` | Exact group names (quote them if they contain spaces or `/`) |
| `SEND_TO` | `test` or `live`: default target for scheduled sends (the status page can override; stored in `data/state.json`) |
| `SCHEDULE_ENABLED` | Default `false`; the status page can override |
| `REPORT_SLOTS` | `14:00,16:00,18:00,20:00` (IST, 24h). **Reset this if it was left on test times** |
| `REPORT_DAYS` | ISO weekdays `1..7` |
| `ADMIN_PASSWORD` | Status page password (user `admin`). **The first password was shared in chat; it should be changed** |
| `WHATSAPP_SHOW_BROWSER` | `true` shows the WhatsApp Web window (PC debugging) |
| `EXCLUDE_EMPLOYEES` | Comma list of Callyzer names to hide |
| `EMPLOYEE_ALIASES` | `Old Name=New Name;...` to combine phones whose names differ beyond a trailing number |
| `HASH_SALT` | Any long random string (in-memory hashing of phone numbers) |
| `DATA_DIR` | `data`: WhatsApp session + `state.json`. Must persist (a volume on a cloud host) |

## Code map

```
src/service.ts          Always-on process: WhatsApp session, 30s schedule tick, status page (basic auth, same-origin POST check)
src/whatsapp/web.ts     whatsapp-web.js wrapper: QR, reconnect, group lookup by name, send image+caption
src/schedule.ts         dueSlots() IST slot/grace logic; StateStore (data/state.json): sent-log, history, runtime settings
src/report/build.ts     Fetch Callyzer → apply aliases/exclusions → compute → render PNG + caption
src/report/metrics.ts   All metric rules, person merging (canonicalName), team de-duplication, footnotes
src/report/template.ts  Report HTML (rendered at 800px CSS width, 2x scale → 1600px PNG)
src/report/render.ts    PNG rendering: PuppeteerPageRenderer (reuses WhatsApp's Chromium) or Playwright fallback
src/report/sample.ts    Deterministic fake data in Callyzer response shapes
src/callyzer/client.ts  Callyzer v2.3 client: 2.1s request spacing, retries (429 Retry-After / 5xx / network), stream + paged fallback
src/run-report.ts       CLI: build the image only
dev/mock-callyzer.ts    Mock Callyzer server (documented shapes) for dev/tests
Dockerfile, railway.json  Container deploy (Railway or any Docker host); volume at /data
```

## Callyzer API usage (v2.3 docs: developers.callyzer.co/v2.3)

- Auth: `Authorization: Bearer <token>`. Rate limit: **1 request / 2 s** (enforced client-side).
- `GET /employee/get`: JSON body `{page_no, page_size}` (per Callyzer's Postman collection; that's why `src/lib/http.ts` exists, since fetch can't send a GET body). Gives all phones, including zero-activity employees.
- `POST /call-log/employee-summary`: currently used only as a **cross-check** (warnings in logs if counts differ). Working/idle hours are no longer shown.
- `POST /call-log/history/stream`: NDJSON with an END marker. Falls back to paged `POST /call-log/history` if incomplete.
- Every call-log request needs `call_method` + `call_mode`. Default `PhoneCall` + `Voice`; `CALLYZER_INCLUDE_WHATSAPP_CALLS=true` adds WhatsApp voice/video.
- Time window: `call_from` = 00:00 IST today, `call_to` = the moment the report is built (scheduled and manual).

## Report format (as agreed with the user)

- Title `Call Report · Tue 24 Nov 2026`, subtitle `Callyzer · Today so far, as of 4:00 PM IST`.
- **No summary cards.** No Working Hours / Idle Hours columns.
- Columns: Employee · Total Calls · Total Duration · Connected Calls (blue, with %) · Conn. Calls Duration · Conn. Call Avg. Duration · Unique Clients · Unique Conn. Calls. Final **Team** row.
- Durations **without seconds** (`2h 30m`, `43m`, `<1m`), **except** Conn. Call Avg. Duration, which keeps seconds (`1m 49s`).
- One row per person. Names are merged ignoring case, spacing and a trailing phone marker (`Varsha`, `Varsha 2`, `Varsha (2)`, `Varsha2`), and the row shows **"2 phones"** next to the name.
- Connected = incoming/outgoing call with duration **> 2 s** (Callyzer's definition). Team unique clients count each client once across the team (not a sum of rows).
- Zero-activity registered employees are shown greyed with `·`.
- No phone numbers anywhere (report, logs, state).

WhatsApp caption: `*Call Report · <date>*` / `As of <time> IST · N calls, N connected (N%), talk time Xh Ym`.

## Safety rules built in

- Schedule **OFF** and target **TEST** by default.
- Each scheduled slot is sent at most once (`data/state.json` → `sent`), even across restarts.
- No Callyzer key → only SAMPLE reports, only to the test group.
- Main-group button asks for confirmation; switching scheduled target to MAIN asks for confirmation.
- The user asked: **don't send anything to the main group until they say so.**

## Open items / next steps

1. **Callyzer key**: add it to `.env`, restart, click **Preview image (no send)**, and compare totals with the Callyzer dashboard. Watch logs for `Cross-check:` warnings. If you get a 404, set `CALLYZER_BASE_URL=https://api1.callyzer.co/v2.1`.
2. **"As of" time**: now always the actual send time (Asia/Kolkata), for scheduled and manual sends.
3. **Main group**: set `WHATSAPP_LIVE_GROUP`, test with real data in the test group first, then on the status page: Switch to MAIN group → Turn schedule ON (only when the user says so).
4. **Reset test slots**: if `REPORT_SLOTS` was set to 3-minute test times, set it back to `14:00,16:00,18:00,20:00`.
5. **Change `ADMIN_PASSWORD`** (the original one was posted in chat).
6. **Move off the PC**: Railway (trial, then ~$5/month), Oracle Cloud Always Free (needs a card for verification) or an office server. `docker build` + volume at `/data` + same env vars + one new QR scan. Railway steps are in README. The Docker image has **not** been test-built yet.
7. **Move the repo to the office GitHub**: GitHub → Settings → Transfer ownership (it moves, it doesn't copy), then give the Claude GitHub App access to the office org if Claude should keep working on it.

## Known risks / gotchas

- **whatsapp-web.js is unofficial**: WhatsApp may block +91 90081 28705. Keep volume low (4 messages/day to internal groups).
- WhatsApp Web can take 1–3 min to load; `authTimeoutMs` is 180 s. On failure a screenshot is saved to `data/whatsapp-debug.png` (linked on the status page).
- "The browser is already running for …\session": a leftover Chromium. Stop the bot, then
  `Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*ms-playwright*" } | Stop-Process -Force`
- Windows PowerShell blocks `npm.ps1` → use `npm.cmd`, or `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
- `npm audit` flags transitive puppeteer download tooling (basic-ftp, extract-zip). Not used at runtime (`.puppeteerrc.cjs` skips the download).
- If the PC sleeps or is off at a slot, one up-to-date report is sent when it's back, before the next slot (or midnight). Older missed slots are skipped (the newer report contains their data). Turning the schedule ON waits for the next slot instead of sending immediately.
- Group lookup is by **exact name** (case-insensitive). Renaming the group breaks it until `.env` is updated; the status page lists the number's group names.
