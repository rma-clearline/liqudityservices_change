"use client";

import { useMemo, useState } from "react";
import type { MarketplaceSellerRow } from "@/lib/supabase";
import { ExportButton } from "./export-button";

function fmtDollar(n: number | null | undefined) {
  if (n == null) return "—";
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(0) + "k";
  return "$" + n.toFixed(0);
}

// True marketplace (from the listing's businessId) — NOT the storefront it was
// scraped from. AllSurplus aggregates GovDeals + Industrial inventory, so a
// seller's real home is their businessId, and each seller maps to exactly one.
type Marketplace = "AD" | "GD" | "GI";
const MKT_LABEL: Record<Marketplace, string> = { AD: "AllSurplus", GD: "GovDeals", GI: "Industrial" };
const MKT_COLOR: Record<Marketplace, string> = {
  AD: "bg-blue-50 text-blue-700 border-blue-200",
  GD: "bg-green-50 text-green-700 border-green-200",
  GI: "bg-purple-50 text-purple-700 border-purple-200",
};

function trueMarket(s: MarketplaceSellerRow): Marketplace {
  const m = (s.sub_business_id || s.platform) as string;
  return m === "AD" || m === "GD" || m === "GI" ? m : "GI";
}

function listingUrl(accountId: string, assetId: string, mkt: Marketplace): string {
  const domain = mkt === "GD" ? "www.govdeals.com" : "www.allsurplus.com";
  return `https://${domain}/asset/${assetId}/${accountId}`;
}

function sellerSearchUrl(accountId: string, platform: string): string {
  const domain = platform === "GD" ? "www.govdeals.com" : "www.allsurplus.com";
  return `https://${domain}/search?accountId=${accountId}`;
}

function countryFlag(code: string | null) {
  if (!code || code.length < 2) return "";
  const map: Record<string, string> = {
    USA: "US", ZAF: "ZA", CAN: "CA", GBR: "GB", AUS: "AU",
    DEU: "DE", FRA: "FR", IND: "IN", BRA: "BR", MEX: "MX",
  };
  const iso2 = map[code] ?? code.slice(0, 2);
  return iso2.toUpperCase().replace(/./g, (c) =>
    String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)
  ) + " ";
}

export function TopSellers({
  allsurplus,
  govdeals,
}: {
  allsurplus: MarketplaceSellerRow[];
  govdeals: MarketplaceSellerRow[];
}) {
  const [mkt, setMkt] = useState<"all" | Marketplace>("all");
  const [query, setQuery] = useState("");

  // One row per seller: the same seller is scraped from both storefronts (AllSurplus
  // re-lists GovDeals/Industrial), so collapse by account_id and keep the fullest
  // snapshot (max GMV) — never sum, which would double-count cross-listed inventory.
  const consolidated = useMemo(() => {
    const byAccount = new Map<string, MarketplaceSellerRow>();
    for (const s of [...allsurplus, ...govdeals]) {
      const prev = byAccount.get(s.account_id);
      if (!prev || (s.total_current_bid ?? 0) > (prev.total_current_bid ?? 0)) byAccount.set(s.account_id, s);
    }
    return [...byAccount.values()];
  }, [allsurplus, govdeals]);

  const counts = useMemo(() => {
    const c = { all: consolidated.length, AD: 0, GD: 0, GI: 0 };
    for (const s of consolidated) c[trueMarket(s)]++;
    return c;
  }, [consolidated]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return consolidated
      .filter((s) => mkt === "all" || trueMarket(s) === mkt)
      .filter((s) => !q || (s.company_name || "").toLowerCase().includes(q) || s.account_id.includes(q))
      .sort((a, b) => (b.total_current_bid ?? 0) - (a.total_current_bid ?? 0));
  }, [consolidated, mkt, query]);

  const exportRows = useMemo(
    () =>
      consolidated.map((s) => ({
        ...s,
        marketplace: MKT_LABEL[trueMarket(s)],
        avg_bids_per_listing: (s.listing_count ?? 0) > 0 ? (s.total_bids ?? 0) / (s.listing_count ?? 1) : 0,
      })),
    [consolidated],
  );

  if (consolidated.length === 0) {
    return <p className="text-gray-500 text-sm">No seller data yet. Data will appear after the next cron run.</p>;
  }

  const filters: { key: "all" | Marketplace; label: string }[] = [
    { key: "all", label: `All (${counts.all})` },
    { key: "AD", label: `AllSurplus (${counts.AD})` },
    { key: "GD", label: `GovDeals (${counts.GD})` },
    { key: "GI", label: `Industrial (${counts.GI})` },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setMkt(f.key)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                mkt === f.key ? "border-gray-800 bg-gray-800 text-white" : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              {f.label}
            </button>
          ))}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter sellers…"
            className="ml-1 w-40 rounded-md border border-gray-300 px-2.5 py-1 text-xs focus:border-gray-500 focus:outline-none"
          />
        </div>
        <ExportButton
          rows={exportRows}
          filename="lqdt-top-sellers.csv"
          columns={[
            { key: "date", label: "Snapshot" },
            { key: "marketplace", label: "Marketplace" },
            { key: "account_id", label: "Account ID" },
            { key: "company_name", label: "Seller" },
            { key: "country", label: "Country" },
            { key: "state", label: "State" },
            { key: "listing_count", label: "Listings" },
            { key: "total_bids", label: "Bids" },
            { key: "avg_bids_per_listing", label: "Avg Bids/Listing" },
            { key: "total_current_bid", label: "GMV Proxy USD" },
          ]}
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b-2 border-gray-300">
              <th className="py-1.5 pr-4 text-left">Seller</th>
              <th className="py-1.5 pr-4 text-left">Marketplace</th>
              <th className="py-1.5 pr-4 text-left">Location</th>
              <th className="py-1.5 pr-4 text-right">Listings</th>
              <th className="py-1.5 pr-4 text-right">Bids</th>
              <th className="py-1.5 pr-4 text-right">Avg Bids/Listing</th>
              <th className="py-1.5 text-right">GMV (USD)</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 25).map((s) => {
              const m = trueMarket(s);
              const avg = (s.listing_count ?? 0) > 0 ? (s.total_bids ?? 0) / (s.listing_count as number) : null;
              return (
                <tr key={s.account_id} className="border-b border-gray-100">
                  <td className="py-1 pr-4 truncate max-w-[240px]">
                    {countryFlag(s.country)}{s.company_name || `Seller #${s.account_id}`}
                  </td>
                  <td className="py-1 pr-4">
                    <span className={`inline-block rounded border px-1.5 py-0.5 text-xs ${MKT_COLOR[m]}`}>{MKT_LABEL[m]}</span>
                  </td>
                  <td className="py-1 pr-4 text-gray-500 whitespace-nowrap">
                    {[s.state, s.country].filter(Boolean).join(", ")}
                  </td>
                  <td className="py-1 pr-4 text-right tabular-nums">
                    <a
                      href={sellerSearchUrl(s.account_id, s.platform)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline"
                    >
                      {s.listing_count ?? 0}
                    </a>
                  </td>
                  <td className="py-1 pr-4 text-right tabular-nums">
                    {(s.total_bids ?? 0) > 0 && s.top_bid_asset_id ? (
                      <a
                        href={listingUrl(s.account_id, s.top_bid_asset_id, m)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        {s.total_bids}
                      </a>
                    ) : (
                      s.total_bids ?? 0
                    )}
                  </td>
                  <td className="py-1 pr-4 text-right tabular-nums text-gray-600">{avg == null ? "—" : avg.toFixed(1)}</td>
                  <td className="py-1 text-right tabular-nums">{fmtDollar(s.total_current_bid)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > 25 && (
        <p className="text-xs text-gray-400">Showing top 25 of {rows.length} sellers by GMV. Refine with the filter or search.</p>
      )}
    </div>
  );
}
