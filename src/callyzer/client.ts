import { HttpError, request, requestNdjson, retryAfterMs, sleep } from "../lib/http.js";
import type { Logger } from "../logger.js";

/**
 * Client for the Callyzer API v2.3 (https://developers.callyzer.co/v2.3/).
 * - Auth: Authorization: Bearer <token>
 * - Rate limit: 1 request / 2 seconds (we space requests 2.1s apart process-wide and honour 429 Retry-After)
 * - Time filters: UNIX seconds (UTC); every call-log request needs call_method + call_mode
 */

export type CallMethod = "PhoneCall" | "WhatsAppCall";
export type CallMode = "Voice" | "Video";
export interface CallKind {
  call_method: CallMethod;
  call_mode: CallMode;
}

export interface CallRecord {
  id: string;
  empName: string;
  empCode: string | null;
  empCountryCode: string;
  empNumber: string;
  clientCountryCode: string;
  clientNumber: string;
  duration: number;
  callType: string; // Incoming | Outgoing | Missed | Rejected
  callDate: string;
  callTime: string;
}

export interface EmployeeSummaryRow {
  empName: string;
  empCode: string | null;
  empCountryCode: string;
  empNumber: string;
  totalCalls: number;
  totalDuration: number;
  totalConnectedCalls: number;
  totalUniqueClients: number;
  workingHms: string;
  idleHms: string;
}

export interface Employee {
  empName: string;
  empCode: string | null;
  empCountryCode: string;
  empNumber: string;
  lastSyncReqAt: string | null;
  lastCallAt: string | null;
  isAppUninstalled: boolean | null;
}

export type CallyzerErrorKind = "auth" | "forbidden" | "validation" | "rate_limited" | "server" | "network" | "bad_response";

export class CallyzerError extends Error {
  constructor(
    public readonly kind: CallyzerErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "server" || this.kind === "network" || this.kind === "bad_response";
  }
}

/** Process-wide spacing between Callyzer requests (the limit is per account, not per client object). */
class Spacer {
  private next = 0;
  constructor(private readonly gapMs: number) {}
  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.gapMs;
    if (at > now) await sleep(at - now);
  }
  pushBack(ms: number) {
    this.next = Math.max(this.next, Date.now() + ms);
  }
}
const sharedSpacer = new Spacer(2_100);

export interface CallyzerClientOptions {
  baseUrl: string;
  token: string;
  log: Logger;
  maxRetries?: number;
  timeoutMs?: number;
  streamTimeoutMs?: number;
  /** Test hook: override request spacing. */
  spacingMs?: number;
}

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};

export class CallyzerClient {
  private readonly base: string;
  private readonly spacer: Spacer;
  private readonly maxRetries: number;

  constructor(private readonly opts: CallyzerClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.spacer = opts.spacingMs !== undefined ? new Spacer(opts.spacingMs) : sharedSpacer;
    this.maxRetries = opts.maxRetries ?? 4;
  }

  private headers() {
    return { Authorization: `Bearer ${this.opts.token}` };
  }

  /** Maps an HTTP status + body to a typed error. Callyzer errors look like {"result":null,"message":"..."}. */
  private toError(status: number, body: string): CallyzerError {
    let message = "";
    try {
      message = s((JSON.parse(body) as { message?: unknown }).message);
    } catch {
      message = body.slice(0, 200);
    }
    if (status === 401) return new CallyzerError("auth", "Callyzer rejected the API token (401). Generate a new token in Callyzer and update it in Settings.", status);
    if (status === 403) return new CallyzerError("forbidden", `Callyzer refused the request (403): ${message || "subscription may have expired"}`, status);
    if (status === 429) return new CallyzerError("rate_limited", "Callyzer rate limit hit (429)", status);
    if (status === 400) return new CallyzerError("validation", `Callyzer rejected the request (400): ${message}`, status);
    if (status === 404) return new CallyzerError("validation", `Callyzer endpoint not found (404). Check the API base URL in Settings.`, status);
    if (status >= 500) return new CallyzerError("server", `Callyzer server error (${status})`, status);
    return new CallyzerError("bad_response", `Unexpected Callyzer response (${status}): ${message}`, status);
  }

  /** Executes a JSON request with spacing and retries (all Callyzer calls we make are reads, so retrying is safe). */
  private async call(method: "GET" | "POST", path: string, body: unknown): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      await this.spacer.wait();
      let err: CallyzerError;
      let backoff = Math.min(2_000 * 2 ** attempt, 30_000) + Math.floor(Math.random() * 500);
      try {
        const res = await request({ method, url: this.base + path, headers: this.headers(), json: body, timeoutMs: this.opts.timeoutMs ?? 30_000 });
        if (res.status >= 200 && res.status < 300) {
          try {
            return JSON.parse(res.body);
          } catch {
            err = new CallyzerError("bad_response", "Callyzer returned non-JSON content", res.status);
          }
        } else {
          err = this.toError(res.status, res.body);
          if (res.status === 429) {
            backoff = retryAfterMs(res.headers, backoff);
            this.spacer.pushBack(backoff);
          }
        }
      } catch (e) {
        err = new CallyzerError("network", e instanceof HttpError ? e.message : String(e));
      }
      // "No employees meet the search criteria" is how Callyzer reports an empty result.
      if (err.kind === "validation" && /no employees meet the search criteria/i.test(err.message)) return { result: { employees: [] } };
      if (!err.retryable || attempt >= this.maxRetries) throw err;
      attempt++;
      this.opts.log.warn({ path, attempt, kind: err.kind, status: err.status, backoffMs: backoff }, "callyzer request failed; retrying");
      await sleep(backoff);
    }
  }

  /** GET /employee/get — all registered employees (paginated, JSON body per Callyzer's Postman collection). */
  async listEmployees(): Promise<Employee[]> {
    const out: Employee[] = [];
    const pageSize = 100;
    for (let page = 1; page <= 100; page++) {
      const json = (await this.call("GET", "/employee/get", { page_no: page, page_size: pageSize })) as Record<string, unknown>;
      const rows = extractArray(json, ["employees"]);
      for (const r of rows) {
        const dev = (r.device_preference ?? {}) as Record<string, unknown>;
        out.push({
          empName: s(r.emp_name).trim(),
          empCode: r.emp_code == null ? null : s(r.emp_code),
          empCountryCode: s(r.emp_country_code),
          empNumber: s(r.emp_number),
          lastSyncReqAt: r.last_sync_req_at == null ? null : s(r.last_sync_req_at),
          lastCallAt: r.last_call_at == null ? null : s(r.last_call_at),
          isAppUninstalled: typeof dev.is_app_uninstalled === "boolean" ? dev.is_app_uninstalled : null,
        });
      }
      const total = n(json.total_records ?? (json.result as Record<string, unknown> | undefined)?.total_records);
      if (rows.length < pageSize || (total > 0 && out.length >= total)) break;
    }
    return out;
  }

  /** POST /call-log/employee-summary — one row per registered phone, includes working + idle time. */
  async employeeSummary(from: Date, to: Date, kind: CallKind): Promise<EmployeeSummaryRow[]> {
    const out: EmployeeSummaryRow[] = [];
    const pageSize = 100;
    for (let page = 1; page <= 100; page++) {
      const json = (await this.call("POST", "/call-log/employee-summary", {
        call_from: unix(from),
        call_to: unix(to),
        ...kind,
        page_no: page,
        page_size: pageSize,
      })) as Record<string, unknown>;
      const rows = extractArray(json, ["employees"]);
      for (const r of rows) {
        out.push({
          empName: s(r.emp_name).trim(),
          empCode: r.emp_code == null ? null : s(r.emp_code),
          empCountryCode: s(r.emp_country_code),
          empNumber: s(r.emp_number),
          totalCalls: n(r.total_calls),
          totalDuration: n(r.total_duration),
          totalConnectedCalls: n(r.total_connected_calls),
          totalUniqueClients: n(r.total_unique_clients),
          workingHms: s(r.total_working_hours),
          idleHms: s(r.total_idle_time),
        });
      }
      if (rows.length < pageSize) break;
    }
    return out;
  }

  /**
   * All call records in [from, to). Uses POST /call-log/history/stream (NDJSON, no pagination) and falls back
   * to the paginated POST /call-log/history if the stream fails or ends without its END marker.
   */
  async callHistory(from: Date, to: Date, kind: CallKind): Promise<{ records: CallRecord[]; via: "stream" | "paged" }> {
    try {
      return { records: await this.callHistoryStream(from, to, kind), via: "stream" };
    } catch (e) {
      if (e instanceof CallyzerError && (e.kind === "auth" || e.kind === "forbidden")) throw e;
      this.opts.log.warn({ err: (e as Error).message }, "callyzer history stream failed; falling back to paged history");
      return { records: await this.callHistoryPaged(from, to, kind), via: "paged" };
    }
  }

  private async callHistoryStream(from: Date, to: Date, kind: CallKind): Promise<CallRecord[]> {
    await this.spacer.wait();
    const records: CallRecord[] = [];
    let endTotal: number | null = null;
    let streamError: string | null = null;
    const res = await requestNdjson(
      {
        method: "POST",
        url: this.base + "/call-log/history/stream",
        headers: { ...this.headers(), Accept: "application/x-ndjson" },
        json: { call_from: unix(from), call_to: unix(to), ...kind },
        timeoutMs: this.opts.streamTimeoutMs ?? 120_000,
      },
      (line) => {
        const o = line as Record<string, unknown>;
        if (o.type === "END") {
          endTotal = n(o.total_records);
          return;
        }
        if (o.result && typeof o.result === "object") records.push(toRecord(o.result as Record<string, unknown>));
        else if (o.result === null && o.message) streamError = s(o.message);
      },
    ).catch((e) => {
      throw new CallyzerError("network", e instanceof Error ? e.message : String(e));
    });
    if (res.status < 200 || res.status >= 300) {
      const err = this.toError(res.status, res.errorBody ?? "");
      if (res.status === 429) this.spacer.pushBack(retryAfterMs(res.headers, 5_000));
      throw err;
    }
    if (streamError) throw new CallyzerError("bad_response", `Callyzer stream error: ${streamError}`);
    if (endTotal === null) throw new CallyzerError("bad_response", "Callyzer stream ended without END marker (incomplete)");
    if (endTotal !== records.length) {
      throw new CallyzerError("bad_response", `Callyzer stream count mismatch: END says ${endTotal}, received ${records.length}`);
    }
    return records;
  }

  private async callHistoryPaged(from: Date, to: Date, kind: CallKind): Promise<CallRecord[]> {
    const out: CallRecord[] = [];
    const pageSize = 100;
    let total = Infinity;
    for (let page = 1; page <= 2_000 && out.length < total; page++) {
      const json = (await this.call("POST", "/call-log/history", {
        call_from: unix(from),
        call_to: unix(to),
        ...kind,
        page_no: page,
        page_size: pageSize,
      })) as Record<string, unknown>;
      const rows = extractArray(json, ["records", "call_logs"]);
      out.push(...rows.map(toRecord));
      if (json.total_records !== undefined) total = n(json.total_records);
      if (rows.length < pageSize) break;
    }
    return out;
  }
}

function unix(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

function toRecord(r: Record<string, unknown>): CallRecord {
  return {
    id: s(r.id),
    empName: s(r.emp_name).trim(),
    empCode: r.emp_code == null ? null : s(r.emp_code),
    empCountryCode: s(r.emp_country_code),
    empNumber: s(r.emp_number),
    clientCountryCode: s(r.client_country_code),
    clientNumber: s(r.client_number),
    duration: n(r.duration),
    callType: s(r.call_type),
    callDate: s(r.call_date),
    callTime: s(r.call_time),
  };
}

/** Callyzer wraps lists as {result: [...]} or {result: {employees: [...]}}; accept both shapes. */
function extractArray(json: Record<string, unknown>, nestedKeys: string[]): Record<string, unknown>[] {
  const result = json.result;
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object") {
    for (const k of nestedKeys) {
      const v = (result as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
    return [];
  }
  if (result === null || result === undefined) return [];
  throw new CallyzerError("bad_response", "Unexpected Callyzer response shape");
}

export function callKinds(includeWhatsApp: boolean): CallKind[] {
  const kinds: CallKind[] = [{ call_method: "PhoneCall", call_mode: "Voice" }];
  if (includeWhatsApp) kinds.push({ call_method: "WhatsAppCall", call_mode: "Voice" }, { call_method: "WhatsAppCall", call_mode: "Video" });
  return kinds;
}
