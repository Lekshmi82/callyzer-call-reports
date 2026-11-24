import { execFile } from "node:child_process";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockCallyzer } from "../dev/mock-callyzer.js";
import { dueSlots } from "../src/schedule.js";

const run = promisify(execFile);
let callyzerUrl = "";
const mock = createMockCallyzer();
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-e2e-"));

beforeAll(async () => {
  await new Promise<void>((r) => mock.server.listen(0, "127.0.0.1", r));
  callyzerUrl = `http://127.0.0.1:${(mock.server.address() as AddressInfo).port}/api/v2.3`;
});
afterAll(() => mock.server.close());

describe("npm run report (end to end against mock Callyzer)", () => {
  it("fetches from Callyzer and renders the report image without sending anything", async () => {
    const env = { ...process.env, CALLYZER_API_TOKEN: "mock-callyzer-token", CALLYZER_BASE_URL: callyzerUrl, OUTPUT_DIR: outDir, EMPLOYEE_ALIASES: "Rohan=Riya Sharma" };
    // Run tsx through node itself: `npx` is `npx.cmd` on Windows and execFile can't start it without a shell.
    const root = path.resolve(__dirname, "..");
    const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
    const { stdout } = await run(process.execPath, [tsxCli, "src/run-report.ts"], { env, cwd: root });
    expect(stdout).toContain("nothing sent");
    const png = fs.readdirSync(outDir).find((f) => f.endsWith(".png"));
    expect(fs.statSync(path.join(outDir, png!)).size).toBeGreaterThan(50_000);
    expect(mock.stats.byPath["/employee/get"]).toBe(1);
    expect(mock.stats.byPath["/call-log/history/stream"]).toBe(1);
  });
});

describe("schedule", () => {
  const slots = ["14:00", "16:00", "18:00", "20:00"];
  const all = [1, 2, 3, 4, 5, 6, 7];
  it("finds the slot that is due within the grace window (IST)", () => {
    const at = (iso: string) => dueSlots(new Date(iso), slots, all, 45).map((d) => d.key);
    expect(at("2026-11-24T08:29:00Z")).toEqual([]); // 1:59 PM IST
    expect(at("2026-11-24T08:30:00Z")).toEqual(["2026-11-24 14:00"]); // 2:00 PM IST
    expect(at("2026-11-24T09:14:00Z")).toEqual(["2026-11-24 14:00"]); // 2:44 PM IST
    expect(at("2026-11-24T09:15:00Z")).toEqual([]); // 2:45 PM IST, grace over
    expect(at("2026-11-24T14:40:00Z")).toEqual(["2026-11-24 20:00"]); // 8:10 PM IST
  });
  it("respects weekdays", () => {
    expect(dueSlots(new Date("2026-11-22T08:31:00Z"), slots, [1, 2, 3, 4, 5, 6], 45)).toEqual([]); // Sunday
  });
});
