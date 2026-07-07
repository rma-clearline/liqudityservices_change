import { TopSellers } from "@/components/top-sellers";
import { SellerMovers } from "@/components/seller-movers";
import { SectionHeader } from "@/components/section-header";
import { getMarketplaceData } from "@/lib/dashboard-data";

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
    </div>
  );
}
