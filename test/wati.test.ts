import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createMockWati, type MockWatiOptions } from "../dev/mock-wati.js";
import { nextDeliveryStatus, WatiClient, webhookStatus } from "../src/whatsapp/wati.js";

const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

async function listen(server: http.Server) {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function setup(opts: MockWatiOptions = {}) {
  const img = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(Buffer.alloc(1234));
  });
  const imgUrl = (await listen(img)) + "/report.png";
  const mock = createMockWati(opts);
  const host = await listen(mock.server);
  return { client: new WatiClient(host, "mock-wati-token"), mock, imgUrl };
}

const params = (img: string) => [
  { name: "report_image", value: img },
  { name: "report_date", value: "Fri 20 Nov 2026" },
  { name: "report_time", value: "6:00 PM" },
  { name: "summary", value: "687 calls" },
];

describe("WatiClient", () => {
  it("lists templates with their params", async () => {
    const { client } = await setup();
    const t = await client.listTemplates();
    expect(t[0]).toMatchObject({ name: "call_report_update", status: "APPROVED", headerType: "image", params: ["report_image", "report_date", "report_time", "summary"] });
  });

  it("sends to each recipient and reconciles per-recipient results", async () => {
    const { client, mock, imgUrl } = await setup({ failNumbers: ["919000000002"] });
    const r = await client.sendTemplate({
      templateName: "call_report_update",
      broadcastName: "test",
      recipients: [
        { target: "919000000001", localMessageId: "a", customParams: params(imgUrl) },
        { target: "919000000002", localMessageId: "b", customParams: params(imgUrl) },
      ],
    });
    expect(r.kind).toBe("completed");
    if (r.kind !== "completed") return;
    expect(r.outcomes.find((o) => o.localMessageId === "a")!.status).toBe("accepted");
    expect(r.outcomes.find((o) => o.localMessageId === "b")!.status).toBe("failed");
    expect(mock.sent[0]!.imageBytes).toBe(1234);
  });

  it("treats 500 as unknown (no blind resend) and 429 as retryable", async () => {
    const { client, imgUrl } = await setup({ fail500: 1, fail429: 1 });
    const rec = [{ target: "919000000001", localMessageId: "x", customParams: params(imgUrl) }];
    const first = await client.sendTemplate({ templateName: "call_report_update", broadcastName: "t", recipients: rec });
    expect(first.kind).toBe("retry");
    const second = await client.sendTemplate({ templateName: "call_report_update", broadcastName: "t", recipients: rec });
    expect(second.kind === "completed" && second.outcomes[0]!.status).toBe("unknown");
  });

  it("rejects an unapproved/unknown template as a configuration error", async () => {
    const { client, imgUrl } = await setup();
    const r = await client.sendTemplate({ templateName: "nope", broadcastName: "t", recipients: [{ target: "919000000001", localMessageId: "y", customParams: params(imgUrl) }] });
    expect(r.kind).toBe("rejected");
  });

  it("returns retry when the host is unreachable (request never sent)", async () => {
    const client = new WatiClient("http://127.0.0.1:1", "t", 2000);
    const r = await client.sendTemplate({ templateName: "x", broadcastName: "t", recipients: [{ target: "1", localMessageId: "z", customParams: [] }] });
    expect(r.kind).toBe("retry");
  });
});

describe("webhook status mapping", () => {
  it("maps event types and never regresses", () => {
    expect(webhookStatus("templateMessageSent_v2")).toBe("sent");
    expect(webhookStatus("sentMessageDELIVERED_v2")).toBe("delivered");
    expect(webhookStatus("sentMessageREAD")).toBe("read");
    expect(webhookStatus("templateMessageFailed")).toBe("failed");
    expect(webhookStatus("message")).toBeNull();
    expect(nextDeliveryStatus("delivered", "sent")).toBe("delivered");
    expect(nextDeliveryStatus("accepted", "delivered")).toBe("delivered");
    expect(nextDeliveryStatus("read", "failed")).toBe("read");
    expect(nextDeliveryStatus("unknown", "sent")).toBe("sent");
    expect(nextDeliveryStatus("accepted", "failed")).toBe("failed");
  });
});
