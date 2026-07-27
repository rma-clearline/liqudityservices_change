import "server-only";

import { supabase } from "./supabase";
import type { ListingRow, MarketplaceSellerRow, SellerDeltaRow } from "./supabase";
import { ttlCache } from "./cache";
import { useAzureData } from "./data-backend";
import { azFetchListings, azFetchMarketplaceSellers, azFetchSellerDeltas } from "./azure-tables";
import { getTopSoldLots, isAzureSqlConfigured, getBlendedAdminFee, upsertSellerFees } from "./azure-sql";
import { enrichTopLots, type EnrichedLot } from "./asset-fees";
import { etTodayKey, etQuarterKey } from "./time";
import { quarterDayKeys } from "./qtd-shared";

// Cached loaders for the dashboard's Server-Component reads. Every query here is
// GLOBAL and read-only (identical for all authenticated users), so a shared
// per-replica TTL cache is safe. The pages stay `force-dynamic` (the auth layout
// needs it); only the DATA is cached, so repeat tab navigation skips the
// cross-region Supabase round trips. Pairs with the business-hours keep-warm.
const TTL = Number(process.env.DASHBOARD_CACHE_MS) || 15 * 60_000;

// --- Listings (root + overview) ---
const listingsCache = ttlCache<ListingRow[]>(TTL);

export function getListings(): Promise<ListingRow[]> {
  return listingsCache.get("all", async () => {
    if (useAzureData()) return azFetchListings();
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


// --- Marketplace page (2 reads) ---
export type MarketplaceData = { sellers: MarketplaceSellerRow[]; deltas: SellerDeltaRow[] };

const marketplaceCache = ttlCache<MarketplaceData>(TTL);

export function getMarketplaceData(): Promise<MarketplaceData> {
  return marketplaceCache.get("all", async () => {
    if (useAzureData()) {
      const [sellers, deltas] = await Promise.all([azFetchMarketplaceSellers(200), azFetchSellerDeltas()]);
      return { sellers, deltas };
    }
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

// --- Top Sold Items (current quarter) — enriched with take rate + watches ---
// The sold store is always Azure; enrichment (per-asset Maestro detail calls) is
// best-effort and cached with the rest so a page load makes them at most once per TTL.
const TOP_SOLD_MIN_USD = Number(process.env.TOP_SOLD_MIN_USD) || 250_000;
const TOP_SOLD_LIMIT = Number(process.env.TOP_SOLD_LIMIT) || 25;
export type BlendedAdminFee = { blended_pct: number | null; covered_gmv: number; total_gmv: number };
export type TopSoldData = { lots: EnrichedLot[]; total: number; blended: BlendedAdminFee | null; minUsd: number };

const topSoldCache = ttlCache<TopSoldData>(TTL);

export function getTopSoldItems(): Promise<TopSoldData> {
  return topSoldCache.get("qtd", async () => {
    if (!isAzureSqlConfigured()) return { lots: [], total: 0, blended: null, minUsd: TOP_SOLD_MIN_USD };
    const today = etTodayKey();
    const start = quarterDayKeys(etQuarterKey(today))[0];
    if (!start) return { lots: [], total: 0, blended: null, minUsd: TOP_SOLD_MIN_USD };
    const { lots, total } = await getTopSoldLots(start, today, TOP_SOLD_MIN_USD, TOP_SOLD_LIMIT);
    const enriched = await enrichTopLots(lots);
    // Bootstrap seller_fees with the fees we just fetched (idempotent, deduped) so the
    // blended reference reflects the top sellers immediately; the cron fills the rest.
    const seen = new Set<string>();
    const feeRows = enriched
      .filter((l) => l.admin_fee_percent != null && l.account_id)
      .map((l) => ({ site: l.site, account_id: l.account_id, admin_fee_percent: l.admin_fee_percent as number }))
      .filter((r) => {
        const k = `${r.site}:${r.account_id}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    // Fire-and-forget: the render never waits on the bootstrap write (the cron is the
    // durable writer, and the host is long-running so it lands in the background).
    if (feeRows.length) void upsertSellerFees(feeRows).catch(() => {});
    // Bound the blended read so a slow SQL join can't hold the (Suspense-isolated) card.
    const blended = await Promise.race([
      getBlendedAdminFee(start, today).catch(() => null),
      new Promise<BlendedAdminFee | null>((res) => setTimeout(() => res(null), 5_000)),
    ]);
    return { lots: enriched, total, blended, minUsd: TOP_SOLD_MIN_USD };
  });
}
