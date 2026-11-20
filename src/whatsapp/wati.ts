import { HttpError, request, retryAfterMs } from "../lib/http.js";

/**
 * WATI API (https://docs.wati.io), V3 routes:
 *  - GET  {host}/api/ext/v3/messageTemplates          list templates (name, status, custom_params, header link)
 *  - POST {host}/api/ext/v3/messageTemplates/send     send an approved template to 1–10,000 recipients
 * Auth: Authorization: Bearer <token>. WATI's public API has no endpoint to post into WhatsApp groups,
 * so the report goes to each team member individually from the business number.
 *
 * Per WATI's guidance, a timeout/5xx/connection loss on a send leaves the outcome UNKNOWN and must not be
 * blindly retried; only clear "not accepted" outcomes (429, connection never established) are retried.
 */

export interface WatiTemplate {
  name: string;
  status: string;
  category: string;
  headerType: string | null;
  headerLink: string | null;
  params: string[];
  body: string;
}

export interface SendRecipient {
  target: string;
  localMessageId: string;
  customParams: { name: string; value: string }[];
}

export type RecipientOutcome =
  | { localMessageId: string; status: "accepted"; broadcastId: string }
  | { localMessageId: string; status: "failed"; error: string }
  | { localMessageId: string; status: "unknown"; error: string };

export type SendResult =
  | { kind: "completed"; outcomes: RecipientOutcome[] }
  /** Nothing was accepted; safe to try again after retryAfterMs. */
  | { kind: "retry"; error: string; retryAfterMs: number }
  /** Request rejected as a whole (bad template, auth, plan...): fix configuration, don't retry automatically. */
  | { kind: "rejected"; error: string };

export class WatiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

export class WatiClient {
  private readonly host: string;
  constructor(
    host: string,
    private readonly token: string,
    private readonly timeoutMs = 30_000,
  ) {
    this.host = host.replace(/\/+$/, "").replace(/\/api.*$/, "");
  }

  private headers() {
    return { Authorization: `Bearer ${this.token}` };
  }

  private describe(status: number, body: string): string {
    let msg = body.slice(0, 300);
    try {
      const j = JSON.parse(body) as Record<string, unknown>;
      msg = str(j.message ?? j.error ?? j.info ?? msg);
    } catch {
      /* plain-text error */
    }
    if (status === 401) return `WATI rejected the API token (401). Check token, region/host and workspace. ${msg}`.trim();
    if (status === 403) return `WATI refused the request (403): check token permissions, plan and channel access. ${msg}`.trim();
    if (status === 404 || status === 405) return `WATI endpoint not found (${status}). Check the API host. ${msg}`.trim();
    return `WATI error ${status}: ${msg}`;
  }

  async listTemplates(): Promise<WatiTemplate[]> {
    const out: WatiTemplate[] = [];
    for (let page = 1; page <= 20; page++) {
      let res;
      try {
        res = await request({
          method: "GET",
          url: `${this.host}/api/ext/v3/messageTemplates?page_number=${page}&page_size=100`,
          headers: this.headers(),
          timeoutMs: this.timeoutMs,
        });
      } catch (e) {
        throw new WatiError(`Cannot reach WATI: ${(e as Error).message}`);
      }
      if (res.status < 200 || res.status >= 300) throw new WatiError(this.describe(res.status, res.body), res.status);
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(res.body);
      } catch {
        throw new WatiError("WATI returned non-JSON content");
      }
      const templates = Array.isArray(json.templates) ? (json.templates as Record<string, unknown>[]) : [];
      for (const t of templates) {
        const header = (t.header ?? null) as Record<string, unknown> | null;
        const params = Array.isArray(t.custom_params)
          ? (t.custom_params as Record<string, unknown>[]).map((p) => str(p.param_name ?? p.name)).filter(Boolean)
          : [];
        out.push({
          name: str(t.name ?? t.element_name),
          status: str(t.status),
          category: str(t.category),
          headerType: header ? str(header.type) || null : null,
          headerLink: header ? str(header.link) || null : null,
          params,
          body: str(t.body ?? t.body_original),
        });
      }
      const total = Number(json.total ?? 0);
      if (templates.length < 100 || out.length >= total) break;
    }
    return out;
  }

  async sendTemplate(input: { templateName: string; broadcastName: string; channel?: string; recipients: SendRecipient[] }): Promise<SendResult> {
    const payload: Record<string, unknown> = {
      template_name: input.templateName,
      broadcast_name: input.broadcastName,
      recipients: input.recipients.map((r) => ({
        target: r.target,
        local_message_id: r.localMessageId,
        custom_params: r.customParams,
      })),
    };
    if (input.channel) payload.channel = input.channel;

    let res;
    try {
      res = await request({ method: "POST", url: `${this.host}/api/ext/v3/messageTemplates/send`, headers: this.headers(), json: payload, timeoutMs: this.timeoutMs });
    } catch (e) {
      const err = e as HttpError;
      if (err instanceof HttpError && err.phase === "connect") return { kind: "retry", error: `Could not connect to WATI: ${err.message}`, retryAfterMs: 60_000 };
      return this.allUnknown(input.recipients, `No response from WATI (${err.message}); delivery outcome unknown`);
    }

    if (res.status === 429) return { kind: "retry", error: this.describe(429, res.body), retryAfterMs: retryAfterMs(res.headers, 60_000) };
    if (res.status >= 500) return this.allUnknown(input.recipients, `${this.describe(res.status, res.body)}; delivery outcome unknown`);
    if (res.status < 200 || res.status >= 300) return { kind: "rejected", error: this.describe(res.status, res.body) };

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(res.body);
    } catch {
      return this.allUnknown(input.recipients, "WATI returned non-JSON content; delivery outcome unknown");
    }
    if (json.success !== true) return { kind: "rejected", error: `WATI did not accept the send: ${str(json.error ?? json.message) || "no reason given"}` };

    const broadcastId = str(json.broadcast_id);
    const returned = new Map<string, Record<string, unknown>>();
    for (const r of Array.isArray(json.recipients) ? (json.recipients as Record<string, unknown>[]) : []) {
      returned.set(str(r.local_message_id), r);
    }
    const outcomes: RecipientOutcome[] = input.recipients.map((r) => {
      const got = returned.get(r.localMessageId);
      if (!got) return { localMessageId: r.localMessageId, status: "unknown", error: "Recipient missing from WATI response (unresolved)" };
      const errors = got.errors;
      if (Array.isArray(errors) && errors.length > 0) {
        return { localMessageId: r.localMessageId, status: "failed", error: errors.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("; ").slice(0, 500) };
      }
      return { localMessageId: r.localMessageId, status: "accepted", broadcastId };
    });
    return { kind: "completed", outcomes };
  }

  private allUnknown(recipients: SendRecipient[], error: string): SendResult {
    return { kind: "completed", outcomes: recipients.map((r) => ({ localMessageId: r.localMessageId, status: "unknown", error })) };
  }
}

/** Maps a WATI webhook eventType to our delivery status (null = not a status event we track). */
export function webhookStatus(eventType: string): "sent" | "delivered" | "read" | "failed" | null {
  const t = eventType.toLowerCase();
  if (t.startsWith("templatemessagefailed") || t.startsWith("sessionmessagefailed")) return "failed";
  if (t.startsWith("sentmessageread")) return "read";
  if (t.startsWith("sentmessagedelivered")) return "delivered";
  if (t.startsWith("templatemessagesent")) return "sent";
  return null;
}

const RANK: Record<string, number> = { pending: 0, sending: 1, unknown: 1, accepted: 2, sent: 3, delivered: 4, read: 5, failed: 2 };

/** Status transitions never go backwards (webhooks can arrive out of order); "failed" can't override delivered/read. */
export function nextDeliveryStatus(current: string, incoming: "sent" | "delivered" | "read" | "failed"): string {
  if (incoming === "failed") return RANK[current]! >= RANK.delivered! ? current : "failed";
  if (current === "failed") return incoming === "sent" ? current : incoming;
  return (RANK[incoming] ?? 0) > (RANK[current] ?? 0) ? incoming : current;
}
