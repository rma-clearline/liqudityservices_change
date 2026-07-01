// Shared Eastern-time date helpers.
//
// The whole app buckets auction activity by the America/New_York calendar day
// (matching the `auction_daily_stats` SQL view and the LS marketplace's own
// clock). These helpers were previously duplicated — and had drifted — across
// auctions.ts, historical-sales.ts, and scripts/fetch-historical-gmv.mjs.
// This is the single source of truth for server-side (Node) code.

const ET_TIME_ZONE = "America/New_York";

/** Convert a UTC ISO timestamp to a YYYY-MM-DD date key in America/New_York. */
export function etDateKey(iso: string): string {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ET_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const d = parts.find((p) => p.type === "day")?.value ?? "";
  if (!y || !m || !d) return "";
  return `${y}-${m}-${d}`;
}

/**
 * Quarter bounds for the ET calendar date of `d`.
 * Using UTC here flipped the quarter ~4-5h early at the boundary, so on the
 * evening of the last day of a quarter (ET) the dashboard jumped to the next
 * quarter — which has no data yet — and showed all zeros.
 */
export function quarterBounds(d: Date): { start: Date; end: Date; label: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ET_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(d);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value); // 1-based
  const q = Math.floor((month - 1) / 3);
  const start = new Date(Date.UTC(y, q * 3, 1));
  const end = new Date(Date.UTC(y, q * 3 + 3, 1));
  return { start, end, label: `${y}Q${q + 1}` };
}

/** Enumerate YYYY-MM-DD keys from `start` (inclusive) to `end` (exclusive). */
export function enumerateDays(start: Date, end: Date): string[] {
  const days: string[] = [];
  const cursor = new Date(start);
  while (cursor < end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** Parse a YYYY-MM-DD key into a UTC midnight Date (null if malformed). */
export function dateKeyToUtcDate(dateKey: string): Date | null {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

export function formatPartsInEt(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
  };
}

/** Convert a wall-clock ET date+time to the corresponding UTC epoch ms. */
export function localEtToUtcMs(
  date: string,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): number {
  const [year, month, day] = date.split("-").map(Number);
  const targetLocalMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  let utcMs = targetLocalMs + 5 * 60 * 60 * 1000;

  for (let i = 0; i < 3; i += 1) {
    const parts = formatPartsInEt(new Date(utcMs));
    const renderedLocalMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
    utcMs += targetLocalMs - renderedLocalMs;
  }

  return utcMs;
}

/** The YYYY-MM-DD ET day after `date`. */
export function nextDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + 1));
  return d.toISOString().slice(0, 10);
}

/** UTC ISO start/end covering a full ET calendar day. */
export function dateRangeForEtDay(date: string): { fromDate: string; toDate: string } {
  const startMs = localEtToUtcMs(date, 0, 0, 0, 0);
  const endMs = localEtToUtcMs(nextDate(date), 0, 0, 0, 0) - 1;
  return {
    fromDate: new Date(startMs).toISOString(),
    toDate: new Date(endMs).toISOString(),
  };
}

/** Today's YYYY-MM-DD key in America/New_York. */
export function etTodayKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ET_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
