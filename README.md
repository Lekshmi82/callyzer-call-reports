# callyzer-call-reports

Fetches today's call data from **Callyzer** and builds the call report image (cards, employee table, Team row), to be posted into a WhatsApp group at **2, 4, 6 and 8 PM IST**.

## How it works

An always-on service (`npm start`) keeps a WhatsApp Web login (whatsapp-web.js) for the sending number and posts the report image into a WhatsApp group at **2, 4, 6 and 8 PM IST**. A password-protected status page shows the QR login, lets you send a test report, and turns the schedule on/off and switches TEST ↔ MAIN group.

**Safety defaults:** schedule **OFF**, target **TEST group**. Each scheduled slot is sent at most once (sent-log in `DATA_DIR/state.json`); a failed slot is retried every 3 min for 45 min.

> whatsapp-web.js is unofficial WhatsApp automation. WhatsApp may block the sending number. Use a dedicated number.

## Run on a PC (Windows / Mac)

1. Install **Node.js 22 LTS** (nodejs.org) and **Git** (git-scm.com).
2. In a terminal:
   ```bash
   git clone https://github.com/Lekshmi82/callyzer-call-reports
   cd callyzer-call-reports
   npm ci
   npx playwright install chromium
   ```
3. Copy `.env.example` to `.env` and fill in `CALLYZER_API_TOKEN`, `ADMIN_PASSWORD`, `WHATSAPP_TEST_GROUP`, `WHATSAPP_LIVE_GROUP`, `HASH_SALT`.
4. `npm start`, then open **http://localhost:3000** (user `admin`, your `ADMIN_PASSWORD`) and scan the QR code.

The PC must be on and awake at the report times (a missed slot is retried for 45 minutes once it is back). Moving to a cloud host later only needs the same `.env` values and one new QR scan.

## Deploy on Railway

1. railway.app → **New Project → Deploy from GitHub repo** → pick this repo (it builds the `Dockerfile`).
2. Service → **Settings → Volumes → Add volume**, mount path **`/data`** (keeps the WhatsApp login across restarts).
3. Service → **Variables**: `CALLYZER_API_TOKEN`, `ADMIN_PASSWORD`, `WHATSAPP_TEST_GROUP`, `WHATSAPP_LIVE_GROUP`, `HASH_SALT` (any long random text).
4. Service → **Settings → Networking → Generate Domain**, open it, log in as `admin` / your `ADMIN_PASSWORD`.
5. On the sending phone: WhatsApp → **Linked devices → Link a device** → scan the QR on the page.
6. **Send report to TEST group** → check it → **Switch to MAIN group** → **Turn schedule ON**.

The same Dockerfile runs on any always-on host (Oracle Cloud Always Free VM, office PC, VPS): `docker build -t callyzer-bot . && docker run -d --restart unless-stopped -p 3000:3000 -v callyzer-data:/data --env-file .env callyzer-bot`.

## Commands

```bash
npm ci
npm start                           # the always-on service + status page (http://localhost:3000)
npm run report                      # build today's image into ./out — sends nothing
npm run report -- --sample          # fake data, watermarked, no Callyzer needed
npm test                            # unit + end-to-end tests (mock Callyzer)
```

## How the numbers are calculated

| Metric | Rule |
|---|---|
| Total Calls | All calls (incoming, outgoing, missed, rejected) |
| Connected Calls | Incoming/outgoing calls longer than 2 s (Callyzer's definition); % = connected ÷ total |
| Total Duration | Duration of incoming + outgoing calls |
| Conn. Calls Duration / Talk Time | Duration of connected calls |
| Conn. Call Avg. Duration | Connected duration ÷ connected calls |
| Working / Idle Hours | Callyzer's per-phone values, added across a person's phones |
| Unique Clients | Distinct client numbers, counted once per person; Team row counts each client once across the team |
| Unique Conn. Calls | Distinct clients with at least one connected call |

People with several phones are combined by their Callyzer name (use `EMPLOYEE_ALIASES="Old=New"` if names differ). Registered employees with no calls are shown greyed out. Phone numbers are never shown, stored or logged.

## Callyzer API used (v2.3)

`GET /employee/get`, `POST /call-log/employee-summary`, `POST /call-log/history/stream` (falls back to paged `POST /call-log/history`). Bearer token, max 1 request per 2 s (handled), retries on 429/5xx.

## Troubleshooting

| Message | Fix |
|---|---|
| `Callyzer rejected the API token (401)` | Generate a new token in Callyzer; the API add-on must be active |
| `Callyzer refused the request (403)` | Callyzer subscription/API add-on expired |
| `Callyzer endpoint not found (404)` | Check `CALLYZER_BASE_URL` (docs: `/api/v2.3`; Postman collection uses `/v2.1`) |
| Cross-check warnings in logs | Our count differs from Callyzer's own summary (usually a phone syncing mid-run); the next run self-corrects |
