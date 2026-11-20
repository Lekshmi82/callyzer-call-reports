/**
 * DEVELOPMENT ONLY: mock of the WATI V3 template endpoints, following https://docs.wati.io response shapes.
 * It downloads the template's image URL like WATI would (so signed media URLs get exercised) and can
 * post delivery webhooks back to the app.
 *
 *   npm run mock:wati     (token: mock-wati-token; set MOCK_WEBHOOK_URL to receive status webhooks)
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export interface MockWatiOptions {
  token?: string;
  webhookUrl?: string;
  /** Recipient numbers that WATI should report as failed in recipients[].errors */
  failNumbers?: string[];
  /** Respond 500 to the next N send requests. */
  fail500?: number;
  /** Respond 429 to the next N send requests. */
  fail429?: number;
}

export function createMockWati(opts: MockWatiOptions = {}) {
  const token = opts.token ?? "mock-wati-token";
  const sent: { template: string; target: string; localMessageId: string; params: Record<string, string>; imageBytes: number }[] = [];
  const state = { fail500: opts.fail500 ?? 0, fail429: opts.fail429 ?? 0, webhookUrl: opts.webhookUrl ?? "" };

  const templates = [
    {
      id: "tpl-1",
      name: "call_report_update",
      category: "UTILITY",
      status: "APPROVED",
      type: "template",
      header: { type: "image", link: "{{report_image}}" },
      body: "Call report for {{report_date}}, as of {{report_time}} IST. {{summary}}",
      custom_params: [
        { index: 0, param_name: "report_image" },
        { index: 1, param_name: "report_date" },
        { index: 2, param_name: "report_time" },
        { index: 3, param_name: "summary" },
      ],
    },
    { id: "tpl-2", name: "welcome_message", category: "MARKETING", status: "APPROVED", type: "template", header: null, body: "Hi!", custom_params: [] },
  ];

  async function postWebhook(event: Record<string, unknown>) {
    if (!state.webhookUrl) return;
    await fetch(state.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event) }).catch(() => undefined);
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        return res.end("Unauthorized");
      }
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "GET" && url.pathname === "/api/ext/v3/messageTemplates") {
        return send(200, { templates, page_number: 1, page_size: 100, total: templates.length });
      }
      if (req.method === "POST" && url.pathname === "/api/ext/v3/messageTemplates/send") {
        if (state.fail429 > 0) {
          state.fail429--;
          return send(429, { code: 429, message: "Too many requests" }, { "Retry-After": "1" });
        }
        if (state.fail500 > 0) {
          state.fail500--;
          return send(500, { code: 500, message: "Internal error" });
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
          template_name?: string;
          broadcast_name?: string;
          recipients?: { target?: string; local_message_id?: string; custom_params?: { name: string; value: string }[] }[];
        };
        const tpl = templates.find((t) => t.name === body.template_name && t.status === "APPROVED");
        if (!tpl) return send(200, { success: false, error: `Template '${body.template_name}' not found or not approved` });
        if (!body.broadcast_name) return send(400, { code: 400, message: "broadcast_name is required" });
        const broadcastId = randomUUID();
        const results = [];
        for (const r of body.recipients ?? []) {
          const params = Object.fromEntries((r.custom_params ?? []).map((p) => [p.name, p.value]));
          const missing = tpl.custom_params.map((p) => p.param_name).filter((p) => !params[p]);
          const errors: string[] = [];
          if (missing.length) errors.push(`Missing parameters: ${missing.join(", ")}`);
          if (opts.failNumbers?.includes(r.target ?? "")) errors.push("Invalid WhatsApp number");
          let imageBytes = 0;
          if (!errors.length && params.report_image) {
            try {
              const img = await fetch(params.report_image);
              if (!img.ok) errors.push(`Media download failed (${img.status})`);
              else imageBytes = (await img.arrayBuffer()).byteLength;
            } catch (e) {
              errors.push(`Media download failed (${(e as Error).message})`);
            }
          }
          if (!errors.length) sent.push({ template: tpl.name, target: r.target!, localMessageId: r.local_message_id!, params, imageBytes });
          results.push({ local_message_id: r.local_message_id, phone_number: r.target, target: r.target, errors });
        }
        send(200, { success: true, broadcast_id: broadcastId, recipients: results });
        // Simulate async delivery receipts.
        for (const r of results.filter((x) => x.errors.length === 0)) {
          const base = { id: randomUUID(), whatsappMessageId: `wamid.${randomUUID()}`, localMessageId: r.local_message_id, conversationId: "c1", ticketId: "t1", text: null, type: "image", operatorEmail: null };
          setTimeout(() => void postWebhook({ ...base, eventType: "templateMessageSent_v2", statusString: "SENT", waId: r.target }), 100);
          setTimeout(() => void postWebhook({ ...base, eventType: "sentMessageDELIVERED_v2", statusString: "Delivered", timestamp: String(Date.now()) }), 250);
        }
        return;
      }
      send(404, { code: 404, message: "Not found" });
    });
  });
  return { server, sent, state };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? 4020);
  const { server } = createMockWati({ webhookUrl: process.env.MOCK_WEBHOOK_URL });
  server.listen(port, () => console.log(`Mock WATI listening on http://localhost:${port} (token: mock-wati-token)`));
}
