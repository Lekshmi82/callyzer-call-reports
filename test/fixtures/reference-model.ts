import type { PersonRow, ReportModel } from "../../src/report/metrics.js";

/** Numbers transcribed from the reference screenshot (Fri 20 Nov 2026, 6:35 PM) — used for visual layout checks. */
const h = (H: number, M: number, S = 0) => H * 3600 + M * 60 + S;
function row(name: string, phones: number, calls: number, dur: number, conn: number, avg: number, work: number, idle: number, uc: number, ucc: number): PersonRow {
  return { name, phones, active: true, totalCalls: calls, totalDuration: dur, connectedCalls: conn, connectedPct: Math.round((conn / calls) * 100),
    connectedDuration: dur, avgConnected: avg, workingSeconds: work, idleSeconds: idle, uniqueClients: uc, uniqueConnected: ucc };
}
const zero = { totalCalls: 0, totalDuration: 0, connectedCalls: 0, connectedPct: 0, connectedDuration: 0, avgConnected: 0, workingSeconds: 0, idleSeconds: 0, uniqueClients: 0, uniqueConnected: 0 };
export const referenceModel: ReportModel = {
  title: "Call Report", dateLabel: "Fri 20 Nov 2026", asOfLabel: "6:35 PM", generatedAtLabel: "6:35 PM", cutoffIso: "2026-11-20T13:05:00.000Z", source: "callyzer",
  team: { totalCalls: 687, totalDuration: h(10, 2, 47), connectedCalls: 253, connectedPct: 37, connectedDuration: h(10, 2, 47), avgConnected: 143,
    workingSeconds: h(20, 33), idleSeconds: h(27, 13), uniqueClients: 540, uniqueConnected: 237 },
  rows: [
    row("Anoop", 1, 41, h(0, 43, 26), 24, 109, h(1, 38, 39), h(2, 35, 1), 38, 24),
    row("Ashlin", 1, 154, h(1, 29, 13), 46, 116, h(3, 15, 18), h(3, 43, 28), 77, 39),
    { name: "Ayush", phones: 1, active: false, ...zero },
    row("Dharshan", 2, 92, h(0, 16, 9), 21, 46, h(1, 35, 57), h(4, 36, 58), 87, 21),
    row("Saptak", 2, 101, h(2, 12, 59), 46, 173, h(4, 1, 21), h(2, 46, 34), 85, 43),
    row("Sarthak Dangrikar", 1, 74, h(2, 30, 25), 31, 291, h(3, 50, 18), h(2, 40, 7), 60, 29),
    row("Syed Mustafa", 1, 93, h(1, 5, 28), 27, 145, h(2, 15, 52), h(5, 8, 13), 74, 25),
    row("Tanav", 1, 60, h(0, 42, 35), 26, 98, h(1, 56, 4), h(1, 13, 45), 55, 25),
    row("Varsha", 2, 72, h(1, 2, 32), 32, 117, h(2, 0, 5), h(4, 29, 34), 64, 31),
  ],
  footnotes: [
    "Phones combined for Dharshan, Saptak and Varsha: calls, durations, working and idle hours are added across phones; each client is counted once per person.",
    "Connected = incoming/outgoing call longer than 2s. Team unique clients count each client once across the team.",
  ],
};
