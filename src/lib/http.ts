import http from "node:http";
import https from "node:https";

/**
 * Small HTTP client on node:http(s). We need it instead of fetch because Callyzer's
 * documented `GET /employee/get` takes a JSON body, which fetch refuses to send.
 */
export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  json?: unknown;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export class HttpError extends Error {
  constructor(
    message: string,
    /** "connect" = request never reached the server (safe to retry a write); "timeout"/"network" = outcome unknown. */
    public readonly phase: "connect" | "timeout" | "network",
    public readonly code?: string,
  ) {
    super(message);
  }
}

const CONNECT_ERRORS = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "CERT_HAS_EXPIRED"]);

function start(req: HttpRequest, onResponse: (res: http.IncomingMessage) => void, onError: (e: HttpError) => void) {
  const url = new URL(req.url);
  const body = req.json === undefined ? undefined : Buffer.from(JSON.stringify(req.json));
  const headers: Record<string, string> = { Accept: "application/json", ...req.headers };
  if (body) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(body.length);
  }
  const lib = url.protocol === "https:" ? https : http;
  let connected = false;
  const r = lib.request(url, { method: req.method, headers }, onResponse);
  r.on("socket", (s) => {
    // Reused keep-alive sockets are already connected; only fresh sockets need a listener.
    if ((s as { connecting?: boolean }).connecting === false) {
      connected = true;
      return;
    }
    s.once("connect", () => (connected = true));
  });
  r.setTimeout(req.timeoutMs ?? 30_000, () => {
    r.destroy(new HttpError(`Request timed out after ${req.timeoutMs ?? 30_000}ms`, connected ? "timeout" : "connect", "ETIMEDOUT"));
  });
  r.on("error", (err: NodeJS.ErrnoException) => {
    if (err instanceof HttpError) return onError(err);
    const phase = !connected || (err.code && CONNECT_ERRORS.has(err.code)) ? "connect" : "network";
    onError(new HttpError(`${err.code ?? "ERROR"}: ${err.message}`, phase, err.code));
  });
  if (body) r.write(body);
  r.end();
  return r;
}

export function request(req: HttpRequest): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    start(
      req,
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (e) => reject(new HttpError(e.message, "network")));
      },
      reject,
    );
  });
}

/**
 * Streams a newline-delimited JSON response. Non-2xx responses resolve with the full body
 * so callers can handle errors uniformly.
 */
export function requestNdjson(
  req: HttpRequest,
  onLine: (obj: unknown) => void,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; errorBody?: string }> {
  return new Promise((resolve, reject) => {
    start(
      req,
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status, headers: res.headers, errorBody: Buffer.concat(chunks).toString("utf8") }));
          return;
        }
        let buf = "";
        let failed = false;
        const flush = (line: string) => {
          const t = line.trim();
          if (!t || failed) return;
          try {
            onLine(JSON.parse(t));
          } catch (e) {
            failed = true;
            res.destroy();
            reject(new HttpError(`Malformed NDJSON line: ${(e as Error).message}`, "network"));
          }
        };
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            flush(buf.slice(0, idx));
            buf = buf.slice(idx + 1);
          }
        });
        res.on("end", () => {
          flush(buf);
          if (!failed) resolve({ status, headers: res.headers });
        });
        res.on("error", (e) => reject(new HttpError(e.message, "network")));
      },
      reject,
    );
  });
}

export function retryAfterMs(headers: http.IncomingHttpHeaders, fallbackMs: number): number {
  const v = headers["retry-after"];
  const s = Array.isArray(v) ? v[0] : v;
  if (!s) return fallbackMs;
  const secs = Number(s);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs * 1000, 500), 120_000);
  const date = Date.parse(s);
  return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), 500), 120_000) : fallbackMs;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
