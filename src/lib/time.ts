import { DateTime } from "luxon";

export const REPORT_TZ = "Asia/Kolkata";

export function nowInTz(tz = REPORT_TZ): DateTime {
  return DateTime.now().setZone(tz);
}

/** Start of the calendar day (00:00) in the report timezone for the given instant. */
export function startOfDay(at: Date, tz = REPORT_TZ): Date {
  return DateTime.fromJSDate(at).setZone(tz).startOf("day").toJSDate();
}

/** 'YYYY-MM-DD' in the report timezone. */
export function isoDate(at: Date, tz = REPORT_TZ): string {
  return DateTime.fromJSDate(at).setZone(tz).toISODate()!;
}

/** The instant for a 'HH:mm' slot on a given 'YYYY-MM-DD' date in the report timezone. */
export function slotInstant(date: string, slot: string, tz = REPORT_TZ): Date {
  const [h, m] = slot.split(":").map(Number);
  return DateTime.fromISO(date, { zone: tz }).set({ hour: h, minute: m, second: 0, millisecond: 0 }).toJSDate();
}

/** "Fri 20 Nov 2026" */
export function reportDayLabel(at: Date, tz = REPORT_TZ): string {
  return DateTime.fromJSDate(at).setZone(tz).toFormat("ccc d LLL yyyy");
}

/** "6:35 PM" */
export function clockLabel(at: Date, tz = REPORT_TZ): string {
  return DateTime.fromJSDate(at).setZone(tz).toFormat("h:mm a");
}

export function toUnixSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

/** Validates 'HH:mm' (24h). */
export function isValidSlot(slot: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(slot);
}

/**
 * Callyzer returns timestamps like "2023-11-30 22:42:53 IST" in the account's timezone.
 * The trailing zone abbreviation is ambiguous in general, so we interpret the wall time in
 * the configured account timezone.
 */
export function parseCallyzerDateTime(value: string | null | undefined, tz = REPORT_TZ): Date | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(value.trim());
  if (!m) return null;
  const dt = DateTime.fromISO(`${m[1]}T${m[2]}`, { zone: tz });
  return dt.isValid ? dt.toJSDate() : null;
}

/** Upcoming slot instants (next `count`) given schedule settings. */
export function upcomingSlots(
  slots: string[],
  daysOfWeek: number[], // 1 = Monday ... 7 = Sunday (ISO)
  from: Date,
  count: number,
  tz = REPORT_TZ,
): Date[] {
  const out: Date[] = [];
  const sorted = [...slots].filter(isValidSlot).sort();
  if (sorted.length === 0 || daysOfWeek.length === 0) return out;
  let day = DateTime.fromJSDate(from).setZone(tz).startOf("day");
  for (let i = 0; i < 14 && out.length < count; i++, day = day.plus({ days: 1 })) {
    if (!daysOfWeek.includes(day.weekday)) continue;
    for (const s of sorted) {
      const inst = slotInstant(day.toISODate()!, s, tz);
      if (inst.getTime() > from.getTime()) out.push(inst);
      if (out.length >= count) break;
    }
  }
  return out;
}
