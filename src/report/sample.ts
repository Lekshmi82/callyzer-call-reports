import type { CallRecord, Employee, EmployeeSummaryRow } from "../callyzer/client.js";
import { DateTime } from "luxon";
import { REPORT_TZ } from "../lib/time.js";

/**
 * Deterministic synthetic data shaped exactly like Callyzer API responses.
 * Used for "Preview with sample data" (clearly watermarked) and by the dev mock server.
 * Names and numbers are fictional.
 */
const PEOPLE: { name: string; phones: number; weight: number }[] = [
  { name: "Aarav", phones: 1, weight: 0.6 },
  { name: "Diya", phones: 1, weight: 1.6 },
  { name: "Ishaan", phones: 1, weight: 0 },
  { name: "Kavya", phones: 2, weight: 1.0 },
  { name: "Meera", phones: 2, weight: 1.1 },
  { name: "Nikhil Rao", phones: 1, weight: 0.8 },
  { name: "Riya Sharma", phones: 1, weight: 1.0 },
  { name: "Rohan", phones: 1, weight: 0.7 },
  { name: "Zoya", phones: 2, weight: 0.8 },
];

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SampleDataset {
  employees: Employee[];
  records: CallRecord[];
  summaries: EmployeeSummaryRow[];
}

const hms = (s: number) =>
  `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export function sampleDataset(from: Date, to: Date, seed = 20261120): SampleDataset {
  const rand = prng(seed);
  const employees: Employee[] = [];
  const records: CallRecord[] = [];
  const summaries: EmployeeSummaryRow[] = [];
  const dayStart = DateTime.fromJSDate(from).setZone(REPORT_TZ);
  const workStart = dayStart.set({ hour: 9, minute: 30 });
  const windowEnd = DateTime.fromJSDate(to).setZone(REPORT_TZ);
  const elapsedHours = Math.max(0, windowEnd.diff(workStart, "hours").hours);
  const clientPool = Array.from({ length: 900 }, (_, i) => `98${String(10_000_000 + i * 7919).slice(-8)}`);
  let phoneSeq = 0;
  let callSeq = 0;

  for (const person of PEOPLE) {
    for (let ph = 0; ph < person.phones; ph++) {
      phoneSeq++;
      const empNumber = `70000${String(phoneSeq).padStart(5, "0")}`;
      const isMain = ph === 0;
      employees.push({
        empName: person.name,
        empCode: `E${100 + phoneSeq}`,
        empCountryCode: "91",
        empNumber,
        lastSyncReqAt: windowEnd.minus({ minutes: person.weight === 0 ? 400 : Math.floor(rand() * 20) }).toFormat("yyyy-MM-dd HH:mm:ss 'IST'"),
        lastCallAt: null,
        isAppUninstalled: false,
      });
      const share = isMain ? 0.75 : 0.25;
      const callsN = Math.round(person.weight * share * elapsedHours * (14 + rand() * 6));
      let total = 0;
      let dur = 0;
      let connected = 0;
      const clients = new Set<string>();
      for (let i = 0; i < callsN; i++) {
        const t = workStart.plus({ seconds: Math.floor(rand() * elapsedHours * 3600) });
        if (t >= windowEnd) continue;
        const r = rand();
        const callType = r < 0.62 ? "Outgoing" : r < 0.78 ? "Incoming" : r < 0.93 ? "Missed" : "Rejected";
        const talk = callType === "Outgoing" || callType === "Incoming";
        const answered = talk && rand() < 0.6;
        const duration = !talk ? 0 : answered ? 15 + Math.floor(rand() ** 2 * 420) : Math.floor(rand() * 3);
        const client = clientPool[Math.floor(rand() ** 1.3 * clientPool.length)]!;
        callSeq++;
        records.push({
          id: `sample-${seed}-${callSeq}`,
          empName: person.name,
          empCode: `E${100 + phoneSeq}`,
          empCountryCode: "91",
          empNumber,
          clientCountryCode: "91",
          clientNumber: client,
          duration,
          callType,
          callDate: t.toISODate()!,
          callTime: t.toFormat("HH:mm:ss"),
        });
        total++;
        clients.add(client);
        if (talk) dur += duration;
        if (talk && duration > 2) connected++;
      }
      const working = total ? Math.round(Math.min(elapsedHours * 3600, total * (110 + rand() * 60))) : 0;
      const idle = total ? Math.round(Math.max(0, elapsedHours * 3600 * (isMain ? 0.75 : 0.2) - working * 0.4)) : 0;
      if (total > 0)
        summaries.push({
          empName: person.name,
          empCode: `E${100 + phoneSeq}`,
          empCountryCode: "91",
          empNumber,
          totalCalls: total,
          totalDuration: dur,
          totalConnectedCalls: connected,
          totalUniqueClients: clients.size,
          workingHms: hms(working),
          idleHms: hms(idle),
        });
    }
  }
  return { employees, records, summaries };
}
