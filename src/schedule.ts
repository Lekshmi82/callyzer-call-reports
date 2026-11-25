import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { isValidSlot, REPORT_TZ, slotInstant } from "./lib/time.js";

export interface DueSlot {
  key: string; // "2026-11-24 14:00"
  date: string;
  slot: string;
  /** All earlier slot keys of the same day: superseded once this one is sent (reports are cumulative). */
  earlierKeys: string[];
}

/**
 * The slot that should be sent now: the latest slot of today whose time has passed. It stays due until
 * the next slot starts (or midnight after the last slot), so a PC that was off/asleep at 8:00 PM still
 * sends one up-to-date report when it comes back at, say, 9:30 PM. Older missed slots are skipped
 * because the newer report already contains their data.
 */
export function dueSlot(now: Date, slots: string[], days: number[], tz = REPORT_TZ): DueSlot | null {
  const today = DateTime.fromJSDate(now).setZone(tz).startOf("day");
  if (!days.includes(today.weekday)) return null;
  const date = today.toISODate()!;
  const passed = [...new Set(slots.filter(isValidSlot))].sort().filter((slot) => slotInstant(date, slot, tz).getTime() <= now.getTime());
  const slot = passed[passed.length - 1];
  if (!slot) return null;
  return { key: `${date} ${slot}`, date, slot, earlierKeys: passed.slice(0, -1).map((x) => `${date} ${x}`) };
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

  markSent(key: string, alsoKeys: string[] = []): void {
    const at = new Date().toISOString();
    for (const k of alsoKeys) this.state.sent[k] ??= `skipped (covered by ${key})`;
    this.state.sent[key] = at;
    // Keep ~2 weeks of slot keys.
    const keys = Object.keys(this.state.sent).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 80))) delete this.state.sent[k];
    this.save();
  }

  /** Marks slots as handled without sending (e.g. the schedule was just switched on). */
  markSkipped(keys: string[], reason: string): void {
    for (const k of keys) this.state.sent[k] ??= `skipped (${reason})`;
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
