import { supabase } from "@/lib/supabase";
import type { ListingRow, MarketplaceMetricsRow, FederalContractRow, ContractSnapshotRow, MarketplaceSellerRow, SamOpportunityRow, StateContractRow, SellerDeltaRow } from "@/lib/supabase";
import { Dashboard } from "@/components/dashboard";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [listingsRes, metricsRes, contractsRes, snapshotsRes, sellersRes, samRes, stateRes, sellerDeltasRes] = await Promise.all([
    supabase
      .from("listings")
      .select("*")
      .order("date", { ascending: false })
      .order("timestamp", { ascending: false }),
    supabase
      .from("marketplace_metrics")
      .select("*")
      .order("date", { ascending: false })
      .order("timestamp", { ascending: false })
      .limit(2),
    supabase
      .from("federal_contracts")
      .select("*")
      .order("start_date", { ascending: false })
      .limit(20),
    supabase
      .from("contract_snapshots")
      .select("*")
      .order("date", { ascending: false })
      .limit(1),
    supabase
      .from("marketplace_sellers")
      .select("*")
      .order("date", { ascending: false })
      .order("total_current_bid", { ascending: false })
      .limit(200),
    supabase
      .from("sam_opportunities")
      .select("*")
      .order("posted_date", { ascending: false })
      .limit(100),
    supabase
      .from("state_contracts")
      .select("*")
      .order("year", { ascending: false })
      .order("quarter", { ascending: false })
      .limit(200),
    supabase
      .from("marketplace_seller_deltas")
      .select("*")
      .limit(500),
  ]);

  const listings: ListingRow[] = listingsRes.data ?? [];

  const metricsRows: MarketplaceMetricsRow[] = metricsRes.data ?? [];
  const latestAllsurplus = metricsRows.find((r) => r.platform === "AD") ?? null;
  const latestGovdeals = metricsRows.find((r) => r.platform === "GD") ?? null;

  const contracts: FederalContractRow[] = contractsRes.data ?? [];
  const contractSnapshot: ContractSnapshotRow | null = snapshotsRes.data?.[0] ?? null;

  const allSellers: MarketplaceSellerRow[] = sellersRes.data ?? [];
  const latestSellerDate = allSellers[0]?.date;
  const latestSellers = latestSellerDate ? allSellers.filter((s) => s.date === latestSellerDate) : [];
  const sellersAD = latestSellers.filter((s) => s.platform === "AD");
  const sellersGD = latestSellers.filter((s) => s.platform === "GD");

  const samOpportunities: SamOpportunityRow[] = samRes.data ?? [];
  const stateContracts: StateContractRow[] = stateRes.data ?? [];
  const sellerDeltas: SellerDeltaRow[] = sellerDeltasRes.data ?? [];

  return (
    <main className="px-6 py-10">
      <h1 className="text-2xl font-bold mb-1">LQDT Analytics</h1>
      <p className="text-gray-500 text-sm mb-8">
        Liquidity Services — marketplace &amp; auction GMV, quarterly revenue forecast, and federal/state procurement activity
      </p>
      <Dashboard
        listings={listings}
        metricsAllsurplus={latestAllsurplus}
        metricsGovdeals={latestGovdeals}
        contracts={contracts}
        contractSnapshot={contractSnapshot}
        sellersAllsurplus={sellersAD}
        sellersGovdeals={sellersGD}
        sellerDeltas={sellerDeltas}
        samOpportunities={samOpportunities}
        stateContracts={stateContracts}
      />
    </main>
  );
}
