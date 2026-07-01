import { convertToUsd, loadFxRates, type FxRates } from "./fx";
import {
  buildSearchPayload,
  extractListings,
  MAESTRO_KEY,
  MAESTRO_URL,
  safeNumber,
  SEARCH_LIST_PATH,
  type Platform,
} from "./maestro";
import { randomUUID } from "node:crypto";

export type SellerInfo = {
  account_id: string;
  company_name: string;
  country: string;
  state: string;
  listing_count: number;
  total_current_bid: number;
  total_bids: number;
  top_bid_asset_id: string | null;
  top_bid_amount: number;
  sub_business_id: string;
};

export type PlatformMetrics = {
  platform: Platform;
  total_listings: number;
  total_bids: number;
  avg_bids_per_listing: number;
  total_current_price: number;
  listings_with_bids: number;
  bid_rate: number;
  unique_seller_count: number;
  listings_closing_24h: number;
  // Maestro exposes no watch/view count field, so this is intentionally null
  // (was previously a misleading hardcoded 0).
  avg_watch_count: number | null;
  listings_with_reserve: number;
  reserve_rate: number;
  top_categories: Record<string, number>;
  sample_size: number;
  // Coverage metadata: was this a full census of active listings or a sample?
  pages_fetched: number;
  is_full_coverage: boolean;
  sellers: SellerInfo[];
  debug?: string;
};

const METRICS_PAGE_SIZE = Number(process.env.MARKETPLACE_METRICS_PAGE_SIZE) || 1000;
const MAX_METRICS_PAGES = Number(process.env.MARKETPLACE_METRICS_MAX_PAGES) || 25;

function listingKey(raw: Record<string, unknown>) {
  return [
    typeof raw.businessId === "string" ? raw.businessId : "",
    raw.accountId ?? "",
    raw.assetId ?? "",
    raw.auctionId ?? "",
  ].join(":");
}

function emptyMetrics(platform: Platform, debug: string): PlatformMetrics {
  return {
    platform,
    total_listings: 0,
    total_bids: 0,
    avg_bids_per_listing: 0,
    total_current_price: 0,
    listings_with_bids: 0,
    bid_rate: 0,
    unique_seller_count: 0,
    listings_closing_24h: 0,
    avg_watch_count: null,
    listings_with_reserve: 0,
    reserve_rate: 0,
    top_categories: {},
    sample_size: 0,
    pages_fetched: 0,
    is_full_coverage: false,
    sellers: [],
    debug,
  };
}

function computeMetrics(
  platform: Platform,
  totalListings: number,
  listings: Record<string, unknown>[],
  fx: FxRates,
  pagesFetched: number,
): PlatformMetrics {
  const sampleSize = listings.length;

  if (sampleSize === 0) {
    return { ...emptyMetrics(platform, "0 listings in response"), total_listings: totalListings, pages_fetched: pagesFetched };
  }

  let totalBids = 0;
  let totalCurrentPrice = 0;
  let listingsWithBids = 0;
  let listingsClosing24h = 0;
  let listingsWithReserve = 0;

  const sellerMap = new Map<string, SellerInfo>();
  const categoryCounts: Record<string, number> = {};

  const now = Date.now();
  const twentyFourHoursMs = 24 * 60 * 60 * 1000;

  for (const listing of listings) {
    const bids = safeNumber(listing.bidCount);
    totalBids += bids;
    if (bids > 0) listingsWithBids++;

    const rawBid = safeNumber(listing.currentBid);
    const currency = typeof listing.currencyCode === "string" ? listing.currencyCode : "USD";
    // Non-convertible currencies contribute 0 to the USD GMV proxy rather than
    // polluting it with a face-value foreign amount labeled as dollars.
    const currentBidUsd = convertToUsd(rawBid, currency, fx).usd ?? 0;
    totalCurrentPrice += currentBidUsd;

    if (listing.hasReservePrice === true) listingsWithReserve++;

    const accountId = listing.accountId != null ? String(listing.accountId) : null;
    const assetId = listing.assetId != null ? String(listing.assetId) : null;
    const subBiz = typeof listing.businessId === "string" ? listing.businessId : "";
    if (accountId) {
      const existing = sellerMap.get(accountId);
      if (existing) {
        existing.listing_count += 1;
        existing.total_current_bid += currentBidUsd;
        existing.total_bids += bids;
        if (currentBidUsd > existing.top_bid_amount && assetId) {
          existing.top_bid_asset_id = assetId;
          existing.top_bid_amount = currentBidUsd;
          existing.sub_business_id = subBiz;
        }
      } else {
        sellerMap.set(accountId, {
          account_id: accountId,
          company_name: typeof listing.companyName === "string" ? listing.companyName : "",
          country: typeof listing.country === "string" ? listing.country : "",
          state: typeof listing.locationState === "string" ? listing.locationState : "",
          listing_count: 1,
          total_current_bid: currentBidUsd,
          total_bids: bids,
          top_bid_asset_id: currentBidUsd > 0 ? assetId : null,
          top_bid_amount: currentBidUsd,
          sub_business_id: subBiz,
        });
      }
    }

    const categoryName = listing.categoryDescription;
    if (typeof categoryName === "string" && categoryName.length > 0) {
      categoryCounts[categoryName] = (categoryCounts[categoryName] || 0) + 1;
    }

    const endDateTime = listing.assetAuctionEndDateUtc;
    if (typeof endDateTime === "string") {
      const endMs = new Date(endDateTime).getTime();
      if (!Number.isNaN(endMs) && endMs > now && endMs - now <= twentyFourHoursMs) {
        listingsClosing24h++;
      }
    }
  }

  const topCategories: Record<string, number> = {};
  const sorted = Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [name, count] of sorted) {
    topCategories[name] = count;
  }

  const sellers = Array.from(sellerMap.values()).sort((a, b) => b.total_current_bid - a.total_current_bid);
  const isFullCoverage = totalListings > 0 ? sampleSize >= totalListings : true;

  return {
    platform,
    total_listings: totalListings,
    total_bids: totalBids,
    avg_bids_per_listing: Math.round((totalBids / sampleSize) * 100) / 100,
    total_current_price: Math.round(totalCurrentPrice * 100) / 100,
    listings_with_bids: listingsWithBids,
    bid_rate: Math.round((listingsWithBids / sampleSize) * 10000) / 10000,
    unique_seller_count: sellerMap.size,
    listings_closing_24h: listingsClosing24h,
    avg_watch_count: null,
    listings_with_reserve: listingsWithReserve,
    reserve_rate: Math.round((listingsWithReserve / sampleSize) * 10000) / 10000,
    top_categories: topCategories,
    sample_size: sampleSize,
    pages_fetched: pagesFetched,
    is_full_coverage: isFullCoverage,
    sellers,
    debug: `ok, ${sampleSize} listings, ${totalBids} bids, ${sellerMap.size} sellers`,
  };
}

type PageFetchResult = {
  listings: Record<string, unknown>[];
  totalListings: number;
  status: number;
  debug: string | null;
};

// This module paginates a single connection with a shared AbortSignal, so it
// uses fetch directly rather than the shared maestroFetch (which manages its
// own per-call timeout). Payload/headers still come from the shared client.
async function fetchMetricsPage(businessId: Platform, page: number, signal: AbortSignal): Promise<PageFetchResult> {
  const res = await fetch(`${MAESTRO_URL}${SEARCH_LIST_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": MAESTRO_KEY,
      "x-user-id": "-1",
      "x-api-correlation-id": randomUUID(),
    },
    body: JSON.stringify(buildSearchPayload(businessId, page, METRICS_PAGE_SIZE)),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return { listings: [], totalListings: 0, status: res.status, debug: `http ${res.status}: ${errText.slice(0, 100)}` };
  }

  const data = await res.json();
  const headerCount = res.headers.get("x-total-count");
  const totalListings = headerCount ? parseInt(headerCount, 10) || 0 : 0;
  const listings = extractListings(data);

  if (listings.length === 0) {
    const keys = data ? Object.keys(data).join(", ") : "null response";
    return { listings: [], totalListings, status: res.status, debug: `no listings array. keys: ${keys}` };
  }

  return { listings, totalListings, status: res.status, debug: null };
}

async function fetchPlatformMetrics(businessId: Platform, fx: FxRates): Promise<PlatformMetrics> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const listings: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let totalListings = 0;
    let page = 1;
    let lastDebug: string | null = null;

    while (page <= MAX_METRICS_PAGES) {
      const result = await fetchMetricsPage(businessId, page, controller.signal);
      if (result.debug) lastDebug = result.debug;
      if (result.status !== 200 && listings.length === 0) {
        console.error(`[marketplace-metrics] ${businessId} ${result.debug}`);
        return emptyMetrics(businessId, result.debug ?? `http ${result.status}`);
      }

      if (page === 1) totalListings = result.totalListings;
      if (result.listings.length === 0) break;

      for (const listing of result.listings) {
        const key = listingKey(listing);
        if (seen.has(key)) continue;
        seen.add(key);
        listings.push(listing);
      }

      if (result.listings.length < METRICS_PAGE_SIZE) break;
      if (totalListings > 0 && page * METRICS_PAGE_SIZE >= totalListings) break;
      page += 1;
    }

    const pagesFetched = Math.min(page, MAX_METRICS_PAGES);

    if (listings.length === 0) {
      console.error(`[marketplace-metrics] ${businessId} no listings found. ${lastDebug ?? ""}`);
      return { ...emptyMetrics(businessId, lastDebug ?? "0 listings in response"), pages_fetched: pagesFetched };
    }

    const metrics = computeMetrics(businessId, totalListings, listings, fx, pagesFetched);
    metrics.debug = metrics.is_full_coverage
      ? `ok, full coverage ${listings.length}/${totalListings || listings.length} listings`
      : `sampled ${listings.length}/${totalListings} listings across ${pagesFetched} pages`;
    return metrics;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[marketplace-metrics] ${businessId} error: ${msg}`);
    return emptyMetrics(businessId, `error: ${msg}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function scrapeMarketplaceMetrics(): Promise<{
  allsurplus: PlatformMetrics;
  govdeals: PlatformMetrics;
}> {
  const fx = await loadFxRates();
  const [allsurplus, govdeals] = await Promise.all([
    fetchPlatformMetrics("AD", fx),
    fetchPlatformMetrics("GD", fx),
  ]);
  return { allsurplus, govdeals };
}
