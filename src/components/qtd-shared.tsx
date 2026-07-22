"use client";

// React primitives for the QTD page (StatCard, MetricsTable). The pure helpers
// (fmtM, fmtPct, quarterDayKeys, priorYearQuarter, addDaysKey, cumulate) and the
// MCol type live in src/lib/qtd-shared.ts so they can also run in Node (the cron
// report email); they're re-exported here so existing client imports keep working.

import { Fragment, type ReactNode } from "react";
import { fmtPct, type MCol } from "@/lib/qtd-shared";

export { fmtM, fmtPct, quarterDayKeys, priorYearQuarter, addDaysKey, cumulate, type MCol } from "@/lib/qtd-shared";

export function StatCard({ label, value, sub, strong }: { label: string; value: ReactNode; sub?: ReactNode; strong?: boolean }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-gray-500 mb-0.5">{label}</p>
      <p className={`tabular-nums ${strong ? "text-xl font-bold text-gray-900" : "text-lg font-semibold text-gray-800"}`}>{value}</p>
      {sub && <div className="mt-0.5 text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

export function MetricsTable({
  groups,
  scale,
  scaled,
}: {
  groups: { name: string; cols: MCol[] }[];
  scale: number;
  scaled: boolean;
}) {
  const shown = groups.filter((g) => g.cols.length > 0);
  if (shown.length === 0) return null;
  return (
    <div className="rounded-lg border">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b-2 border-gray-300 text-left">
            <th className="px-2.5 py-1 font-semibold text-gray-600">Period</th>
            <th className="px-2.5 py-1 text-right font-semibold text-gray-600">USDmm</th>
            <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Y/Y</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((g) => (
            <Fragment key={g.name}>
              {shown.length > 1 && (
                <tr className="border-b bg-gray-50/60">
                  <td colSpan={3} className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                    {g.name}
                  </td>
                </tr>
              )}
              {g.cols.map((c) => {
                // Captured-vs-captured Y/Y when LY daily data exists; in scaled mode
                // fall back to scaled-vs-LY-REPORTED (marked *).
                const direct = c.yoy;
                const derived =
                  direct == null && scaled && !c.total && c.lyReported ? (c.nominal * scale) / c.lyReported - 1 : null;
                const v = direct ?? derived;
                return (
                  <tr key={c.key} className={`border-b border-gray-100 ${c.hl ? "bg-blue-50" : ""}`}>
                    <td className="whitespace-nowrap px-2.5 py-1 font-medium text-gray-700">
                      {c.top}
                      {c.sub && <span className="ml-1 text-[10px] font-normal text-gray-400">{c.sub}</span>}
                    </td>
                    <td className="px-2.5 py-1 text-right tabular-nums font-semibold text-gray-900">
                      {((c.total ? c.nominal : c.nominal * scale) / 1e6).toFixed(1)}
                    </td>
                    <td className="px-2.5 py-1 text-right tabular-nums">
                      {v == null ? (
                        <span className="text-gray-300">—</span>
                      ) : (
                        <span className={v >= 0 ? "text-green-600" : "text-red-600"}>
                          {fmtPct(v)}
                          {derived != null && <span className="text-gray-400">*</span>}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
