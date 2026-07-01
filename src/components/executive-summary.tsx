"use client";

import { useEffect, useState } from "react";
import { fmtDollar, fmtNum } from "@/lib/format";
import { useDataStatus } from "./freshness";

type PlatformForecast = {
  platform: "AD" | "GD";
  realized_gmv_usd: number;
  realized_revenue_usd: number;
  auctions_sold: number;
  projected_remaining_gmv_usd: number;
};

type Forecast = {
  quarter: string;
  take_rate: number;
  platforms: PlatformForecast[];
  projected_total_gmv_usd: number;
  projected_total_revenue_usd: number;
};

function SummaryCard({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${strong ? "bg-gray-900 text-white border-gray-900" : "bg-white"}`}>
      <p className={`text-xs mb-1 ${strong ? "text-gray-300" : "text-gray-500"}`}>{label}</p>
      <p className="text-2xl font-bold tabular-nums">{value}</p>
      {sub && <p className={`text-xs mt-0.5 ${strong ? "text-gray-400" : "text-gray-400"}`}>{sub}</p>}
    </div>
  );
}

/**
 * Top-of-page reconciliation panel: realized quarter-to-date GMV, remaining
 * projection, and the resulting total, in one place — future_improvements.md
 * "Add a reconciliation view".
 */
export function ExecutiveSummary() {
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = useDataStatus();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/forecast?takeRate=0.2")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setForecast(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return null;
  if (!forecast) {
    return <div className="mb-8 rounded-lg border p-4 text-sm text-gray-500">Loading quarter summary…</div>;
  }

  const realizedGmv = forecast.platforms.reduce((s, p) => s + p.realized_gmv_usd, 0);
  const realizedRev = forecast.platforms.reduce((s, p) => s + p.realized_revenue_usd, 0);
  const remainingGmv = forecast.platforms.reduce((s, p) => s + p.projected_remaining_gmv_usd, 0);
  const soldLots = forecast.platforms.reduce((s, p) => s + p.auctions_sold, 0);
  const auctionsAge = status?.tables?.auctions ?? null;
  const cronFailed = status?.cron?.last_run_status === "failed";

  return (
    <section id="summary" className="mb-8 scroll-mt-20">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">
          Quarter Summary <span className="text-gray-400 font-normal">· {forecast.quarter}</span>
        </h2>
        <p className="text-xs text-gray-400">
          Realized + projected-remaining = total. Revenue at {(forecast.take_rate * 100).toFixed(0)}% take rate.
          {auctionsAge ? ` Auctions data ${auctionsAge.slice(0, 10)}.` : ""}
          {cronFailed ? " ⚠ last cron run failed." : ""}
        </p>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <SummaryCard label="Realized GMV (QTD)" value={fmtDollar(realizedGmv)} sub={`${fmtNum(soldLots)} sold lots`} />
        <SummaryCard label="Projected Remaining GMV" value={fmtDollar(remainingGmv)} sub="open auctions" />
        <SummaryCard label={`Projected ${forecast.quarter} GMV`} value={fmtDollar(forecast.projected_total_gmv_usd)} sub="realized + remaining" />
        <SummaryCard label="Realized Revenue (QTD)" value={fmtDollar(realizedRev)} />
        <SummaryCard label={`Projected ${forecast.quarter} Revenue`} value={fmtDollar(forecast.projected_total_revenue_usd)} strong />
      </div>
    </section>
  );
}
