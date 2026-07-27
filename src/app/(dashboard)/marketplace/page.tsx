import { Suspense } from "react";
import { TopSellers } from "@/components/top-sellers";
import { TopSoldItems } from "@/components/top-sold-items";
import { SellerMovers } from "@/components/seller-movers";
import { SectionHeader } from "@/components/section-header";
import { getMarketplaceData, getTopSoldItems } from "@/lib/dashboard-data";

export const dynamic = "force-dynamic";

export default async function MarketplacePage() {
  const { sellers: allSellers, deltas: sellerDeltas } = await getMarketplaceData();

  const latestSellerDate = allSellers[0]?.date;
  const latestSellers = latestSellerDate ? allSellers.filter((s) => s.date === latestSellerDate) : [];
  const sellersAD = latestSellers.filter((s) => s.platform === "AD");
  const sellersGD = latestSellers.filter((s) => s.platform === "GD");

  return (
    <div className="space-y-10">
      <section>
        <SectionHeader title="Top Sellers" source="marketplace_metrics" table="marketplace_sellers" />
        <div className="space-y-6">
          <SellerMovers deltas={sellerDeltas} />
          <TopSellers allsurplus={sellersAD} govdeals={sellersGD} />
        </div>
      </section>

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
