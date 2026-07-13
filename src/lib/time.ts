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

/**
 * Parse a "YYYYQn" label (e.g. "2026Q3") into UTC quarter bounds.
 * Uses fixed UTC month boundaries — the label already names the quarter, so no
 * timezone inference is needed (unlike quarterBounds, which derives it from a
 * timestamp). Returns null for malformed labels.
 */
export function parseQuarterLabel(label: string): { start: Date; end: Date; label: string } | null {
  const m = /^(\d{4})Q([1-4])$/.exec(label.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const q = Number(m[2]) - 1; // 0-based
  const start = new Date(Date.UTC(y, q * 3, 1));
  const end = new Date(Date.UTC(y, q * 3 + 3, 1));
  return { start, end, label: `${y}Q${q + 1}` };
}

/**
 * All quarter labels from `startLabel` to `endLabel` inclusive (chronological).
 * Pure integer math on year/quarter — no timezone edge cases.
 */
export function enumerateQuarterLabelsBetween(startLabel: string, endLabel: string): string[] {
  const s = parseQuarterLabel(startLabel);
  const e = parseQuarterLabel(endLabel);
  if (!s || !e) return [];
  let y = s.start.getUTCFullYear();
  let qi = s.start.getUTCMonth() / 3; // 0-3 (month is q*3)
  const endY = e.start.getUTCFullYear();
  const endQi = e.start.getUTCMonth() / 3;
  const labels: string[] = [];
  while (y < endY || (y === endY && qi <= endQi)) {
    labels.push(`${y}Q${qi + 1}`);
    qi += 1;
    if (qi > 3) {
      qi = 0;
      y += 1;
    }
  }
  return labels;
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

/**
 * ISO-week-start (Monday) key for a YYYY-MM-DD date, as YYYY-MM-DD.
 * The input is already an ET calendar day, so we treat it as a UTC midnight
 * date and walk back to Monday — consistent bucketing without TZ edge cases.
 * Shared by the forecast granularity toggle and the pivot export's week grouping.
 */
export function etWeekKey(dateKey: string): string {
  const d = dateKeyToUtcDate(dateKey);
  if (!d) return dateKey;
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const backToMonday = (dow + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - backToMonday);
  return d.toISOString().slice(0, 10);
}

/** Month key (YYYY-MM) for a YYYY-MM-DD date. */
export function etMonthKey(dateKey: string): string {
  return dateKey.slice(0, 7);
}

/** Quarter label (YYYYQn) for a YYYY-MM-DD date. */
export function etQuarterKey(dateKey: string): string {
  const [year, month] = dateKey.split("-").map(Number);
  if (!year || !month) return dateKey;
  const q = Math.floor((month - 1) / 3) + 1;
  return `${year}Q${q}`;
}

// --- LQDT fiscal-quarter display -------------------------------------------
//
// The internal quarter keys ("YYYYQn") the app buckets/queries by are always
// CALENDAR quarters. LQDT itself reports on a fiscal year that ENDS Sep 30
// (FQ4 ends 9/30), i.e. FY{n} runs Oct 1 {n-1} -> Sep 30 {n}. So a calendar
// quarter maps to an LQDT fiscal quarter one step ahead, and Oct-Dec rolls into
// the NEXT fiscal year:
//   CY Q1 (Jan-Mar) -> FQ2      CY Q2 (Apr-Jun) -> FQ3
//   CY Q3 (Jul-Sep) -> FQ4      CY Q4 (Oct-Dec) -> FQ1 of FY+1
// These helpers are DISPLAY-ONLY — they never feed data keys, API params, or
// snapshot PKs (which stay calendar "YYYYQn").

/** Map a calendar quarter (year, 1-4) to LQDT's fiscal { fy, fq } (FY ends 9/30). */
export function lqdtFiscalQuarter(calYear: number, calQuarter: number): { fy: number; fq: number } {
  const fq = (calQuarter % 4) + 1; // Q1->2, Q2->3, Q3->4, Q4->1
  const fy = calQuarter === 4 ? calYear + 1 : calYear;
  return { fy, fq };
}

const QUARTER_KEY_RE = /^(\d{4})Q([1-4])$/;

/**
 * Format a calendar "YYYYQn" quarter key for display, disambiguating the
 * calendar quarter from LQDT's fiscal quarter. Non-quarter strings (month keys
 * "YYYY-MM", "ALL", date ranges) pass through unchanged so callers can format a
 * mixed period column safely.
 *   "2026Q3" -> "26CQ3 / (26FQ4)"   (dual, default)
 *   "2026Q3" -> "26CQ3"             (variant "cy")
 *   "2026Q3" -> "26FQ4"             (variant "fq")
 */
export function formatQuarterLabel(key: string, variant: "dual" | "cy" | "fq" = "dual"): string {
  const m = QUARTER_KEY_RE.exec(key.trim());
  if (!m) return key;
  const cy = Number(m[1]);
  const cq = Number(m[2]);
  const { fy, fq } = lqdtFiscalQuarter(cy, cq);
  const cyLabel = `${String(cy).slice(-2)}CQ${cq}`;
  const fqLabel = `${String(fy).slice(-2)}FQ${fq}`;
  if (variant === "cy") return cyLabel;
  if (variant === "fq") return fqLabel;
  return `${cyLabel} / (${fqLabel})`;
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
