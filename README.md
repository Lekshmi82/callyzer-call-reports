# callyzer-call-reports

Automated Callyzer call report (image in the reference layout) for WhatsApp delivery at 2, 4, 6 and 8 PM IST.

**Status: work in progress.** Built and tested so far:
- Callyzer v2.3 API client (`src/callyzer/client.ts`): rate limiting, retries, NDJSON stream with paged fallback
- Metrics engine (`src/report/metrics.ts`): phones combined per person, team-level unique clients de-duplicated
- Report image renderer (`src/report/template.ts`, `src/report/render.ts`)
- WATI WhatsApp client (`src/whatsapp/wati.ts`)
- Mock servers (`dev/`) and tests (`npm test`)

Not built yet: scheduler/pipeline, admin dashboard, deployment.
