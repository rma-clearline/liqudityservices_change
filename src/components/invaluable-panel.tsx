"use client";

import { useEffect, useState } from "react";
import type { InvaluablePeriod } from "@/app/api/invaluable/route";

type Payload = { month: InvaluablePeriod[]; quarter: InvaluablePeriod[]; houses: string[] };

const fmtM = (n: number) => "$" + (n / 1e6).toFixed(2) + "M";
const fmtPct = (n: number | null) => (n == null ? "—" : (n * 100).toFixed(1) + "%");

/** Invaluable panel GMS proxy: a panel of auction houses' hosted catalogs, with each
 *  lot's online win inferred from the platform's top online bid. Online-won hammer is
 *  Invaluable's GMS definition; it enters LQDT's reported GMV from FY27 Q1. */
export function InvaluablePanel() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grain, setGrain] = useState<"quarter" | "month">("quarter");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/invaluable")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
        return d as Payload;
      })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <p className="mt-8 text-sm text-red-600">Invaluable panel unavailable: {error}</p>;
  if (!data) return <p className="mt-8 text-sm text-gray-500">Loading Invaluable panel…</p>;
  const rows = data[grain];
  if (rows.length === 0) return null;
  const byPeriod = new Map(rows.map((r) => [r.period, r]));
  const prior = (p: string) => String(Number(p.slice(0, 4)) - 1) + p.slice(4);
  const chip = (active: boolean) =>
    "px-2 py-0.5 text-xs rounded border transition-colors " +
    (active ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-600 border-gray-300 hover:border-gray-400");

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-gray-900">Invaluable panel — GMS proxy</h2>
        <div className="flex gap-1">
          {(["quarter", "month"] as const).map((g) => (
            <button key={g} onClick={() => setGrain(g)} className={chip(grain === g)}>
              {g === "quarter" ? "Quarters" : "Months"}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-xs text-gray-500">
        {data.houses.length} house{data.houses.length === 1 ? "" : "s"} ({data.houses.join(", ")}) · hosted-catalog hammer in USD, with each lot&rsquo;s
        platform win inferred from the top online bid (that online-won hammer is Invaluable&rsquo;s GMS). A growth index until the panel is
        wide enough and validated against disclosed GMS; the platform-wide share of gavel was 14.7% in Q1 2026.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b text-gray-600">
              <th className="px-2 py-1 text-left font-semibold">Period</th>
              <th className="px-2 py-1 text-right font-semibold">Houses</th>
              <th className="px-2 py-1 text-right font-semibold">Sold lots</th>
              <th className="px-2 py-1 text-right font-semibold" title="Total hammer of the panel's catalogs">Hammer</th>
              <th className="px-2 py-1 text-right font-semibold" title="Hammer of lots inferred as won through the platform">Online-won</th>
              <th className="px-2 py-1 text-right font-semibold" title="Online-won ÷ hammer (Invaluable's share of gavel)">Share</th>
              <th className="px-2 py-1 text-right font-semibold" title="Timed (online-only) sales as a share of hammer">Timed</th>
              <th className="px-2 py-1 text-right font-semibold">Hammer Y/Y</th>
              <th className="px-2 py-1 text-right font-semibold">Online-won Y/Y</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const p = byPeriod.get(prior(r.period));
              const hy = p && p.thv_usd > 0 ? r.thv_usd / p.thv_usd - 1 : null;
              const oy = p && p.online_usd > 0 ? r.online_usd / p.online_usd - 1 : null;
              const tone = (v: number | null) => (v == null ? "text-gray-300" : v >= 0 ? "text-green-700" : "text-red-700");
              return (
                <tr key={r.period} className="border-b border-gray-100">
                  <td className="px-2 py-1 font-medium text-gray-700">{r.period}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{r.houses}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{r.sold}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtM(r.thv_usd)}</td>
                  <td className="px-2 py-1 text-right tabular-nums font-semibold">{fmtM(r.online_usd)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtPct(r.thv_usd > 0 ? r.online_usd / r.thv_usd : null)}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-gray-500">{fmtPct(r.thv_usd > 0 ? r.timed_usd / r.thv_usd : null)}</td>
                  <td className={"px-2 py-1 text-right tabular-nums " + tone(hy)}>{fmtPct(hy)}</td>
                  <td className={"px-2 py-1 text-right tabular-nums " + tone(oy)}>{fmtPct(oy)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
