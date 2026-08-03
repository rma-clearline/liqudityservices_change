import { Suspense } from "react";
import { TopSoldItems } from "@/components/top-sold-items";
import { SectionHeader } from "@/components/section-header";
import { getTopSoldItems } from "@/lib/dashboard-data";

export const dynamic = "force-dynamic";

export default async function MarketplacePage() {
  return (
    <div className="space-y-10">
      <section>
        <SectionHeader title="Top Sold Items — QTD" source="sold_capture" table="sold_lots" />
        {/* Enrichment makes live per-lot Maestro calls; stream it so the rest of the page never waits on it. */}
        <Suspense fallback={<p className="text-sm text-gray-400">Loading sold items…</p>}>
          <TopSoldSection />
        </Suspense>
      </section>
    </div>
  );
}

async function TopSoldSection() {
  const topSold = await getTopSoldItems();
  return <TopSoldItems rows={topSold.lots} total={topSold.total} blended={topSold.blended} minUsd={topSold.minUsd} />;
}
