import pino from "pino";

/**
 * Structured JSON logger. Redaction is a safety net: code must never pass
 * secrets or phone numbers to the logger in the first place.
 */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.token",
  "*.apiToken",
  "*.api_token",
  "*.password",
  "*.authorization",
  "*.Authorization",
  "headers.authorization",
  "headers.Authorization",
];

export function createLogger(level: string) {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: { service: "callyzer-call-reports" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = pino.Logger;
