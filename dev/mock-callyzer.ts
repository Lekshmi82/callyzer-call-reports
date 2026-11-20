/**
 * DEVELOPMENT ONLY: a mock of the Callyzer v2.3 endpoints we use, returning synthetic data in the
 * documented response shapes. Point Settings → Callyzer → Base URL at http://localhost:4010 to use it.
 *
 *   npm run mock:callyzer            (token: mock-callyzer-token)
 */
import http from "node:http";
import { pathToFileURL } from "node:url";
import { sampleDataset } from "../src/report/sample.js";
import { DateTime } from "luxon";

export interface MockCallyzerOptions {
  token?: string;
  /** Enforce the documented 1 request / 2 seconds limit with 429 + Retry-After. */
  enforceRateLimit?: boolean;
  /** Make the NDJSON stream end without its END marker, to exercise the paged fallback. */
  brokenStream?: boolean;
  /** Fail the first N requests with 503. */
  failFirst?: number;
}

export function createMockCallyzer(opts: MockCallyzerOptions = {}) {
  const token = opts.token ?? "mock-callyzer-token";
  let last = 0;
  let failures = opts.failFirst ?? 0;
  const stats = { requests: 0, rateLimited: 0, byPath: {} as Record<string, number> };

  const dataset = (fromSec: number, toSec: number) => {
    const from = new Date(fromSec * 1000);
    const to = new Date(toSec * 1000);
    // Day-anchored so successive calls in the same day are consistent.
    const dayStart = DateTime.fromJSDate(from).setZone("Asia/Kolkata").startOf("day").toJSDate();
    return sampleDataset(dayStart, to);
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      stats.requests++;
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname.replace(/^\/api\/v2\.3/, "");
      stats.byPath[path] = (stats.byPath[path] ?? 0) + 1;
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { result: null, message: "Unauthorized" });
      if (failures > 0) {
        failures--;
        return send(503, { result: null, message: "Service unavailable" });
      }
      const now = Date.now();
      if (opts.enforceRateLimit && now - last < 2_000) {
        stats.rateLimited++;
        return send(429, { result: null, message: "Too Many Requests" }, { "Retry-After": "2" });
      }
      last = now;
      let body: Record<string, unknown> = {};
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      } catch {
        return send(400, { result: null, message: "Invalid JSON" });
      }
      const pageNo = Number(body.page_no ?? 1);
      const pageSize = Number(body.page_size ?? 100);

      if (path === "/employee/get" && req.method === "GET") {
        const { employees } = dataset(Math.floor(now / 1000) - 60, Math.floor(now / 1000));
        const page = employees.slice((pageNo - 1) * pageSize, pageNo * pageSize);
        return send(200, {
          result: page.map((e) => ({
            emp_name: e.empName,
            emp_code: e.empCode,
            emp_country_code: e.empCountryCode,
            emp_number: e.empNumber,
            emp_tags: [],
            app_version: "1.3.16",
            last_sync_req_at: e.lastSyncReqAt,
            device_preference: { is_app_uninstalled: false, battery_percentage: 80 },
          })),
          message: "Success",
          total_records: employees.length,
          page_no: pageNo,
          page_size: pageSize,
        });
      }

      if (req.method !== "POST") return send(404, { result: null, message: "Not found" });
      const callFrom = Number(body.call_from);
      const callTo = Number(body.call_to);
      if (!callFrom || !callTo) return send(400, { result: null, message: "Either 'call_from' and 'call_to' or 'synced_from' and 'synced_to' are mandatory." });
      if (body.call_method !== "PhoneCall" && body.call_method !== "WhatsAppCall")
        return send(400, { result: null, message: "Invalid call_method. Valid call methods are PhoneCall or WhatsAppCall." });
      if (body.call_mode !== "Voice" && body.call_mode !== "Video")
        return send(400, { result: null, message: "Invalid call_mode. Valid call modes are Voice or Video." });
      // Synthetic data only has phone voice calls.
      const ds = body.call_method === "PhoneCall" && body.call_mode === "Voice" ? dataset(callFrom, callTo) : { employees: [], records: [], summaries: [] };

      if (path === "/call-log/employee-summary") {
        const rows = ds.summaries.slice((pageNo - 1) * pageSize, pageNo * pageSize);
        if (rows.length === 0 && pageNo === 1) return send(400, { result: null, message: "No employees meet the search criteria." });
        return send(200, {
          result: {
            employees: rows.map((r) => ({
              emp_name: r.empName,
              emp_code: r.empCode,
              emp_country_code: r.empCountryCode,
              emp_number: r.empNumber,
              emp_tags: [],
              total_calls: r.totalCalls,
              total_duration: r.totalDuration,
              total_connected_calls: r.totalConnectedCalls,
              total_unique_clients: r.totalUniqueClients,
              total_working_hours: r.workingHms,
              total_idle_time: r.idleHms,
            })),
          },
          message: "Success",
        });
      }

      const toWire = (r: (typeof ds.records)[number]) => ({
        id: r.id,
        emp_name: r.empName,
        emp_code: r.empCode,
        emp_country_code: r.empCountryCode,
        emp_number: r.empNumber,
        emp_tags: [""],
        client_name: "",
        client_country_code: r.clientCountryCode,
        client_number: r.clientNumber,
        duration: r.duration,
        call_type: r.callType,
        call_date: r.callDate,
        call_time: r.callTime,
        call_method: body.call_method,
        call_mode: body.call_mode,
      });

      if (path === "/call-log/history/stream") {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        const lines = ds.records.map((r) => JSON.stringify({ result: toWire(r) }));
        if (opts.brokenStream) lines.length = Math.floor(lines.length / 2);
        else lines.push(JSON.stringify({ type: "END", total_records: ds.records.length, message: "Success" }));
        res.end(lines.join("\n") + "\n");
        return;
      }

      if (path === "/call-log/history") {
        const rows = ds.records.slice((pageNo - 1) * pageSize, pageNo * pageSize);
        return send(200, { result: rows.map(toWire), message: "Success", total_records: ds.records.length, page_no: pageNo, page_size: pageSize });
      }

      return send(404, { result: null, message: "Not found" });
    });
  });
  return { server, stats };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? 4010);
  const { server } = createMockCallyzer({ enforceRateLimit: process.env.MOCK_RATE_LIMIT === "1" });
  server.listen(port, () => console.log(`Mock Callyzer listening on http://localhost:${port} (token: mock-callyzer-token)`));
}
