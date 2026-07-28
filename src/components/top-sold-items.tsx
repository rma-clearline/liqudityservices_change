"use client";

import { useMemo, useState } from "react";
import type { EnrichedLot } from "@/lib/asset-fees";
import type { BlendedAdminFee } from "@/lib/dashboard-data";
import { ExportButton } from "./export-button";

type Marketplace = "AD" | "GD" | "GI";
const MKT_LABEL: Record<Marketplace, string> = { AD: "AllSurplus", GD: "GovDeals", GI: "Industrial" };
const MKT_COLOR: Record<Marketplace, string> = {
  AD: "bg-blue-50 text-blue-700 border-blue-200",
  GD: "bg-green-50 text-green-700 border-green-200",
  GI: "bg-purple-50 text-purple-700 border-purple-200",
};
function mkt(site: string): Marketplace {
  return site === "AD" || site === "GD" || site === "GI" ? site : "GI";
}

function fmtDollar(n: number) {
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(0) + "k";
  return "$" + n.toFixed(0);
}

function safeHttpUrl(u: string | null): string | null {
  if (!u) return null;
  return /^https?:\/\//i.test(u) ? u : null;
}

export function TopSoldItems({
  rows,
  total,
  blended,
  minUsd,
}: {
  rows: EnrichedLot[];
  total: number;
  blended: BlendedAdminFee | null;
  minUsd: number;
}) {
  const [filter, setFilter] = useState<"all" | Marketplace>("all");
  const [query, setQuery] = useState("");

  const counts = useMemo(() => {
    const c = { all: rows.length, AD: 0, GD: 0, GI: 0 };
    for (const r of rows) c[mkt(r.site)]++;
    return c;
  }, [rows]);

  const view = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => filter === "all" || mkt(r.site) === filter)
      .filter((r) => !q || r.title.toLowerCase().includes(q) || r.seller.toLowerCase().includes(q));
  }, [rows, filter, query]);

  // Export mirrors what's on screen (the active filter + search), so a filtered
  // export doesn't silently include rows the user filtered out.
  const exportRows = useMemo(
    () =>
      view.map((r) => ({
        close_date_et: r.close_date_et,
        marketplace: MKT_LABEL[mkt(r.site)],
        title: r.title,
        seller: r.seller,
        category: r.category,
        state: r.state,
        sale_amount_usd: r.sale_amount_usd,
        buyer_premium_pct: r.buyer_premium_percent,
        admin_fee_pct: r.admin_fee_percent,
        watches: r.watch_count,
        visitors: r.visitors,
        url: r.url ?? "",
      })),
    [view],
  );

  if (rows.length === 0) {
    return <p className="text-gray-500 text-sm">No sold lots ≥ {fmtDollar(minUsd)} this quarter yet.</p>;
  }

  const filters: { key: "all" | Marketplace; label: string }[] = [
    { key: "all", label: `All (${counts.all})` },
    { key: "AD", label: `AllSurplus (${counts.AD})` },
    { key: "GD", label: `GovDeals (${counts.GD})` },
    { key: "GI", label: `Industrial (${counts.GI})` },
  ];

  const coverage = blended && blended.total_gmv > 0 ? blended.covered_gmv / blended.total_gmv : 0;
  const premCoverage = blended && blended.total_gmv > 0 ? blended.premium_covered_gmv / blended.total_gmv : 0;
  // Assemble only the fees that are actually covered, so a missing one doesn't render a
  // stray "— +" (premium and admin-fee coverage populate independently as the cron runs).
  const blendedParts: string[] = [];
  if (blended?.premium_pct != null) blendedParts.push(`${blended.premium_pct.toFixed(2)}% buyer premium`);
  if (blended?.blended_pct != null) blendedParts.push(`${blended.blended_pct.toFixed(2)}% seller admin fee`);
  const covPct = Math.max(coverage, premCoverage);

  return (
    <div className="space-y-3">
      {blended && blendedParts.length > 0 && covPct > 0 ? (
        <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm">
          <span className="font-semibold">QTD blended take: {blendedParts.join(" + ")}</span>
          <span className="text-gray-500">
            {" "}
            · GMV-weighted across sold lots with known fees ({(covPct * 100).toFixed(0)}% of QTD GMV covered).{" "}
            {blendedParts.length > 1 ? "Both read" : "Read"} live per lot from the marketplace bid box.
          </span>
        </div>
      ) : (
        <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
          Blended take: building coverage — per-seller fees populate as the daily job runs.
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                filter === f.key ? "border-gray-800 bg-gray-800 text-white" : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              {f.label}
            </button>
          ))}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter items…"
            className="ml-1 w-40 rounded-md border border-gray-300 px-2.5 py-1 text-xs focus:border-gray-500 focus:outline-none"
          />
        </div>
        <ExportButton
          rows={exportRows}
          filename="lqdt-top-sold-items.csv"
          columns={[
            { key: "close_date_et", label: "Close Date" },
            { key: "marketplace", label: "Marketplace" },
            { key: "title", label: "Item" },
            { key: "seller", label: "Seller" },
            { key: "category", label: "Category" },
            { key: "state", label: "State" },
            { key: "sale_amount_usd", label: "Sale USD" },
            { key: "buyer_premium_pct", label: "Buyer Premium %" },
            { key: "admin_fee_pct", label: "Admin Fee %" },
            { key: "watches", label: "Watches" },
            { key: "visitors", label: "Visitors" },
            { key: "url", label: "URL" },
          ]}
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b-2 border-gray-300">
              <th className="py-1.5 pr-4 text-left">Item</th>
              <th className="py-1.5 pr-4 text-left">Marketplace</th>
              <th className="py-1.5 pr-4 text-left">Seller</th>
              <th className="py-1.5 pr-4 text-left">Closed</th>
              <th className="py-1.5 pr-4 text-right">Sale (USD)</th>
              <th className="py-1.5 pr-4 text-right">Buyer Prem %</th>
              <th className="py-1.5 pr-4 text-right">Admin Fee %</th>
              <th className="py-1.5 pr-4 text-right">Watches</th>
              <th className="py-1.5 text-right">Visitors</th>
            </tr>
          </thead>
          <tbody>
            {view.map((r, i) => {
              const m = mkt(r.site);
              return (
                <tr key={`${r.asset_id}:${r.account_id}:${i}`} className="border-b border-gray-100">
                  <td className="py-1 pr-4 max-w-[300px] truncate">
                    {safeHttpUrl(r.url) ? (
                      <a href={safeHttpUrl(r.url) as string} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                        {r.title || "Untitled lot"}
                      </a>
                    ) : (
                      r.title || "Untitled lot"
                    )}
                  </td>
                  <td className="py-1 pr-4">
                    <span className={`inline-block rounded border px-1.5 py-0.5 text-xs ${MKT_COLOR[m]}`}>{MKT_LABEL[m]}</span>
                  </td>
                  <td className="py-1 pr-4 text-gray-600 max-w-[180px] truncate">{r.seller}</td>
                  <td className="py-1 pr-4 text-gray-500 whitespace-nowrap tabular-nums">{r.close_date_et}</td>
                  <td className="py-1 pr-4 text-right tabular-nums">{fmtDollar(r.sale_amount_usd)}</td>
                  <td className="py-1 pr-4 text-right tabular-nums">
                    {r.buyer_premium_percent == null ? (
                      <span className="text-gray-300">—</span>
                    ) : (
                      `${r.buyer_premium_percent.toFixed(2)}%`
                    )}
                  </td>
                  <td className="py-1 pr-4 text-right tabular-nums">
                    {r.admin_fee_percent == null ? <span className="text-gray-300">—</span> : `${r.admin_fee_percent.toFixed(2)}%`}
                  </td>
                  <td className="py-1 pr-4 text-right tabular-nums">
                    {r.watch_count == null ? <span className="text-gray-300">—</span> : r.watch_count}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {r.visitors == null ? <span className="text-gray-300">—</span> : r.visitors}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-400">
        Quarter-to-date sold lots ≥ {fmtDollar(minUsd)}{total > rows.length ? ` (top ${rows.length} of ${total})` : ""}. Buyer Prem % = the
        buyer&apos;s premium (buyer pays on top of the hammer) and Admin Fee % = LQDT&apos;s seller-side fee — together the take-rate
        components, both read live per lot from the marketplace bid box. The two are often substitutes: GovDeals government lots
        typically show a buyer&apos;s premium with a 0% admin fee, while some sellers instead charge an admin fee with 0% premium.
        Watches/Visitors = final demand counts. All show “—” if unavailable.
      </p>
    </div>
  );
}
