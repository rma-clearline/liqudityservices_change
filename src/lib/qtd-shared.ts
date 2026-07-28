// Pure QTD helpers — formatting + fiscal-quarter day math. No React/DOM, so these
// run in Node (the cron report email) as well as in the client components. The
// React primitives (StatCard, MetricsTable) live in components/qtd-shared.tsx,
// which re-exports these for existing client imports.

import { parseQuarterLabel } from "@/lib/time";

export const fmtM = (v: number) => `$${(v / 1e6).toFixed(1)}M`;
export const fmtPct = (v: number, digits = 1) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;

/** YYYY-MM-DD keys of every day in the calendar quarter `label` (chronological). */
export function quarterDayKeys(label: string): string[] {
  const q = parseQuarterLabel(label);
  if (!q) return [];
  const keys: string[] = [];
  const cursor = new Date(q.start);
  while (cursor < q.end) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

export const priorYearQuarter = (label: string) => `${Number(label.slice(0, 4)) - 1}${label.slice(4)}`;

export const addDaysKey = (key: string, n: number) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

export function cumulate(dayKeys: string[], byDate: Map<string, number>): number[] {
  let run = 0;
  return dayKeys.map((k) => {
    run += byDate.get(k) ?? 0;
    return run;
  });
}

/** One column of the Yipit-style key-metrics tables. `nominal` is captured-basis
 *  unless `total` (guidance/Clearline/reported — total-company $, never scaled).
 *  `lyReported`: LY reported total, enabling a scaled-vs-reported Y/Y fallback. */
export type MCol = {
  key: string;
  top: string;
  sub?: string;
  nominal: number;
  yoy: number | null;
  lyReported?: number | null;
  hl?: boolean;
  total?: boolean;
  // Cumulative quarter-to-date Y/Y as it stood at this period's END (resets each
  // fiscal quarter). Presence of this field (even null) makes MetricsTable render a
  // "QTD Y/Y as of" column — so only the Months/T7D trend tables opt in.
  qtdYoy?: number | null;
  // Multi-year annualized growth vs the same window N years earlier: [2Y, 3Y, 4Y].
  // A horizon column renders only if some row has a non-null value ("as available").
  cagr?: (number | null)[];
};
