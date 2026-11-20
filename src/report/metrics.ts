import type { CallRecord, Employee, EmployeeSummaryRow } from "../callyzer/client.js";
import { maskNumber, parseHms, percent } from "../lib/format.js";
import { clockLabel, parseCallyzerDateTime, reportDayLabel } from "../lib/time.js";

/**
 * Metric definitions (documented in docs/METRICS.md):
 *  - Total Calls          = all call records (Incoming, Outgoing, Missed, Rejected) in [00:00 IST, cutoff)
 *  - Connected Calls      = Incoming/Outgoing records with duration > 2s (Callyzer's own definition)
 *  - Connection rate      = Connected / Total × 100
 *  - Total Duration       = sum of durations of Incoming + Outgoing records (Callyzer "total_duration")
 *  - Connected Duration   = sum of durations of connected records (= "Talk Time")
 *  - Avg Connected        = Connected Duration / Connected Calls
 *  - Working / Idle Hours = Callyzer's per-phone total_working_hours / total_idle_time, added across a person's phones
 *  - Unique Clients       = distinct client numbers (all call types), counted once per person and once per team
 *  - Unique Connected     = distinct client numbers with at least one connected call
 */

export const CONNECTED_MIN_SECONDS = 2; // strictly greater than this

export interface Metrics {
  totalCalls: number;
  connectedCalls: number;
  connectedPct: number;
  totalDuration: number;
  connectedDuration: number;
  avgConnected: number;
  workingSeconds: number;
  idleSeconds: number;
  uniqueClients: number;
  uniqueConnected: number;
}

export interface PersonRow extends Metrics {
  name: string;
  phones: number;
  active: boolean;
}

export interface ReportModel {
  title: string;
  dateLabel: string;
  asOfLabel: string;
  generatedAtLabel: string;
  cutoffIso: string;
  source: "callyzer" | "sample";
  team: Metrics;
  rows: PersonRow[];
  footnotes: string[];
}

export interface PhoneOverride {
  personOverride: string | null;
  excluded: boolean;
}

export interface ComputeInput {
  title: string;
  cutoff: Date;
  generatedAt: Date;
  source: "callyzer" | "sample";
  employees: Employee[];
  summaries: EmployeeSummaryRow[];
  records: CallRecord[];
  overrides: Map<string, PhoneOverride>;
  phoneKey: (normalisedNumber: string) => string;
  defaultCountryCode: string;
  staleSyncMinutes: number;
  includesWhatsApp: boolean;
  timezone?: string;
}

export interface PhoneInfo {
  key: string;
  empName: string;
  empCode: string | null;
  masked: string;
  registered: boolean;
  lastSyncAt: Date | null;
  appUninstalled: boolean | null;
}

export interface ComputeResult {
  model: ReportModel;
  phones: PhoneInfo[];
  warnings: string[];
  stats: { records: number; duplicatesDropped: number; phones: number; persons: number };
}

/** Canonical digits for a phone number, used only to build keyed hashes. */
export function normaliseNumber(countryCode: string, number: string, defaultCountryCode: string): string {
  const cc = countryCode.replace(/\D/g, "");
  const num = number.replace(/\D/g, "").replace(/^0+/, "");
  if (!num) return "";
  if (cc) return num.startsWith(cc) && num.length > 10 ? num : cc + num;
  return num.length === 10 && defaultCountryCode ? defaultCountryCode + num : num;
}

const isTalk = (t: string) => /^(incoming|outgoing)$/i.test(t);

interface Acc {
  totalCalls: number;
  connectedCalls: number;
  totalDuration: number;
  connectedDuration: number;
  workingSeconds: number;
  idleSeconds: number;
  clients: Set<string>;
  connectedClients: Set<string>;
}
const newAcc = (): Acc => ({
  totalCalls: 0,
  connectedCalls: 0,
  totalDuration: 0,
  connectedDuration: 0,
  workingSeconds: 0,
  idleSeconds: 0,
  clients: new Set(),
  connectedClients: new Set(),
});

function finish(a: Acc): Metrics {
  return {
    totalCalls: a.totalCalls,
    connectedCalls: a.connectedCalls,
    connectedPct: percent(a.connectedCalls, a.totalCalls),
    totalDuration: a.totalDuration,
    connectedDuration: a.connectedDuration,
    avgConnected: a.connectedCalls > 0 ? Math.round(a.connectedDuration / a.connectedCalls) : 0,
    workingSeconds: a.workingSeconds,
    idleSeconds: a.idleSeconds,
    uniqueClients: a.clients.size,
    uniqueConnected: a.connectedClients.size,
  };
}

export function computeReport(input: ComputeInput): ComputeResult {
  const tz = input.timezone;
  const warnings: string[] = [];
  const phones = new Map<string, PhoneInfo>();
  const keyFor = (cc: string, num: string) => {
    const norm = normaliseNumber(cc, num, input.defaultCountryCode);
    return norm ? input.phoneKey(norm) : "";
  };
  const touchPhone = (cc: string, num: string, name: string, code: string | null, registered: boolean): string => {
    const key = keyFor(cc, num) || `unknown:${name || "?"}`;
    const existing = phones.get(key);
    if (existing) {
      if (!existing.empName && name) existing.empName = name;
      if (registered) existing.registered = true;
    } else {
      phones.set(key, { key, empName: name, empCode: code, masked: maskNumber(num), registered, lastSyncAt: null, appUninstalled: null });
    }
    return key;
  };

  for (const e of input.employees) {
    const key = touchPhone(e.empCountryCode, e.empNumber, e.empName, e.empCode, true);
    const p = phones.get(key)!;
    p.lastSyncAt = parseCallyzerDateTime(e.lastSyncReqAt, tz);
    p.appUninstalled = e.isAppUninstalled;
  }

  // Person resolution: admin override first, else the Callyzer employee name (case-insensitive).
  const personOf = (phoneKey: string): { id: string; name: string } | null => {
    const o = input.overrides.get(phoneKey);
    if (o?.excluded) return null;
    const p = phones.get(phoneKey)!;
    const name = (o?.personOverride?.trim() || p.empName.trim() || `Unnamed ${p.masked}`).replace(/\s+/g, " ");
    return { id: name.toLowerCase(), name };
  };

  const persons = new Map<string, { name: string; phones: Set<string>; acc: Acc }>();
  const ensurePerson = (phoneKey: string) => {
    const per = personOf(phoneKey);
    if (!per) return null;
    let entry = persons.get(per.id);
    if (!entry) persons.set(per.id, (entry = { name: per.name, phones: new Set(), acc: newAcc() }));
    entry.phones.add(phoneKey);
    return entry;
  };

  // Registered phones appear even with zero activity.
  for (const p of phones.values()) ensurePerson(p.key);

  // ---- Call records → counts, durations, unique clients ----
  const team = newAcc();
  const seen = new Set<string>();
  let duplicatesDropped = 0;
  const perPhoneCheck = new Map<string, { calls: number; clients: Set<string> }>();
  for (const r of input.records) {
    const dedupeKey = r.id || `${r.empNumber}|${r.clientNumber}|${r.callDate}|${r.callTime}|${r.callType}|${r.duration}`;
    if (seen.has(dedupeKey)) {
      duplicatesDropped++;
      continue;
    }
    seen.add(dedupeKey);
    const phoneKey = touchPhone(r.empCountryCode, r.empNumber, r.empName, r.empCode, false);
    const client = keyFor(r.clientCountryCode, r.clientNumber);
    const chk = perPhoneCheck.get(phoneKey) ?? { calls: 0, clients: new Set<string>() };
    chk.calls++;
    if (client) chk.clients.add(client);
    perPhoneCheck.set(phoneKey, chk);

    const person = ensurePerson(phoneKey);
    if (!person) continue; // excluded phone
    const talk = isTalk(r.callType);
    const connected = talk && r.duration > CONNECTED_MIN_SECONDS;
    for (const a of [person.acc, team]) {
      a.totalCalls++;
      if (talk) a.totalDuration += r.duration;
      if (connected) {
        a.connectedCalls++;
        a.connectedDuration += r.duration;
      }
      if (client) {
        a.clients.add(client);
        if (connected) a.connectedClients.add(client);
      }
    }
  }

  // ---- Employee summary → working / idle time (+ cross-check of our counts) ----
  for (const sRow of input.summaries) {
    const phoneKey = touchPhone(sRow.empCountryCode, sRow.empNumber, sRow.empName, sRow.empCode, false);
    const person = ensurePerson(phoneKey);
    const working = parseHms(sRow.workingHms);
    const idle = parseHms(sRow.idleHms);
    if (person) {
      person.acc.workingSeconds += working;
      person.acc.idleSeconds += idle;
      team.workingSeconds += working;
      team.idleSeconds += idle;
    }
    if (!input.includesWhatsApp) {
      const chk = perPhoneCheck.get(phoneKey) ?? { calls: 0, clients: new Set<string>() };
      const label = `${sRow.empName || "?"} (${phones.get(phoneKey)?.masked ?? ""})`;
      if (chk.calls !== sRow.totalCalls)
        warnings.push(`Cross-check: ${label} has ${chk.calls} call records but Callyzer summary says ${sRow.totalCalls} calls.`);
      if (chk.clients.size !== sRow.totalUniqueClients)
        warnings.push(`Cross-check: ${label} unique clients computed ${chk.clients.size}, Callyzer summary says ${sRow.totalUniqueClients}.`);
    }
  }

  // ---- Assemble ----
  const rows: PersonRow[] = [...persons.values()]
    .map((p) => {
      const m = finish(p.acc);
      return { name: p.name, phones: p.phones.size, active: m.totalCalls > 0 || m.workingSeconds > 0, ...m };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

  const footnotes: string[] = [];
  const multi = rows.filter((r) => r.phones > 1).map((r) => r.name);
  if (multi.length)
    footnotes.push(
      `Phones combined for ${listJoin(multi)}: calls, durations, working and idle hours are added across phones; each client is counted once per person.`,
    );
  footnotes.push("Connected = incoming/outgoing call longer than 2s. Team unique clients count each client once across the team.");
  if (input.includesWhatsApp) footnotes.push("Includes WhatsApp calls. Working and idle hours are from phone calls.");

  const staleCutoff = input.cutoff.getTime() - input.staleSyncMinutes * 60_000;
  const stale: string[] = [];
  for (const p of phones.values()) {
    const per = personOf(p.key);
    if (!per || !p.registered) continue;
    if (p.appUninstalled) stale.push(`${per.name} (app uninstalled)`);
    else if (p.lastSyncAt && p.lastSyncAt.getTime() < staleCutoff) stale.push(`${per.name} (last sync ${clockLabel(p.lastSyncAt, tz)})`);
  }
  if (stale.length) footnotes.push(`May be incomplete, phone not synced recently: ${listJoin([...new Set(stale)])}.`);

  const model: ReportModel = {
    title: input.title,
    dateLabel: reportDayLabel(input.cutoff, tz),
    asOfLabel: clockLabel(input.cutoff, tz),
    generatedAtLabel: clockLabel(input.generatedAt, tz),
    cutoffIso: input.cutoff.toISOString(),
    source: input.source,
    team: finish(team),
    rows,
    footnotes,
  };
  return {
    model,
    phones: [...phones.values()],
    warnings,
    stats: { records: seen.size, duplicatesDropped, phones: phones.size, persons: rows.length },
  };
}

function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
