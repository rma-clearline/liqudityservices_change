import { supabase } from "@/lib/supabase";
import type { MarketplaceSellerRow, SellerDeltaRow } from "@/lib/supabase";
import { TopSellers } from "@/components/top-sellers";
import { SellerMovers } from "@/components/seller-movers";
import { SectionHeader } from "@/components/section-header";

export const dynamic = "force-dynamic";

export default async function MarketplacePage() {
  const [sellersRes, deltasRes] = await Promise.all([
    supabase
      .from("marketplace_sellers")
      .select("*")
      .order("date", { ascending: false })
      .order("total_current_bid", { ascending: false })
      .limit(200),
    supabase.from("marketplace_seller_deltas").select("*").limit(500),
  ]);

  const allSellers: MarketplaceSellerRow[] = sellersRes.data ?? [];
  const latestSellerDate = allSellers[0]?.date;
  const latestSellers = latestSellerDate ? allSellers.filter((s) => s.date === latestSellerDate) : [];
  const sellersAD = latestSellers.filter((s) => s.platform === "AD");
  const sellersGD = latestSellers.filter((s) => s.platform === "GD");

  const sellerDeltas: SellerDeltaRow[] = deltasRes.data ?? [];

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
