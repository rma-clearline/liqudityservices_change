import { RevenueForecast } from "@/components/revenue-forecast";
import { SectionHeader } from "@/components/section-header";
import { fmtNum } from "@/lib/format";
import { getLatestListing } from "@/lib/dashboard-data";

export const dynamic = "force-dynamic";

export default async function ForecastPage() {
  // Active-listings snapshot ported from the retired Overview tab.
  const latest = await getLatestListing();

  return (
    <div>
      <SectionHeader title="Quarterly Revenue Forecast" source="auctions" table="auctions" />

      {latest && (
        <div className="grid grid-cols-2 gap-4 mb-8">
          <div className="rounded-lg border p-4">
            <p className="text-xs text-gray-500 mb-1">AllSurplus active listings</p>
            <p className="text-3xl font-bold text-blue-600 tabular-nums">{fmtNum(latest.allsurplus)}</p>
          </div>
          <div className="rounded-lg border p-4">
            <p className="text-xs text-gray-500 mb-1">GovDeals active listings</p>
            <p className="text-3xl font-bold text-green-600 tabular-nums">{fmtNum(latest.govdeals)}</p>
          </div>
          <p className="col-span-2 text-xs text-gray-400">Last updated: {latest.date} {latest.timestamp} ET</p>
        </div>
      )}

      <RevenueForecast />
    </div>
  );
}
