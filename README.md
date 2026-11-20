# callyzer-call-reports

Fetches today's call data from **Callyzer**, builds the call report image (cards, employee table, Team row) and sends it on **WhatsApp** through the official WhatsApp Cloud API. A Claude scheduled task runs it at **2, 4, 6 and 8 PM IST** every day.

## Commands

```bash
npm ci
npm run report                      # build the image only (saved in ./out)
npm run report -- --sample          # fake data, watermarked, no Callyzer needed
npm run report -- --target test     # send to WHATSAPP_TEST_TARGETS
npm run report -- --target live     # send to WHATSAPP_LIVE_TARGETS
npm run report -- --at 14:00        # data up to 2:00 PM IST today
npm test                            # unit + end-to-end tests (uses mock APIs)
```

Each run is cumulative for the day: 00:00 IST up to the run time (or `--at`).

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

## WhatsApp setup (official Cloud API)

1. In Meta Business Manager, add the sending number to a WhatsApp Business Account on the **Cloud API** and note its **Phone number ID**.
2. Create a **system user access token** with `whatsapp_business_messaging` permission.
3. Create and get approved a **Utility** template named `call_report`, language `en`:
   - Header: **Image**
   - Body: `Call report for {{1}}, as of {{2}} IST. {{3}}`
4. Put targets in `WHATSAPP_TEST_TARGETS` / `WHATSAPP_LIVE_TARGETS`.

**Groups:** the Cloud API can post only into groups created through Meta's Groups API (needs an Official Business Account, max 8 participants, and the number can't be a WhatsApp Business app number). For larger teams, list each member's number as a target. Groups use `group:<GROUP_ID>`.

## Running it automatically (Claude scheduled task)

Store `CALLYZER_API_TOKEN` and `WHATSAPP_TOKEN` as **network secrets** in the Claude cloud environment (hosts `api1.callyzer.co` and `graph.facebook.com`). The proxy adds the auth header, so the variables themselves can hold a placeholder. Put the other variables in the environment's variables. The scheduled task runs `npm ci && npm run report -- --target live` at `CRON_TZ=Asia/Kolkata 0 14,16,18,20 * * *`.

## Troubleshooting

| Message | Fix |
|---|---|
| `Callyzer rejected the API token (401)` | Generate a new token in Callyzer; the API add-on must be active |
| `Callyzer refused the request (403)` | Callyzer subscription/API add-on expired |
| `Callyzer endpoint not found (404)` | Check `CALLYZER_BASE_URL` (docs: `/api/v2.3`; Postman collection uses `/v2.1`) |
| `WhatsApp API 400 ... template` | Template name/language wrong or not approved; header must be Image with 3 body variables |
| `WhatsApp API 401` | Token expired; use a system user token |
| Cross-check warnings in logs | Our count differs from Callyzer's own summary (usually a phone syncing mid-run); the next run self-corrects |
