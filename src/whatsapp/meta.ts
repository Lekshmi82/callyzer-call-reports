import { request } from "../lib/http.js";

/**
 * Official WhatsApp Cloud API (Meta), https://developers.facebook.com/documentation/business-messaging/whatsapp/
 *  - POST /{PHONE_NUMBER_ID}/media      upload the PNG (multipart: messaging_product=whatsapp, file)
 *  - POST /{PHONE_NUMBER_ID}/messages   send to a person (recipient_type "individual", to = phone)
 *                                       or to an API-created group (recipient_type "group", to = group ID)
 * A target is either digits ("919876543210") or "group:<GROUP_ID>".
 */
export interface MetaConfig {
  token: string;
  phoneNumberId: string;
  apiVersion: string;
  baseUrl?: string;
}

export class MetaWhatsApp {
  private readonly base: string;
  constructor(private readonly cfg: MetaConfig) {
    this.base = `${(cfg.baseUrl ?? "https://graph.facebook.com").replace(/\/+$/, "")}/${cfg.apiVersion}/${cfg.phoneNumberId}`;
  }

  private errorText(status: number, body: string): string {
    try {
      const e = (JSON.parse(body) as { error?: { message?: string; code?: number; error_data?: { details?: string } } }).error;
      if (e) return `WhatsApp API ${status}: ${e.message ?? ""}${e.error_data?.details ? ` (${e.error_data.details})` : ""} [code ${e.code ?? "?"}]`;
    } catch {
      /* not JSON */
    }
    return `WhatsApp API ${status}: ${body.slice(0, 300)}`;
  }

  /** Uploads a PNG and returns its media ID (built-in fetch handles multipart). */
  async uploadPng(png: Buffer, filename: string): Promise<string> {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), filename);
    const res = await fetch(`${this.base}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.token}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(this.errorText(res.status, body));
    const id = (JSON.parse(body) as { id?: string }).id;
    if (!id) throw new Error("WhatsApp media upload returned no id");
    return id;
  }

  /** Sends the report. Template mode works outside the 24h window; image mode is a plain image + caption. */
  async send(
    target: string,
    msg:
      | { kind: "template"; name: string; language: string; imageId: string; bodyParams: string[] }
      | { kind: "image"; imageId: string; caption: string },
  ): Promise<string> {
    const isGroup = target.startsWith("group:");
    const to = isGroup ? target.slice(6) : target.replace(/\D/g, "");
    const payload: Record<string, unknown> = { messaging_product: "whatsapp", recipient_type: isGroup ? "group" : "individual", to };
    if (msg.kind === "template") {
      const components: unknown[] = [{ type: "header", parameters: [{ type: "image", image: { id: msg.imageId } }] }];
      if (msg.bodyParams.length) components.push({ type: "body", parameters: msg.bodyParams.map((text) => ({ type: "text", text })) });
      payload.type = "template";
      payload.template = { name: msg.name, language: { code: msg.language }, components };
    } else {
      payload.type = "image";
      payload.image = { id: msg.imageId, caption: msg.caption };
    }
    const res = await request({
      method: "POST",
      url: `${this.base}/messages`,
      headers: { Authorization: `Bearer ${this.cfg.token}` },
      json: payload,
      timeoutMs: 30_000,
    });
    if (res.status < 200 || res.status >= 300) throw new Error(this.errorText(res.status, res.body));
    return (JSON.parse(res.body) as { messages?: { id?: string }[] }).messages?.[0]?.id ?? "";
  }
}
