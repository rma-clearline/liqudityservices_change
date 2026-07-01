import { supabase } from "@/lib/supabase";
import type { ListingRow } from "@/lib/supabase";
import { ExecutiveSummary } from "@/components/executive-summary";
import { fmtNum } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const { data } = await supabase
    .from("listings")
    .select("*")
    .order("date", { ascending: false })
    .order("timestamp", { ascending: false })
    .limit(1);
  const latest = (data?.[0] ?? null) as ListingRow | null;

  return (
    <div>
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

      <ExecutiveSummary />
    </div>
  );
}
