import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createMockCallyzer, type MockCallyzerOptions } from "../dev/mock-callyzer.js";
import { CallyzerClient, CallyzerError } from "../src/callyzer/client.js";
import { createLogger } from "../src/logger.js";

const log = createLogger("silent" as "error");
const servers: { close: () => void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function setup(opts: MockCallyzerOptions = {}, clientOpts: { token?: string; spacingMs?: number } = {}) {
  const mock = createMockCallyzer(opts);
  await new Promise<void>((r) => mock.server.listen(0, "127.0.0.1", r));
  servers.push(mock.server);
  const port = (mock.server.address() as AddressInfo).port;
  const client = new CallyzerClient({
    baseUrl: `http://127.0.0.1:${port}/api/v2.3`,
    token: clientOpts.token ?? "mock-callyzer-token",
    log,
    spacingMs: clientOpts.spacingMs ?? 0,
  });
  return { client, stats: mock.stats };
}

const from = new Date("2026-11-19T18:30:00Z");
const to = new Date("2026-11-20T13:05:00Z");
const kind = { call_method: "PhoneCall", call_mode: "Voice" } as const;

describe("CallyzerClient (against documented-shape mock)", () => {
  it("lists employees, summaries and streams history", async () => {
    const { client, stats } = await setup();
    const employees = await client.listEmployees();
    expect(employees.length).toBe(12);
    const summary = await client.employeeSummary(from, to, kind);
    expect(summary.length).toBeGreaterThan(5);
    expect(summary[0]!.workingHms).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    const hist = await client.callHistory(from, to, kind);
    expect(hist.via).toBe("stream");
    expect(hist.records.length).toBe(summary.reduce((t, r) => t + r.totalCalls, 0));
    expect(stats.byPath["/call-log/history/stream"]).toBe(1);
  });

  it("falls back to paginated history when the stream is incomplete", async () => {
    const { client, stats } = await setup({ brokenStream: true });
    const hist = await client.callHistory(from, to, kind);
    expect(hist.via).toBe("paged");
    expect(stats.byPath["/call-log/history"]).toBeGreaterThan(1); // multiple pages
    const summary = await client.employeeSummary(from, to, kind);
    expect(hist.records.length).toBe(summary.reduce((t, r) => t + r.totalCalls, 0));
  });

  it("retries 5xx and respects 429 Retry-After", async () => {
    const { client, stats } = await setup({ failFirst: 2, enforceRateLimit: true });
    const t0 = Date.now();
    await client.listEmployees();
    await client.employeeSummary(from, to, kind); // immediately after → 429 → waits Retry-After 2s
    expect(stats.rateLimited).toBeGreaterThanOrEqual(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2_000);
  });

  it("raises a non-retryable auth error for a bad token", async () => {
    const { client, stats } = await setup({}, { token: "wrong" });
    const err = await client.listEmployees().catch((e) => e);
    expect(err).toBeInstanceOf(CallyzerError);
    expect((err as CallyzerError).kind).toBe("auth");
    expect(stats.requests).toBe(1);
  });

  it("treats 'No employees meet the search criteria' as empty", async () => {
    const { client } = await setup();
    const rows = await client.employeeSummary(from, to, { call_method: "WhatsAppCall", call_mode: "Video" });
    expect(rows).toEqual([]);
  });
});
