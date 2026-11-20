import { describe, expect, it } from "vitest";
import type { CallRecord, Employee, EmployeeSummaryRow } from "../src/callyzer/client.js";
import { Crypto } from "../src/lib/crypto.js";
import { formatDuration, parseHms } from "../src/lib/format.js";
import { computeReport, normaliseNumber, type ComputeInput } from "../src/report/metrics.js";
import { sampleDataset } from "../src/report/sample.js";

const crypto = new Crypto("test-master-key-that-is-at-least-32-chars");
const cutoff = new Date("2026-11-20T13:05:00Z"); // 6:35 PM IST

let seq = 0;
function rec(emp: string, empNumber: string, client: string, callType: string, duration: number, id?: string): CallRecord {
  return {
    id: id ?? `r${++seq}`,
    empName: emp,
    empCode: null,
    empCountryCode: "91",
    empNumber,
    clientCountryCode: "91",
    clientNumber: client,
    duration,
    callType,
    callDate: "2026-11-20",
    callTime: "10:00:00",
  };
}
function emp(name: string, num: string, lastSync = "2026-11-20 18:30:00 IST"): Employee {
  return { empName: name, empCode: null, empCountryCode: "91", empNumber: num, lastSyncReqAt: lastSync, lastCallAt: null, isAppUninstalled: false };
}
function summary(name: string, num: string, working: string, idle: string, calls = 0, clients = 0): EmployeeSummaryRow {
  return {
    empName: name,
    empCode: null,
    empCountryCode: "91",
    empNumber: num,
    totalCalls: calls,
    totalDuration: 0,
    totalConnectedCalls: 0,
    totalUniqueClients: clients,
    workingHms: working,
    idleHms: idle,
  };
}
function input(partial: Partial<ComputeInput>): ComputeInput {
  return {
    title: "Call Report",
    cutoff,
    generatedAt: cutoff,
    source: "callyzer",
    employees: [],
    summaries: [],
    records: [],
    overrides: new Map(),
    phoneKey: (n) => crypto.phoneKey(n),
    defaultCountryCode: "91",
    staleSyncMinutes: 90,
    includesWhatsApp: false,
    timezone: "Asia/Kolkata",
    ...partial,
  };
}

describe("formatting", () => {
  it("formats durations like the reference report", () => {
    expect(formatDuration(9026)).toBe("2h 30m 26s");
    expect(formatDuration(2606)).toBe("43m 26s");
    expect(formatDuration(46)).toBe("0m 46s");
    expect(formatDuration(36167, { seconds: false })).toBe("10h 2m");
    expect(formatDuration(97980, { seconds: false })).toBe("27h 13m");
  });
  it("parses Callyzer HH:mm:ss including >24h", () => {
    expect(parseHms("03:43:55")).toBe(13435);
    expect(parseHms("27:13:00")).toBe(97980);
    expect(parseHms("")).toBe(0);
  });
  it("normalises numbers with and without country code", () => {
    expect(normaliseNumber("91", "9876543210", "91")).toBe("919876543210");
    expect(normaliseNumber("", "919876543210", "91")).toBe("919876543210");
    expect(normaliseNumber("", "9876543210", "91")).toBe("919876543210");
    expect(normaliseNumber("91", "09876543210", "91")).toBe("919876543210");
  });
});

describe("computeReport", () => {
  it("applies Callyzer's connected definition (> 2 seconds, incoming/outgoing only)", () => {
    const r = computeReport(
      input({
        employees: [emp("Anoop", "7000000001")],
        records: [
          rec("Anoop", "7000000001", "9800000001", "Outgoing", 2), // not connected
          rec("Anoop", "7000000001", "9800000002", "Outgoing", 3), // connected
          rec("Anoop", "7000000001", "9800000003", "Incoming", 100), // connected
          rec("Anoop", "7000000001", "9800000004", "Missed", 0),
          rec("Anoop", "7000000001", "9800000005", "Rejected", 0),
        ],
      }),
    );
    const row = r.model.rows[0]!;
    expect(row.totalCalls).toBe(5);
    expect(row.connectedCalls).toBe(2);
    expect(row.connectedPct).toBe(40);
    expect(row.totalDuration).toBe(105);
    expect(row.connectedDuration).toBe(103);
    expect(row.avgConnected).toBe(52); // 103 / 2 = 51.5 → 52
    expect(row.uniqueClients).toBe(5);
    expect(row.uniqueConnected).toBe(2);
  });

  it("combines a person's phones and adds working/idle time", () => {
    const r = computeReport(
      input({
        employees: [emp("Dharshan", "7000000001"), emp("Dharshan", "7000000002")],
        records: [
          rec("Dharshan", "7000000001", "9800000001", "Outgoing", 60),
          rec("Dharshan", "7000000002", "9800000001", "Outgoing", 30), // same client from 2nd phone
          rec("Dharshan", "7000000002", "9800000002", "Missed", 0),
        ],
        summaries: [summary("Dharshan", "7000000001", "01:00:00", "02:00:00", 1, 1), summary("Dharshan", "7000000002", "00:35:57", "00:10:00", 2, 2)],
      }),
    );
    expect(r.model.rows).toHaveLength(1);
    const row = r.model.rows[0]!;
    expect(row.phones).toBe(2);
    expect(row.totalCalls).toBe(3);
    expect(row.uniqueClients).toBe(2); // client 1 counted once across both phones
    expect(row.workingSeconds).toBe(3600 + 2157);
    expect(row.idleSeconds).toBe(7200 + 600);
    expect(r.model.footnotes[0]).toContain("Phones combined for Dharshan");
    expect(r.warnings).toEqual([]); // cross-check per phone matches
  });

  it("counts team unique clients once across employees (not the sum of rows)", () => {
    const r = computeReport(
      input({
        employees: [emp("A", "7000000001"), emp("B", "7000000002")],
        records: [
          rec("A", "7000000001", "9800000001", "Outgoing", 60),
          rec("B", "7000000002", "9800000001", "Outgoing", 60),
          rec("B", "7000000002", "9800000002", "Outgoing", 1),
        ],
      }),
    );
    const sumOfRows = r.model.rows.reduce((t, x) => t + x.uniqueClients, 0);
    expect(sumOfRows).toBe(3);
    expect(r.model.team.uniqueClients).toBe(2);
    expect(r.model.team.uniqueConnected).toBe(1);
  });

  it("includes registered employees with no activity, drops duplicate records and honours overrides", () => {
    const r = computeReport(
      input({
        employees: [emp("Ayush", "7000000009", "2026-11-20 09:00:00 IST"), emp("Ashlin", "7000000003"), emp("Ash (old)", "7000000004"), emp("Manager", "7000000005")],
        records: [
          rec("Ashlin", "7000000003", "9800000001", "Outgoing", 10, "dup"),
          rec("Ashlin", "7000000003", "9800000001", "Outgoing", 10, "dup"),
          rec("Ash (old)", "7000000004", "9800000002", "Incoming", 10),
          rec("Manager", "7000000005", "9800000003", "Incoming", 10),
        ],
        overrides: new Map([
          [crypto.phoneKey("917000000004"), { personOverride: "Ashlin", excluded: false }],
          [crypto.phoneKey("917000000005"), { personOverride: null, excluded: true }],
        ]),
      }),
    );
    expect(r.stats.duplicatesDropped).toBe(1);
    expect(r.model.rows.map((x) => x.name)).toEqual(["Ashlin", "Ayush"]);
    const ashlin = r.model.rows[0]!;
    expect(ashlin.totalCalls).toBe(2);
    expect(ashlin.phones).toBe(2);
    const ayush = r.model.rows[1]!;
    expect(ayush.active).toBe(false);
    expect(ayush.totalCalls).toBe(0);
    expect(r.model.team.totalCalls).toBe(2); // excluded manager not counted
    expect(r.model.footnotes.join(" ")).toContain("Ayush (last sync 9:00 AM)");
  });

  it("reports cross-check mismatches against Callyzer's own summary as warnings", () => {
    const r = computeReport(
      input({
        employees: [emp("A", "7000000001")],
        records: [rec("A", "7000000001", "9800000001", "Outgoing", 60)],
        summaries: [summary("A", "7000000001", "00:10:00", "00:00:00", 2, 1)],
      }),
    );
    expect(r.warnings[0]).toMatch(/1 call records but Callyzer summary says 2/);
  });

  it("produces labels in IST", () => {
    const r = computeReport(input({}));
    expect(r.model.dateLabel).toBe("Fri 20 Nov 2026");
    expect(r.model.asOfLabel).toBe("6:35 PM");
  });

  it("sample dataset is internally consistent with its own summaries", () => {
    const from = new Date("2026-11-19T18:30:00Z");
    const data = sampleDataset(from, cutoff);
    const r = computeReport(input({ ...data, source: "sample" }));
    expect(r.warnings).toEqual([]);
    expect(r.model.rows.length).toBe(9);
    expect(r.model.team.totalCalls).toBe(data.records.length);
    expect(r.model.team.uniqueClients).toBeLessThan(r.model.rows.reduce((t, x) => t + x.uniqueClients, 0));
  });
});
