import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockCallyzer } from "../dev/mock-callyzer.js";

const run = promisify(execFile);
let callyzerUrl = "";
let metaUrl = "";
const metaCalls: { path: string; auth: string; body: string }[] = [];
const servers: http.Server[] = [];
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-e2e-"));

beforeAll(async () => {
  const { server } = createMockCallyzer();
  const meta = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("latin1");
      metaCalls.push({ path: req.url ?? "", auth: String(req.headers.authorization), body });
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url?.endsWith("/media")) return res.end(JSON.stringify({ id: "media-123" }));
      res.end(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: "wamid.TEST" }] }));
    });
  });
  for (const s of [server, meta]) {
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    servers.push(s);
  }
  callyzerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2.3`;
  metaUrl = `http://127.0.0.1:${(meta.address() as AddressInfo).port}`;
});
afterAll(() => servers.forEach((s) => s.close()));

describe("npm run report (end to end against mocks)", () => {
  it("fetches, renders and sends the template with the uploaded image to the test targets", async () => {
    const env = {
      ...process.env,
      CALLYZER_API_TOKEN: "mock-callyzer-token",
      CALLYZER_BASE_URL: callyzerUrl,
      WHATSAPP_TOKEN: "meta-token",
      WHATSAPP_PHONE_NUMBER_ID: "111",
      WHATSAPP_API_BASE: metaUrl,
      WHATSAPP_TEST_TARGETS: "919000000001,group:GROUP123",
      WHATSAPP_LIVE_TARGETS: "919999999999",
      EMPLOYEE_ALIASES: "Rohan=Riya Sharma",
      OUTPUT_DIR: outDir,
      LOG_LEVEL: "info",
    };
    const { stdout } = await run("npx", ["tsx", "src/run-report.ts", "--target", "test"], { env, cwd: path.resolve(__dirname, "..") });
    expect(stdout).toContain('"msg":"done"');
    const png = fs.readdirSync(outDir).find((f) => f.endsWith(".png"));
    expect(png).toBeTruthy();
    expect(fs.statSync(path.join(outDir, png!)).size).toBeGreaterThan(50_000);

    const upload = metaCalls.find((c) => c.path === "/v23.0/111/media")!;
    expect(upload.auth).toBe("Bearer meta-token");
    expect(upload.body).toContain('name="messaging_product"');
    expect(upload.body).toContain("image/png");

    const sends = metaCalls.filter((c) => c.path === "/v23.0/111/messages").map((c) => JSON.parse(c.body));
    expect(sends).toHaveLength(2);
    expect(sends[0]).toMatchObject({ recipient_type: "individual", to: "919000000001", type: "template" });
    expect(sends[0].template.components[0]).toEqual({ type: "header", parameters: [{ type: "image", image: { id: "media-123" } }] });
    expect(sends[0].template.components[1].parameters).toHaveLength(3);
    expect(sends[1]).toMatchObject({ recipient_type: "group", to: "GROUP123" });
    expect(JSON.stringify(sends)).not.toContain("919999999999"); // live target untouched
    // No phone numbers in logs.
    expect(stdout).not.toContain("919000000001");
  });
});
