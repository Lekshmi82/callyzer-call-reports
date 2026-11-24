# callyzer-call-reports

Fetches today's call data from **Callyzer** and builds the call report image (cards, employee table, Team row), to be posted into a WhatsApp group at **2, 4, 6 and 8 PM IST**.

## Status

- Done and tested: Callyzer API client, metrics, report image (`npm run report` builds the PNG, sends nothing).
- In progress: always-on WhatsApp group sender (whatsapp-web.js) with the 2/4/6/8 PM IST schedule. **Sending is off until explicitly enabled.**

## Commands

```bash
npm ci
npm run report                      # build today's image (00:00 IST → now) into ./out — sends nothing
npm run report -- --at 14:00        # data up to 2:00 PM IST today
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
