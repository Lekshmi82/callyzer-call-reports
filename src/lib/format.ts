/** Human-readable durations matching the reference report: "2h 30m 25s", "43m 26s", "0m 46s". */
export function formatDuration(totalSeconds: number, opts: { seconds?: boolean } = {}): string {
  const withSeconds = opts.seconds ?? true;
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (!withSeconds) return h > 0 ? `${h}h ${m}m` : `${m}m`;
  return h > 0 ? `${h}h ${m}m ${sec}s` : `${m}m ${sec}s`;
}

/** Parses Callyzer "HH:mm:ss" (hours may exceed 24) into seconds. Returns 0 for empty/invalid. */
export function parseHms(value: string | null | undefined): number {
  if (!value) return 0;
  const m = /^(\d+):(\d{1,2}):(\d{1,2})$/.exec(value.trim());
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/** Shows only the last 4 digits: "••••3210". */
export function maskNumber(digits: string): string {
  const d = digits.replace(/\D/g, "");
  return d.length <= 4 ? "••••" : `••••${d.slice(-4)}`;
}

/** Recipient phone validation/normalisation: digits only, with country code, no '+'. */
export function normaliseRecipientPhone(input: string): string | null {
  const d = input.replace(/[\s\-()+]/g, "");
  if (!/^\d{10,15}$/.test(d)) return null;
  if (d.length === 10) return null; // country code required
  return d;
}
