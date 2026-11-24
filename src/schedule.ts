import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { isValidSlot, REPORT_TZ, slotInstant } from "./lib/time.js";

export interface DueSlot {
  key: string; // "2026-11-24 14:00"
  date: string;
  slot: string;
  cutoff: Date;
  deadline: Date;
}

/** Slots whose time has passed but are still within the grace window (today, plus yesterday for late slots). */
export function dueSlots(now: Date, slots: string[], days: number[], graceMinutes: number, tz = REPORT_TZ): DueSlot[] {
  const out: DueSlot[] = [];
  const today = DateTime.fromJSDate(now).setZone(tz).startOf("day");
  for (const day of [today.minus({ days: 1 }), today]) {
    if (!days.includes(day.weekday)) continue;
    const date = day.toISODate()!;
    for (const slot of slots.filter(isValidSlot).sort()) {
      const cutoff = slotInstant(date, slot, tz);
      const deadline = new Date(cutoff.getTime() + graceMinutes * 60_000);
      if (cutoff.getTime() <= now.getTime() && now.getTime() < deadline.getTime()) out.push({ key: `${date} ${slot}`, date, slot, cutoff, deadline });
    }
  }
  return out;
}

export interface HistoryEntry {
  at: string;
  kind: "scheduled" | "manual";
  key: string;
  group: string;
  status: "sent" | "failed" | "retrying";
  detail: string;
}

export interface RuntimeSettings {
  scheduleEnabled?: boolean;
  sendTo?: "test" | "live";
}

interface StateFile {
  sent: Record<string, string>; // slot key -> ISO time sent
  history: HistoryEntry[];
  settings: RuntimeSettings; // changed from the status page; override env defaults
}

/** Small JSON state file in the persistent data folder: which slots were sent (duplicate guard) + recent history. */
export class StateStore {
  private state: StateFile = { sent: {}, history: [], settings: {} };
  private readonly file: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "state.json");
    try {
      this.state = { sent: {}, history: [], settings: {}, ...JSON.parse(fs.readFileSync(this.file, "utf8")) };
    } catch {
      /* first run */
    }
  }

  isSent(key: string): boolean {
    return Boolean(this.state.sent[key]);
  }

  markSent(key: string): void {
    this.state.sent[key] = new Date().toISOString();
    // Keep ~2 weeks of slot keys.
    const keys = Object.keys(this.state.sent).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 80))) delete this.state.sent[k];
    this.save();
  }

  addHistory(e: Omit<HistoryEntry, "at">): void {
    this.state.history.unshift({ at: new Date().toISOString(), ...e });
    this.state.history = this.state.history.slice(0, 60);
    this.save();
  }

  settings(): RuntimeSettings {
    return { ...this.state.settings };
  }

  updateSettings(patch: RuntimeSettings): void {
    this.state.settings = { ...this.state.settings, ...patch };
    this.save();
  }

  history(): HistoryEntry[] {
    return this.state.history;
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
