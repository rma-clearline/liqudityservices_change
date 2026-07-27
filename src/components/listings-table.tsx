"use client";

import type { ListingRow } from "@/lib/supabase";

const DISPLAY_DAYS = 30;
const YEAR_SHIFT = 364; // 52 weeks — weekday-preserving Y/Y alignment

type Metric = "allsurplus" | "govdeals";

// Counts: zeros render as "0" (never a dash) per the listings-table spec.
const fmtCount = (v: number | null | undefined) => (v ?? 0).toLocaleString("en-US");
// Percentages: signed; a genuinely uncomputable Y/Y (no prior-year data) is "—".
const fmtPct = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${(Math.abs(v) * 100).toFixed(1)}%`);
const pctColor = (v: number | null) => (v == null ? "text-gray-400" : v >= 0 ? "text-green-600" : "text-red-600");

function shiftDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function ListingsTable({ listings }: { listings: ListingRow[] }) {
  if (listings.length === 0) {
    return <p className="text-gray-500 text-center py-8">No data yet.</p>;
  }

  // Ascending by date (source is newest-first). Full history is retained for the
  // year-ago lookups even though only the last 30 days are displayed.
  const asc = [...listings].sort((a, b) => a.date.localeCompare(b.date));
  const byDate = new Map(asc.map((r) => [r.date, r] as const));

  // Point value at a date — exact, else nearest within ±7 days (daily data can gap).
  const valueAt = (metric: Metric, target: string): number | null => {
    for (let off = 0; off <= 7; off++) {
      const before = byDate.get(off === 0 ? target : shiftDays(target, -off));
      if (before && before[metric] != null) return before[metric];
      if (off > 0) {
        const after = byDate.get(shiftDays(target, off));
        if (after && after[metric] != null) return after[metric];
      }
    }
    return null;
  };

  // Average of a metric over data points in [start, end] inclusive (listings are a
  // daily stock, so a trailing window is an average count, not a sum).
  const windowAvg = (metric: Metric, start: string, end: string): number | null => {
    let sum = 0;
    let n = 0;
    for (const r of asc) {
      if (r.date < start) continue;
      if (r.date > end) break;
      if (r[metric] != null) {
        sum += r[metric];
        n += 1;
      }
    }
    return n > 0 ? sum / n : null;
  };

  const yoy = (metric: Metric, d: string): number | null => {
    const cur = byDate.get(d)?.[metric] ?? null;
    const prev = valueAt(metric, shiftDays(d, -YEAR_SHIFT));
    return cur != null && prev != null && prev > 0 ? cur / prev - 1 : null;
  };
  const trailingYoy = (metric: Metric, d: string, win: number): number | null => {
    const now = windowAvg(metric, shiftDays(d, -(win - 1)), d);
    const ly = windowAvg(metric, shiftDays(d, -(win - 1) - YEAR_SHIFT), shiftDays(d, -YEAR_SHIFT));
    return now != null && ly != null && ly > 0 ? now / ly - 1 : null;
  };

  // Last 30 calendar days, ending at the newest data date; oldest at top.
  const newest = asc[asc.length - 1].date;
  const cutoff = shiftDays(newest, -(DISPLAY_DAYS - 1));
  const rows = asc.filter((r) => r.date >= cutoff);

  const asHead = "text-blue-600";
  const gdHead = "text-green-700";

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left align-bottom">
            <th rowSpan={2} className="py-2 pr-4 font-semibold">Date</th>
            <th rowSpan={2} className="py-2 pr-4 font-semibold">Time (ET)</th>
            <th rowSpan={2} className="py-2 pr-4 font-semibold text-right">AllSurplus</th>
            <th rowSpan={2} className="py-2 pr-6 font-semibold text-right">GovDeals</th>
            <th colSpan={2} className="py-2 px-2 font-semibold text-center border-l">Y/Y %</th>
            <th colSpan={2} className="py-2 px-2 font-semibold text-center border-l">Trailing 7D Y/Y %</th>
            <th colSpan={2} className="py-2 px-2 font-semibold text-center border-l">Trailing 30D Y/Y %</th>
          </tr>
          <tr className="border-b text-xs">
            <th className={`py-1 px-2 text-right border-l ${asHead}`}>AS</th>
            <th className={`py-1 px-2 text-right ${gdHead}`}>GD</th>
            <th className={`py-1 px-2 text-right border-l ${asHead}`}>AS</th>
            <th className={`py-1 px-2 text-right ${gdHead}`}>GD</th>
            <th className={`py-1 px-2 text-right border-l ${asHead}`}>AS</th>
            <th className={`py-1 px-2 text-right ${gdHead}`}>GD</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const asYoY = yoy("allsurplus", row.date);
            const gdYoY = yoy("govdeals", row.date);
            const as7 = trailingYoy("allsurplus", row.date, 7);
            const gd7 = trailingYoy("govdeals", row.date, 7);
            const as30 = trailingYoy("allsurplus", row.date, 30);
            const gd30 = trailingYoy("govdeals", row.date, 30);
            return (
              <tr key={row.id} className="border-b border-gray-100">
                <td className="py-2 pr-4 whitespace-nowrap">{row.date}</td>
                <td className="py-2 pr-4 whitespace-nowrap">{row.timestamp}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{fmtCount(row.allsurplus)}</td>
                <td className="py-2 pr-6 text-right tabular-nums">{fmtCount(row.govdeals)}</td>
                <td className={`py-2 px-2 text-right tabular-nums border-l ${pctColor(asYoY)}`}>{fmtPct(asYoY)}</td>
                <td className={`py-2 px-2 text-right tabular-nums ${pctColor(gdYoY)}`}>{fmtPct(gdYoY)}</td>
                <td className={`py-2 px-2 text-right tabular-nums border-l ${pctColor(as7)}`}>{fmtPct(as7)}</td>
                <td className={`py-2 px-2 text-right tabular-nums ${pctColor(gd7)}`}>{fmtPct(gd7)}</td>
                <td className={`py-2 px-2 text-right tabular-nums border-l ${pctColor(as30)}`}>{fmtPct(as30)}</td>
                <td className={`py-2 px-2 text-right tabular-nums ${pctColor(gd30)}`}>{fmtPct(gd30)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
