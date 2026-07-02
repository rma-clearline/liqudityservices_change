"use client";

import { useMemo, useState } from "react";
import type { MarketplaceSellerRow } from "@/lib/supabase";
import {
  aggregateByLevel,
  classifySellerLevel,
  GOV_LEVEL_LABELS,
  GOV_LEVELS,
  type GovLevel,
} from "@/lib/gov-seller";
import { siteLabel } from "@/lib/sites";
import { ExportButton } from "./export-button";

function fmtDollar(n: number | null | undefined) {
  if (n == null) return "—";
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(0) + "k";
  return "$" + n.toFixed(0);
}

type Filter = GovLevel | "all";

const LEVEL_STYLE: Record<GovLevel, string> = {
  federal: "bg-indigo-100 text-indigo-700",
  state: "bg-blue-100 text-blue-700",
  local: "bg-emerald-100 text-emerald-700",
  commercial: "bg-gray-100 text-gray-600",
};

export function GovernmentSellers({
  sellers,
  snapshotDate,
}: {
  sellers: MarketplaceSellerRow[];
  snapshotDate: string | null;
}) {
  const [filter, setFilter] = useState<Filter>("all");

  const stats = useMemo(() => aggregateByLevel(sellers), [sellers]);
  const govGmv = useMemo(
    () => stats.filter((s) => s.level !== "commercial").reduce((sum, s) => sum + s.gmv_proxy, 0),
    [stats],
  );
  const totalGmv = useMemo(() => stats.reduce((sum, s) => sum + s.gmv_proxy, 0), [stats]);

  const withLevel = useMemo(
    () => sellers.map((s) => ({ ...s, level: classifySellerLevel(s.company_name) })),
    [sellers],
  );

  const filtered = useMemo(() => {
    const rows = filter === "all" ? withLevel : withLevel.filter((s) => s.level === filter);
    return [...rows].sort((a, b) => (b.total_current_bid ?? 0) - (a.total_current_bid ?? 0));
  }, [withLevel, filter]);

  if (sellers.length === 0) {
    return (
      <p className="text-gray-500 text-sm">
        No seller data yet. This populates from the marketplace snapshot after the next cron run.
      </p>
    );
  }

  const countFor = (f: Filter) =>
    f === "all" ? sellers.length : stats.find((s) => s.level === f)?.seller_count ?? 0;

  return (
    <div className="space-y-5">
      <p className="text-xs text-gray-500 max-w-3xl">
        Government-surplus seller mix from the latest marketplace snapshot
        {snapshotDate ? ` (${snapshotDate})` : ""}. Level is inferred from the seller name (heuristic).
        Government sellers = {fmtDollar(govGmv)} of {fmtDollar(totalGmv)} current-bid GMV proxy
        {totalGmv > 0 ? ` (${Math.round((govGmv / totalGmv) * 100)}%)` : ""}.
      </p>

      {/* Per-level summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {stats.map((s) => (
          <button
            key={s.level}
            type="button"
            onClick={() => setFilter(filter === s.level ? "all" : s.level)}
            className={`rounded-lg border p-3 text-left transition ${
              filter === s.level ? "border-gray-800 ring-1 ring-gray-800" : "hover:border-gray-400"
            }`}
          >
            <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${LEVEL_STYLE[s.level]}`}>
              {GOV_LEVEL_LABELS[s.level]}
            </span>
            <p className="mt-2 text-xl font-bold tabular-nums">{s.seller_count}</p>
            <p className="text-xs text-gray-500">
              {s.listing_count.toLocaleString()} listings · {fmtDollar(s.gmv_proxy)}
              {" · "}
              {Math.round(s.gmv_share * 100)}%
            </p>
          </button>
        ))}
      </div>

      {/* Filter chips + export */}
      <div className="flex flex-wrap items-center gap-2">
        {(["all", ...GOV_LEVELS] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`rounded-full border px-3 py-1 text-xs ${
              filter === f ? "border-gray-800 bg-gray-800 text-white" : "border-gray-300 text-gray-700 hover:bg-gray-50"
            }`}
          >
            {f === "all" ? "All" : GOV_LEVEL_LABELS[f]} ({countFor(f)})
          </button>
        ))}
        <div className="ml-auto">
          <ExportButton
            rows={filtered}
            filename={`lqdt-government-sellers-${filter}.csv`}
            columns={[
              { key: "date", label: "Snapshot" },
              { key: "platform", label: "Platform" },
              { key: "level", label: "Gov Level" },
              { key: "company_name", label: "Seller" },
              { key: "state", label: "State" },
              { key: "country", label: "Country" },
              { key: "listing_count", label: "Listings" },
              { key: "total_current_bid", label: "GMV Proxy USD" },
            ]}
          />
        </div>
      </div>

      {/* Seller table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b-2 border-gray-300">
              <th className="py-1.5 pr-4 text-left">Seller</th>
              <th className="py-1.5 pr-4 text-left">Level</th>
              <th className="py-1.5 pr-4 text-left">Platform</th>
              <th className="py-1.5 pr-4 text-left">Location</th>
              <th className="py-1.5 pr-4 text-right">Listings</th>
              <th className="py-1.5 text-right">GMV Proxy</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 25).map((s) => (
              <tr key={`${s.platform}-${s.account_id}`} className="border-b border-gray-100">
                <td className="py-1 pr-4 truncate max-w-[280px]">{s.company_name || `Seller #${s.account_id}`}</td>
                <td className="py-1 pr-4">
                  <span className={`inline-block rounded px-1.5 py-0.5 text-xs ${LEVEL_STYLE[s.level]}`}>
                    {GOV_LEVEL_LABELS[s.level]}
                  </span>
                </td>
                <td className="py-1 pr-4 text-gray-500">{siteLabel(s.platform)}</td>
                <td className="py-1 pr-4 text-gray-500 whitespace-nowrap">
                  {[s.state, s.country].filter(Boolean).join(", ") || "—"}
                </td>
                <td className="py-1 pr-4 text-right tabular-nums">{s.listing_count ?? 0}</td>
                <td className="py-1 text-right tabular-nums">{fmtDollar(s.total_current_bid)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.length > 25 && (
        <p className="text-xs text-gray-400">Showing top 25 of {filtered.length} by GMV proxy — export for the full list.</p>
      )}
    </div>
  );
}
