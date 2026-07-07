import "server-only";

import { supabase } from "./supabase";
import type {
  ListingRow,
  FederalContractRow,
  ContractSnapshotRow,
  SamOpportunityRow,
  StateContractRow,
  MarketplaceSellerRow,
  SellerDeltaRow,
} from "./supabase";
import { ttlCache } from "./cache";

// Cached loaders for the dashboard's Server-Component reads. Every query here is
// GLOBAL and read-only (identical for all authenticated users), so a shared
// per-replica TTL cache is safe. The pages stay `force-dynamic` (the auth layout
// needs it); only the DATA is cached, so repeat tab navigation skips the
// cross-region Supabase round trips. Pairs with the business-hours keep-warm.
const TTL = Number(process.env.DASHBOARD_CACHE_MS) || 60_000;

// --- Listings (root + overview) ---
const listingsCache = ttlCache<ListingRow[]>(TTL);

export function getListings(): Promise<ListingRow[]> {
  return listingsCache.get("all", async () => {
    const { data } = await supabase
      .from("listings")
      .select("*")
      .order("date", { ascending: false })
      .order("timestamp", { ascending: false });
    return (data ?? []) as ListingRow[];
  });
}

/** Newest listing snapshot (overview cards). Reuses the shared listings cache. */
export async function getLatestListing(): Promise<ListingRow | null> {
  const rows = await getListings();
  return rows[0] ?? null;
}

// --- Contracts page (5 reads) ---
export type ContractsData = {
  contracts: FederalContractRow[];
  snapshot: ContractSnapshotRow | null;
  sam: SamOpportunityRow[];
  state: StateContractRow[];
  sellerSnapshot: { date: string | null; sellers: MarketplaceSellerRow[] };
};

const contractsCache = ttlCache<ContractsData>(TTL);

// Latest marketplace_sellers snapshot: newest date, then all of that day's rows
// (both platforms) so the government-level mix is a single consistent snapshot.
async function latestSellerSnapshot(): Promise<{ date: string | null; sellers: MarketplaceSellerRow[] }> {
  const latest = await supabase
    .from("marketplace_sellers")
    .select("date")
    .order("date", { ascending: false })
    .limit(1);
  const date = latest.data?.[0]?.date ?? null;
  if (!date) return { date: null, sellers: [] };
  const rows = await supabase.from("marketplace_sellers").select("*").eq("date", date);
  return { date, sellers: rows.data ?? [] };
}

export function getContractsData(): Promise<ContractsData> {
  return contractsCache.get("all", async () => {
    const [contractsRes, snapshotsRes, samRes, stateRes, sellerSnapshot] = await Promise.all([
      supabase.from("federal_contracts").select("*").order("start_date", { ascending: false }).limit(20),
      supabase.from("contract_snapshots").select("*").order("date", { ascending: false }).limit(1),
      supabase.from("sam_opportunities").select("*").order("posted_date", { ascending: false }).limit(100),
      supabase
        .from("state_contracts")
        .select("*")
        .order("year", { ascending: false })
        .order("quarter", { ascending: false })
        .limit(200),
      latestSellerSnapshot(),
    ]);
    return {
      contracts: (contractsRes.data ?? []) as FederalContractRow[],
      snapshot: (snapshotsRes.data?.[0] ?? null) as ContractSnapshotRow | null,
      sam: (samRes.data ?? []) as SamOpportunityRow[],
      state: (stateRes.data ?? []) as StateContractRow[],
      sellerSnapshot,
    };
  });
}

// --- Marketplace page (2 reads) ---
export type MarketplaceData = { sellers: MarketplaceSellerRow[]; deltas: SellerDeltaRow[] };

const marketplaceCache = ttlCache<MarketplaceData>(TTL);

export function getMarketplaceData(): Promise<MarketplaceData> {
  return marketplaceCache.get("all", async () => {
    const [sellersRes, deltasRes] = await Promise.all([
      supabase
        .from("marketplace_sellers")
        .select("*")
        .order("date", { ascending: false })
        .order("total_current_bid", { ascending: false })
        .limit(200),
      supabase.from("marketplace_seller_deltas").select("*").limit(500),
    ]);
    return {
      sellers: (sellersRes.data ?? []) as MarketplaceSellerRow[],
      deltas: (deltasRes.data ?? []) as SellerDeltaRow[],
    };
  });
}
