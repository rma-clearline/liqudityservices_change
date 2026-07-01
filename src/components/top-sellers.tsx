"use client";

import type { MarketplaceSellerRow } from "@/lib/supabase";
import { ExportButton } from "./export-button";

function fmtDollar(n: number | null | undefined) {
  if (n == null) return "—";
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(0) + "k";
  return "$" + n.toFixed(0);
}

function listingUrl(accountId: string, assetId: string, subBiz: string): string {
  const domain = subBiz === "GD" ? "www.govdeals.com" : "www.allsurplus.com";
  return `https://${domain}/asset/${assetId}/${accountId}`;
}

function sellerSearchUrl(accountId: string, platform: "AD" | "GD"): string {
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

function SellerTable({ title, color, sellers, platform }: { title: string; color: string; sellers: MarketplaceSellerRow[]; platform: "AD" | "GD" }) {
  if (sellers.length === 0) return null;

  const countryBreakdown: Record<string, number> = {};
  for (const s of sellers) {
    const c = s.country || "Unknown";
    countryBreakdown[c] = (countryBreakdown[c] || 0) + (s.listing_count ?? 0);
  }
  const countrySorted = Object.entries(countryBreakdown).sort((a, b) => b[1] - a[1]);

  return (
    <div>
      <h3 className={`text-sm font-semibold mb-2 ${color}`}>{title}</h3>
      <div className="flex flex-wrap gap-2 mb-3">
        {countrySorted.map(([country, count]) => (
          <span key={country} className="text-xs bg-gray-100 rounded px-2 py-0.5">
            {countryFlag(country)}{country} <span className="text-gray-400">({count})</span>
          </span>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b-2 border-gray-300">
              <th className="py-1.5 pr-4 text-left">Seller</th>
              <th className="py-1.5 pr-4 text-left">Location</th>
              <th className="py-1.5 pr-4 text-right">Listings</th>
              <th className="py-1.5 pr-4 text-right">Bids</th>
              <th className="py-1.5 text-right">GMV (USD)</th>
            </tr>
          </thead>
          <tbody>
            {sellers.slice(0, 15).map((s) => (
              <tr key={s.account_id} className="border-b border-gray-100">
                <td className="py-1 pr-4 truncate max-w-[250px]">
                  {countryFlag(s.country)}{s.company_name || `Seller #${s.account_id}`}
                </td>
                <td className="py-1 pr-4 text-gray-500 whitespace-nowrap">
                  {[s.state, s.country].filter(Boolean).join(", ")}
                </td>
                <td className="py-1 pr-4 text-right tabular-nums">
                  <a
                    href={sellerSearchUrl(s.account_id, platform)}
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
                      href={listingUrl(s.account_id, s.top_bid_asset_id, s.sub_business_id ?? platform)}
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
                <td className="py-1 text-right tabular-nums">{fmtDollar(s.total_current_bid)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function TopSellers({
  allsurplus,
  govdeals,
}: {
  allsurplus: MarketplaceSellerRow[];
  govdeals: MarketplaceSellerRow[];
}) {
  if (allsurplus.length === 0 && govdeals.length === 0) {
    return <p className="text-gray-500 text-sm">No seller data yet. Data will appear after the next cron run.</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <ExportButton
          rows={[...allsurplus, ...govdeals]}
          filename="lqdt-top-sellers.csv"
          columns={[
            { key: "date", label: "Snapshot" },
            { key: "platform", label: "Platform" },
            { key: "account_id", label: "Account ID" },
            { key: "company_name", label: "Seller" },
            { key: "country", label: "Country" },
            { key: "state", label: "State" },
            { key: "listing_count", label: "Listings" },
            { key: "total_bids", label: "Bids" },
            { key: "total_current_bid", label: "GMV Proxy USD" },
          ]}
        />
      </div>
      <SellerTable title="AllSurplus" color="text-blue-600" sellers={allsurplus} platform="AD" />
      <SellerTable title="GovDeals" color="text-green-600" sellers={govdeals} platform="GD" />
    </div>
  );
}
