import { readFile } from "node:fs/promises";
import path from "node:path";
import { supabase, supabaseAdmin } from "./supabase";
import { convertToUsd, loadFxRates, persistFxRates, roundUsd, type FxRates } from "./fx";
import {
  buildSearchPayload,
  buildSoldPayload,
  maestroFetch,
  safeNumber,
  safeString,
  SEARCH_LIST_PATH,
  SOLD_SEARCH_PATH,
  type MaestroPage,
  type Platform,
} from "./maestro";
import { dateKeyToUtcDate, enumerateDays, enumerateQuarterLabelsBetween, etDateKey, parseQuarterLabel, quarterBounds } from "./time";

const PAGE_SIZE = Number(process.env.AUCTIONS_PAGE_SIZE) || 50;
const MAX_PAGES_PER_PLATFORM = Number(process.env.AUCTIONS_MAX_PAGES) || 10;
const PAGE_TIMEOUT_MS = Number(process.env.AUCTIONS_PAGE_TIMEOUT_MS) || 40000;
const DEFAULT_CLOSE_RATE = Number(process.env.AUCTIONS_DEFAULT_CLOSE_RATE) || 0.35;
// Sold-auction ingestion (the realized-GMV feed). A rolling window of recent
// days is re-fetched each cron run and upserted as closed_sold, so realized GMV
// for the live quarter accumulates without relying on the offline CSV export.
const SOLD_LOOKBACK_DAYS = Number(process.env.AUCTIONS_SOLD_LOOKBACK_DAYS) || 2;
const SOLD_PAGE_SIZE = Number(process.env.AUCTIONS_SOLD_PAGE_SIZE) || 1000;
const SOLD_MAX_PAGES = Number(process.env.AUCTIONS_SOLD_MAX_PAGES) || 10;
const HISTORICAL_GMV_DIR = path.join(process.cwd(), "scripts");
const HISTORICAL_DAILY_GMV_PATH = historicalCsvPath(
  process.env.HISTORICAL_GMV_DAILY_PATH,
  "historical-gmv-daily-2025-06-2026-06.csv",
);
const HISTORICAL_DAILY_MARKET_GMV_PATH = historicalCsvPath(
  process.env.HISTORICAL_GMV_DAILY_MARKET_PATH,
  "historical-gmv-daily-market-2025-06-2026-06.csv",
);

let cachedHistoricalDailyGmv: HistoricalDailyGmvData | null = null;

type HistoricalDailyGmv = {
  all: number;
  domestic: number;
  international: number;
  soldLots: number;
};

type HistoricalPlatformDailyGmv = {
  gmv: number;
  soldLots: number;
};

// Source (true marketplace) keys carried in the daily series so the chart can
// toggle by source. GI (industrial) is historical-only — it isn't tracked live.
type SourceKey = "AD" | "GD" | "GI";
const SOURCE_KEYS: SourceKey[] = ["AD", "GD", "GI"];

type HistoricalDailyGmvData = {
  totals: Map<string, HistoricalDailyGmv>;
  platforms: Map<SourceKey, Map<string, HistoricalPlatformDailyGmv>>;
};

function historicalCsvPath(rawPath: string | undefined, fallbackFile: string) {
  const normalized = (rawPath || fallbackFile).replace(/\\/g, "/");
  const fileName = path.basename(normalized);
  return path.join(HISTORICAL_GMV_DIR, fileName.endsWith(".csv") ? fileName : fallbackFile);
}

function emptyHistoricalDailyGmv(): HistoricalDailyGmv {
  return { all: 0, domestic: 0, international: 0, soldLots: 0 };
}

function emptyHistoricalDailyGmvData(): HistoricalDailyGmvData {
  return {
    totals: new Map(),
    platforms: new Map(
      SOURCE_KEYS.map((k) => [k, new Map()] as [SourceKey, Map<string, HistoricalPlatformDailyGmv>]),
    ),
  };
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === "\"" && inQuotes && next === "\"") {
      current += "\"";
      i += 1;
    } else if (char === "\"") {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

function parseNativeUsd(raw: string | undefined) {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return safeNumber(parsed.USD, 0);
  } catch {
    return 0;
  }
}

async function loadHistoricalDailyGmv(): Promise<HistoricalDailyGmvData> {
  if (cachedHistoricalDailyGmv) return cachedHistoricalDailyGmv;

  const rows = emptyHistoricalDailyGmvData();
  try {
    const raw = await readFile(HISTORICAL_DAILY_GMV_PATH, "utf8");
    for (const line of raw.trim().split(/\r?\n/).slice(1)) {
      const [date, businessId, soldLotsRaw, gmvUsd, , nativeByCurrency] = parseCsvLine(line);
      if (!date) continue;
      const gmv = safeNumber(gmvUsd, Number.NaN);
      if (!Number.isFinite(gmv)) continue;
      const soldLots = safeNumber(soldLotsRaw, 0);

      if (businessId === "AD" || businessId === "GD" || businessId === "GI") {
        rows.platforms.get(businessId)?.set(date, { gmv, soldLots });
      }
      if (businessId !== "ALL") continue;

      const domestic = parseNativeUsd(nativeByCurrency);
      rows.totals.set(date, {
        all: gmv,
        domestic,
        international: Math.max(0, gmv - domestic),
        soldLots,
      });
    }
  } catch {
    // The app can still run without the offline historical export.
  }

  try {
    const raw = await readFile(HISTORICAL_DAILY_MARKET_GMV_PATH, "utf8");
    for (const line of raw.trim().split(/\r?\n/).slice(1)) {
      const [date, businessId, market, soldLotsRaw, gmvUsd] = parseCsvLine(line);
      if (!date || businessId !== "ALL") continue;

      const gmv = safeNumber(gmvUsd, Number.NaN);
      if (!Number.isFinite(gmv)) continue;
      const soldLots = safeNumber(soldLotsRaw, 0);

      const hasDailyTotal = rows.totals.has(date);
      const bucket = rows.totals.get(date) ?? emptyHistoricalDailyGmv();
      if (market === "DOMESTIC") bucket.domestic = gmv;
      else if (market === "INTERNATIONAL") bucket.international = gmv;
      else if (market === "ALL" && !hasDailyTotal) {
        bucket.all = gmv;
        bucket.soldLots = soldLots;
      }
      rows.totals.set(date, bucket);
    }
  } catch {
    // Domestic/international filters are unavailable for dates absent from the split export.
  }

  cachedHistoricalDailyGmv = rows;
  return rows;
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

function saleUrl(raw: Record<string, unknown>): string | null {
  if (typeof raw.clickUrl !== "string" || raw.clickUrl.length === 0) return null;
  if (raw.clickUrl.startsWith("http")) return raw.clickUrl;
  return `https://www.govdeals.com${raw.clickUrl.startsWith("/") ? "" : "/"}${raw.clickUrl}`;
}

function reserveStatus(raw: Record<string, unknown>, sold: boolean): string | null {
  const has = raw.hasReservePrice === true;
  if (!has) return "none";
  if (raw.isReserveNotMet === true) return "not_met";
  if (raw.isReserveReduced === true) return "reduced";
  return sold ? "met" : "set";
}

// Item-level enrichment shared by open + sold parsing. All fields come straight
// from the Maestro payload (verified present via live probing).
function enrichmentFields(raw: Record<string, unknown>, sold: boolean) {
  return {
    row_business_id: typeof raw.businessId === "string" ? raw.businessId : null,
    title: safeString(raw, ["assetShortDescription"]) || null,
    country: safeString(raw, ["country", "countryCode", "assetCountry", "locationCountry"]) || null,
    state: safeString(raw, ["locationState", "state", "stateCode"]) || null,
    city: safeString(raw, ["locationCity"]) || null,
    make: safeString(raw, ["makebrand"]) || null,
    model: safeString(raw, ["model"]) || null,
    model_year: safeString(raw, ["modelYear"]) || null,
    lot_number: raw.lotNumber != null ? String(raw.lotNumber) : null,
    keywords: safeString(raw, ["keywords"]) || null,
    url: saleUrl(raw),
    event_id:
      raw.eventId != null ? String(raw.eventId) : raw.displayEventId != null ? String(raw.displayEventId) : null,
    auction_type_id: raw.auctionTypeId != null ? String(raw.auctionTypeId) : null,
    reserve_status: reserveStatus(raw, sold),
    is_new_asset: typeof raw.isNewAsset === "boolean" ? raw.isNewAsset : null,
    watch_count: null as number | null, // Maestro exposes no watch/view count
  };
}

type AuctionRow = {
  platform: Platform;
  asset_id: string;
  seller_account_id: string | null;
  seller_company: string | null;
  category: string | null;
  currency_code: string | null;
  current_bid_usd: number | null;
  sale_amount_native: number;
  fx_rate_used: number | null;
  fx_source: string;
  bid_count: number;
  close_time_utc: string | null;
  status: "open";
  last_seen_at: string;
} & ReturnType<typeof enrichmentFields>;

function parseListing(platform: Platform, raw: Record<string, unknown>, fx: FxRates, nowIso: string): AuctionRow | null {
  const assetId = raw.assetId != null ? String(raw.assetId) : null;
  if (!assetId) return null;

  const currency = typeof raw.currencyCode === "string" ? raw.currencyCode : "USD";
  const rawBid = safeNumber(raw.currentBid);
  const conv = convertToUsd(rawBid, currency, fx);
  const endDate = typeof raw.assetAuctionEndDateUtc === "string" ? raw.assetAuctionEndDateUtc : null;

  return {
    platform,
    asset_id: assetId,
    seller_account_id: raw.accountId != null ? String(raw.accountId) : null,
    seller_company: typeof raw.companyName === "string" ? raw.companyName : null,
    category: typeof raw.categoryDescription === "string" ? raw.categoryDescription : null,
    currency_code: currency,
    current_bid_usd: roundUsd(conv.usd),
    sale_amount_native: rawBid,
    fx_rate_used: conv.rateUsed,
    fx_source: conv.rateSource,
    bid_count: safeNumber(raw.bidCount),
    close_time_utc: endDate,
    status: "open",
    last_seen_at: nowIso,
    ...enrichmentFields(raw, false),
  };
}

type PlatformIngestResult = {
  upserted: number;
  pagesFetched: number;
  rowsParsed: number;
  rowsSkippedFx: number;
  total: number | null;
  lastStatus: number | null;
  fetchError: string | null;
  upsertError: string | null;
  responseKeys: string | null;
};

function emptyIngestResult(): PlatformIngestResult {
  return {
    upserted: 0, pagesFetched: 0, rowsParsed: 0, rowsSkippedFx: 0, total: null,
    lastStatus: null, fetchError: null, upsertError: null, responseKeys: null,
  };
}

function applyPageMeta(result: PlatformIngestResult, page: MaestroPage) {
  if (result.total === null && page.total !== null) result.total = page.total;
  result.lastStatus = page.status;
  if (page.errorMessage && !result.fetchError) result.fetchError = page.errorMessage;
  if (page.responseKeys && !result.responseKeys) result.responseKeys = page.responseKeys;
  result.pagesFetched++;
}

async function ingestPlatform(platform: Platform, fx: FxRates, nowIso: string): Promise<PlatformIngestResult> {
  const result = emptyIngestResult();

  for (let page = 1; page <= MAX_PAGES_PER_PLATFORM; page++) {
    const pageResult = await maestroFetch(SEARCH_LIST_PATH, buildSearchPayload(platform, page, PAGE_SIZE), {
      timeoutMs: PAGE_TIMEOUT_MS,
    });
    applyPageMeta(result, pageResult);
    if (pageResult.listings.length === 0) break;

    const rows = pageResult.listings
      .map((l) => parseListing(platform, l, fx, nowIso))
      .filter((r): r is AuctionRow => r !== null);
    result.rowsParsed += rows.length;
    result.rowsSkippedFx += rows.filter((r) => r.current_bid_usd === null).length;

    if (rows.length > 0) {
      const { error } = await supabaseAdmin.from("auctions").upsert(rows, { onConflict: "platform,asset_id" });
      if (!error) result.upserted += rows.length;
      else if (!result.upsertError) result.upsertError = error.message;
    }

    if (pageResult.listings.length < PAGE_SIZE) break;
    if (result.total !== null && page * PAGE_SIZE >= result.total) break;
  }

  return result;
}

type ClosureResult = { sold: number; nosale: number; unknown: number };

async function sweepClosures(nowIso: string): Promise<ClosureResult> {
  const { data, error } = await supabaseAdmin
    .from("auctions")
    .select("id, bid_count")
    .eq("status", "open")
    .lt("close_time_utc", nowIso);
  if (error || !data) return { sold: 0, nosale: 0, unknown: 0 };

  const nosaleIds: number[] = [];
  const unknownIds: number[] = [];
  for (const row of data) {
    const bids = row.bid_count ?? 0;
    if (bids > 0) {
      // A bid does not prove the reserve was met or that the auction closed
      // as sold. Keep it out of realized GMV unless a sold feed verifies it.
      unknownIds.push(row.id);
    } else {
      nosaleIds.push(row.id);
    }
  }

  if (nosaleIds.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < nosaleIds.length; i += CHUNK) {
      const chunk = nosaleIds.slice(i, i + CHUNK);
      await supabaseAdmin
        .from("auctions")
        .update({ status: "closed_nosale", final_price_usd: 0, closed_at: nowIso })
        .in("id", chunk);
    }
  }

  if (unknownIds.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < unknownIds.length; i += CHUNK) {
      const chunk = unknownIds.slice(i, i + CHUNK);
      await supabaseAdmin
        .from("auctions")
        .update({ status: "unknown", closed_at: nowIso })
        .in("id", chunk);
    }
  }

  return { sold: 0, nosale: nosaleIds.length, unknown: unknownIds.length };
}

export type AuctionsIngestResult = {
  allsurplus: PlatformIngestResult;
  govdeals: PlatformIngestResult;
  sold: { allsurplus: PlatformIngestResult; govdeals: PlatformIngestResult };
  closures: ClosureResult;
  rlsHint?: string;
};

type SoldAuctionRow = {
  platform: Platform;
  asset_id: string;
  seller_account_id: string | null;
  seller_company: string | null;
  category: string | null;
  currency_code: string | null;
  current_bid_usd: number | null;
  final_price_usd: number | null;
  sale_amount_native: number;
  fx_rate_used: number | null;
  fx_source: string;
  bid_count: number;
  close_time_utc: string | null;
  status: "closed_sold";
  closed_at: string;
  last_seen_at: string;
} & ReturnType<typeof enrichmentFields>;

function parseSoldListing(platform: Platform, raw: Record<string, unknown>, fx: FxRates, nowIso: string): SoldAuctionRow | null {
  const assetId = raw.assetId != null ? String(raw.assetId) : null;
  if (!assetId) return null;

  const currency = typeof raw.currencyCode === "string" && raw.currencyCode ? raw.currencyCode : "USD";
  const rawBid = safeNumber(raw.currentBid);
  const conv = convertToUsd(rawBid, currency, fx);
  const priceUsd = roundUsd(conv.usd);
  const endDate = typeof raw.assetAuctionEndDateUtc === "string" ? raw.assetAuctionEndDateUtc : null;

  return {
    platform,
    asset_id: assetId,
    seller_account_id: raw.accountId != null ? String(raw.accountId) : null,
    seller_company: typeof raw.companyName === "string" ? raw.companyName : null,
    category: typeof raw.categoryDescription === "string" ? raw.categoryDescription : null,
    currency_code: currency,
    current_bid_usd: priceUsd,
    final_price_usd: priceUsd,
    sale_amount_native: rawBid,
    fx_rate_used: conv.rateUsed,
    fx_source: conv.rateSource,
    bid_count: safeNumber(raw.bidCount),
    close_time_utc: endDate,
    status: "closed_sold",
    closed_at: nowIso,
    last_seen_at: nowIso,
    ...enrichmentFields(raw, true),
  };
}

// Fetches recently-sold auctions for one platform and upserts them as
// closed_sold with a final price. Matches (platform, asset_id) so it corrects
// rows we previously tracked as open, and inserts sold lots we never saw open.
async function ingestSoldPlatform(
  platform: Platform,
  fx: FxRates,
  nowIso: string,
  fromDate: string,
  toDate: string,
): Promise<PlatformIngestResult> {
  const result = emptyIngestResult();

  const seen = new Set<string>();
  for (let page = 1; page <= SOLD_MAX_PAGES; page++) {
    const pageResult = await maestroFetch(
      SOLD_SEARCH_PATH,
      buildSoldPayload(platform, fromDate, toDate, page, SOLD_PAGE_SIZE),
      { timeoutMs: PAGE_TIMEOUT_MS },
    );
    applyPageMeta(result, pageResult);
    if (pageResult.listings.length === 0) break;

    const rows = pageResult.listings
      .map((l) => parseSoldListing(platform, l, fx, nowIso))
      .filter((r): r is SoldAuctionRow => r !== null)
      .filter((r) => {
        const key = `${r.platform}:${r.asset_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    result.rowsParsed += rows.length;
    result.rowsSkippedFx += rows.filter((r) => r.final_price_usd === null).length;

    if (rows.length > 0) {
      const { error } = await supabaseAdmin.from("auctions").upsert(rows, { onConflict: "platform,asset_id" });
      if (!error) result.upserted += rows.length;
      else if (!result.upsertError) result.upsertError = error.message;
    }

    if (pageResult.listings.length < SOLD_PAGE_SIZE) break;
    if (result.total !== null && page * SOLD_PAGE_SIZE >= result.total) break;
  }

  return result;
}

async function ingestSoldAuctions(fx: FxRates, nowIso: string) {
  const toDate = nowIso;
  const fromDate = new Date(Date.now() - SOLD_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const [allsurplus, govdeals] = await Promise.all([
    ingestSoldPlatform("AD", fx, nowIso, fromDate, toDate),
    ingestSoldPlatform("GD", fx, nowIso, fromDate, toDate),
  ]);
  return { allsurplus, govdeals };
}

export async function ingestAuctions(): Promise<AuctionsIngestResult> {
  const fx = await loadFxRates();
  // Persist the day's rates for the audit trail (best-effort; never blocks).
  void persistFxRates(fx);
  const nowIso = new Date().toISOString();

  const [allsurplus, govdeals] = await Promise.all([
    ingestPlatform("AD", fx, nowIso),
    ingestPlatform("GD", fx, nowIso),
  ]);

  // Mark recently-sold auctions before sweeping the rest closed, so a lot that
  // sold isn't misfiled as closed_nosale/unknown.
  const sold = await ingestSoldAuctions(fx, nowIso);

  const closures = await sweepClosures(nowIso);

  const result: AuctionsIngestResult = { allsurplus, govdeals, sold, closures };

  // If we parsed rows but upserted zero, it's almost always RLS blocking writes.
  const parsed = allsurplus.rowsParsed + govdeals.rowsParsed;
  const upserted = allsurplus.upserted + govdeals.upserted;
  if (parsed > 0 && upserted === 0) {
    result.rlsHint =
      "Parsed rows but upserted 0. The auctions writer uses the Supabase service role; " +
      "verify SUPABASE_SECRET_KEY is set (service role bypasses RLS).";
  }

  return result;
}

// ---------------------------------------------------------------------------
// Revenue forecast (unchanged model; shared date helpers)
// ---------------------------------------------------------------------------

export type RevenueForecast = {
  quarter: string;
  quarter_start: string;
  quarter_end: string;
  take_rate: number;
  /** Whether `quarter` is the live (current) quarter — false for historical views. */
  is_current: boolean;
  /** All selectable quarter labels (earliest data quarter → current), chronological. */
  available_quarters: string[];
  /** Earliest YYYY-MM-DD with GMV data (drives date-input min bounds). */
  earliest_data_date: string;
  platforms: {
    platform: "AD" | "GD";
    realized_gmv_usd: number;
    realized_revenue_usd: number;
    auctions_closed: number;
    auctions_sold: number;
    close_rate: number;
    avg_hammer_usd: number;
    realized_source: "historical_export" | "tracked_auctions";
    projection_model: string;
    scheduled_open_auctions: number;
    scheduled_open_bid_usd: number;
    projected_remaining_gmv_usd: number;
    projected_remaining_revenue_usd: number;
    projected_total_gmv_usd: number;
    projected_total_revenue_usd: number;
  }[];
  daily: {
    date: string;
    realized_gmv_usd: number;
    domestic_realized_gmv_usd: number;
    international_realized_gmv_usd: number;
    projected_gmv_usd: number;
    // Per-source realized (true marketplace). GI is historical-only.
    ad_realized_gmv_usd: number;
    gd_realized_gmv_usd: number;
    gi_realized_gmv_usd: number;
    realized_revenue_usd: number;
    domestic_realized_revenue_usd: number;
    international_realized_revenue_usd: number;
    projected_revenue_usd: number;
    ad_realized_revenue_usd: number;
    gd_realized_revenue_usd: number;
    gi_realized_revenue_usd: number;
  }[];
  projected_total_gmv_usd: number;
  projected_total_revenue_usd: number;
  /** Realized-only totals (exclude the current-quarter projection). */
  realized_total_gmv_usd: number;
  realized_total_revenue_usd: number;
  debug: {
    now_iso: string;
    total_rows: number;
    by_platform: Record<string, number>;
    by_status: Record<string, number>;
    with_close_time: number;
    without_close_time: number;
    in_quarter_open: number;
    in_quarter_closed: number;
    min_close_time: string | null;
    max_close_time: string | null;
    sample_row: Record<string, unknown> | null;
  };
};

function earliestHistoricalDate(data: HistoricalDailyGmvData) {
  let earliest: string | null = null;
  for (const date of data.totals.keys()) {
    if (earliest === null || date < earliest) earliest = date;
  }
  return earliest;
}

// Quarter label ("YYYYQn") for an ET-bucketed date key ("YYYY-MM-DD"). The key
// is already ET-bucketed, so the quarter derives directly from its month.
function quarterLabelForDateKey(key: string): string {
  const [y, m] = key.split("-").map(Number);
  const q = Math.floor(((m || 1) - 1) / 3) + 1;
  return `${y}Q${q}`;
}

type ClosedAuctionForProjection = {
  status: string | null;
  final_price_usd: number | null;
  current_bid_usd: number | null;
  close_time_utc: string | null;
  category: string | null;
  bid_count: number | null;
};

type OpenAuctionForProjection = {
  current_bid_usd: number | null;
  close_time_utc: string | null;
  category: string | null;
  bid_count: number | null;
};

type ProjectedOpenAuction = OpenAuctionForProjection & {
  projected_gmv_usd: number;
};

type ProjectionStatsAccumulator = {
  closed: number;
  sold: number;
  realizedGmv: number;
};

type ProjectionStats = ProjectionStatsAccumulator & {
  closeRate: number;
  avgHammer: number;
};

type ProjectionModel = {
  platform: ProjectionStats;
  categories: Map<string, ProjectionStats>;
  segments: Map<string, ProjectionStats>;
};

const MIN_SEGMENT_CLOSED = 3;
const MIN_CATEGORY_CLOSED = 5;

function emptyProjectionAccumulator(): ProjectionStatsAccumulator {
  return { closed: 0, sold: 0, realizedGmv: 0 };
}

function addClosedAuction(stats: ProjectionStatsAccumulator, row: ClosedAuctionForProjection) {
  stats.closed += 1;
  if (row.status !== "closed_sold") return;

  const finalPrice = row.final_price_usd ?? 0;
  if (finalPrice <= 0) return;
  stats.sold += 1;
  stats.realizedGmv += finalPrice;
}

function finalizeProjectionStats(
  stats: ProjectionStatsAccumulator,
  fallbackAvgHammer: number,
  fallbackCloseRate = DEFAULT_CLOSE_RATE,
): ProjectionStats {
  return {
    ...stats,
    closeRate: stats.closed > 0 ? stats.sold / stats.closed : fallbackCloseRate,
    avgHammer: stats.sold > 0 ? stats.realizedGmv / stats.sold : fallbackAvgHammer,
  };
}

function categoryKey(category: string | null | undefined) {
  return category?.trim().toLowerCase() || "uncategorized";
}

function priceBand(amount: number) {
  if (amount <= 0) return "0";
  if (amount < 1_000) return "lt_1k";
  if (amount < 10_000) return "1k_10k";
  if (amount < 100_000) return "10k_100k";
  return "100k_plus";
}

function bidBand(bidCount: number) {
  if (bidCount <= 0) return "0";
  if (bidCount < 5) return "1_4";
  if (bidCount < 15) return "5_14";
  return "15_plus";
}

function segmentKey(row: { category: string | null; current_bid_usd: number | null; final_price_usd?: number | null; bid_count: number | null }) {
  const amount = Math.max(0, row.current_bid_usd ?? row.final_price_usd ?? 0);
  return `${categoryKey(row.category)}|${priceBand(amount)}|${bidBand(row.bid_count ?? 0)}`;
}

function buildProjectionModel(closed: ClosedAuctionForProjection[], fallbackAvgHammer: number): ProjectionModel {
  const platformAccumulator = emptyProjectionAccumulator();
  const categoryAccumulators = new Map<string, ProjectionStatsAccumulator>();
  const segmentAccumulators = new Map<string, ProjectionStatsAccumulator>();

  for (const row of closed) {
    addClosedAuction(platformAccumulator, row);

    const category = categoryKey(row.category);
    const categoryStats = categoryAccumulators.get(category) ?? emptyProjectionAccumulator();
    addClosedAuction(categoryStats, row);
    categoryAccumulators.set(category, categoryStats);

    const segment = segmentKey(row);
    const segmentStats = segmentAccumulators.get(segment) ?? emptyProjectionAccumulator();
    addClosedAuction(segmentStats, row);
    segmentAccumulators.set(segment, segmentStats);
  }

  const platform = finalizeProjectionStats(platformAccumulator, fallbackAvgHammer);
  const categories = new Map<string, ProjectionStats>();
  for (const [category, stats] of categoryAccumulators) {
    categories.set(category, finalizeProjectionStats(stats, platform.avgHammer, platform.closeRate));
  }

  const segments = new Map<string, ProjectionStats>();
  for (const [segment, stats] of segmentAccumulators) {
    const category = segment.split("|", 1)[0] || "uncategorized";
    const fallback = categories.get(category) ?? platform;
    segments.set(segment, finalizeProjectionStats(stats, fallback.avgHammer, fallback.closeRate));
  }

  return { platform, categories, segments };
}

function chooseProjectionStats(row: OpenAuctionForProjection, model: ProjectionModel) {
  const segment = model.segments.get(segmentKey(row));
  if (segment && segment.closed >= MIN_SEGMENT_CLOSED) return segment;

  const category = model.categories.get(categoryKey(row.category));
  if (category && category.closed >= MIN_CATEGORY_CLOSED) return category;

  return model.platform;
}

function estimateOpenAuctionGmv(row: OpenAuctionForProjection, model: ProjectionModel) {
  const stats = chooseProjectionStats(row, model);
  const currentBid = Math.max(0, row.current_bid_usd ?? 0);
  return stats.closeRate * Math.max(currentBid, stats.avgHammer);
}

function sumHistoricalPlatform(
  data: HistoricalDailyGmvData,
  platform: "AD" | "GD",
  quarterDaySet: Set<string>,
) {
  let gmv = 0;
  let soldLots = 0;
  const rows = data.platforms.get(platform);
  if (!rows) return { gmv, soldLots };

  for (const [date, row] of rows) {
    if (!quarterDaySet.has(date)) continue;
    gmv += row.gmv;
    soldLots += row.soldLots;
  }
  return { gmv, soldLots };
}

async function collectDebug(nowIso: string, startIso: string, endIso: string) {
  const [allRes, sampleRes] = await Promise.all([
    supabase.from("auctions").select("platform, status, close_time_utc"),
    supabase.from("auctions").select("*").limit(1),
  ]);
  const rows = allRes.data ?? [];
  const by_platform: Record<string, number> = {};
  const by_status: Record<string, number> = {};
  let with_close_time = 0;
  let without_close_time = 0;
  let in_quarter_open = 0;
  let in_quarter_closed = 0;
  let min_close_time: string | null = null;
  let max_close_time: string | null = null;
  for (const r of rows as { platform: string; status: string; close_time_utc: string | null }[]) {
    by_platform[r.platform] = (by_platform[r.platform] ?? 0) + 1;
    by_status[r.status] = (by_status[r.status] ?? 0) + 1;
    if (r.close_time_utc) {
      with_close_time++;
      if (min_close_time === null || r.close_time_utc < min_close_time) min_close_time = r.close_time_utc;
      if (max_close_time === null || r.close_time_utc > max_close_time) max_close_time = r.close_time_utc;
      const inQ = r.close_time_utc >= startIso && r.close_time_utc < endIso;
      if (inQ) {
        if (r.status === "open" && r.close_time_utc >= nowIso) in_quarter_open++;
        if (r.status === "closed_sold" || r.status === "closed_nosale") in_quarter_closed++;
      }
    } else {
      without_close_time++;
    }
  }
  return {
    now_iso: nowIso,
    total_rows: rows.length,
    by_platform,
    by_status,
    with_close_time,
    without_close_time,
    in_quarter_open,
    in_quarter_closed,
    min_close_time,
    max_close_time,
    sample_row: (sampleRes.data?.[0] as Record<string, unknown> | undefined) ?? null,
  };
}

export async function computeRevenueForecast(takeRate = 0.2, quarterLabel?: string): Promise<RevenueForecast> {
  const now = new Date();
  const nowIso = now.toISOString();
  const current = quarterBounds(now);
  const historicalDailyGmv = await loadHistoricalDailyGmv();

  // Selectable quarters: earliest data quarter (from the historical export)
  // through the current quarter.
  const historicalStartKey = earliestHistoricalDate(historicalDailyGmv);
  const earliestLabel = historicalStartKey ? quarterLabelForDateKey(historicalStartKey) : current.label;
  const availableQuarters = enumerateQuarterLabelsBetween(earliestLabel, current.label);

  // Resolve the view. "ALL" spans the earliest data day through the current
  // quarter end — the full daily GMV history in one series. Otherwise a single
  // quarter (falling back to the current one for missing/malformed labels).
  // Historical days are fully realized; the open-auction projection query
  // returns nothing for them, so only the live tail carries a projection.
  const wantsAll = (quarterLabel ?? "").trim().toUpperCase() === "ALL";
  let start: Date;
  let end: Date;
  let label: string;
  let isCurrent: boolean;
  if (wantsAll) {
    const earliestStart = (historicalStartKey ? dateKeyToUtcDate(historicalStartKey) : null) ?? current.start;
    start = earliestStart < current.start ? earliestStart : current.start;
    end = current.end;
    label = "ALL";
    isCurrent = true; // includes the live quarter → keep projection + today line
  } else {
    const selected = (quarterLabel ? parseQuarterLabel(quarterLabel) : null) ?? current;
    start = selected.start;
    end = selected.end;
    label = selected.label;
    isCurrent = label === current.label;
  }
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const quarterDays = enumerateDays(start, end);
  const quarterDaySet = new Set(quarterDays);
  const chartDays = quarterDays;
  const chartDaySet = quarterDaySet;

  const platforms: ("AD" | "GD")[] = ["AD", "GD"];
  const perPlatform = await Promise.all(
    platforms.map(async (platform) => {
      const historical = sumHistoricalPlatform(historicalDailyGmv, platform, quarterDaySet);
      const [closedRes, openRes] = await Promise.all([
        supabase
          .from("auctions")
          .select("status, final_price_usd, current_bid_usd, close_time_utc, category, bid_count")
          .eq("platform", platform)
          .gte("close_time_utc", startIso)
          .lt("close_time_utc", endIso)
          .in("status", ["closed_sold", "closed_nosale"]),
        supabase
          .from("auctions")
          .select("current_bid_usd, close_time_utc, category, bid_count")
          .eq("platform", platform)
          .eq("status", "open")
          .gte("close_time_utc", nowIso)
          .lt("close_time_utc", endIso),
      ]);

      const closed = (closedRes.data ?? []) as ClosedAuctionForProjection[];
      const open = (openRes.data ?? []) as OpenAuctionForProjection[];
      const sold = closed.filter((r) => r.status === "closed_sold");
      const trackedRealizedGmv = sold.reduce((s, r) => s + (r.final_price_usd ?? 0), 0);
      const realizedSource: "historical_export" | "tracked_auctions" =
        historical.gmv > 0 ? "historical_export" : "tracked_auctions";
      const realizedGmv = realizedSource === "historical_export" ? historical.gmv : trackedRealizedGmv;
      const auctionsSold = realizedSource === "historical_export" ? historical.soldLots : sold.length;
      const fallbackAvgHammer =
        historical.soldLots > 0
          ? historical.gmv / historical.soldLots
          : sold.length > 0
            ? trackedRealizedGmv / sold.length
            : 0;
      const model = buildProjectionModel(closed, fallbackAvgHammer);
      const openBid = open.reduce((s, r) => s + (r.current_bid_usd ?? 0), 0);
      const openProjections: ProjectedOpenAuction[] = open.map((row) => ({
        ...row,
        projected_gmv_usd: estimateOpenAuctionGmv(row, model),
      }));
      const projectedOpenGmv = openProjections.reduce((s, r) => s + r.projected_gmv_usd, 0);
      const projectionModel =
        model.segments.size > 0
          ? "segment/category/platform blend"
          : model.categories.size > 0
            ? "category/platform blend"
            : "platform fallback";

      return {
        platform,
        closed,
        open,
        openProjections,
        sold,
        realizedGmv,
        auctionsSold,
        realizedSource,
        closeRate: model.platform.closeRate,
        avgHammer: model.platform.avgHammer,
        openBid,
        projectedOpenGmv,
        projectionModel,
      };
    }),
  );

  const emptyBySource = (): Record<SourceKey, number> => ({ AD: 0, GD: 0, GI: 0 });
  const dailyMap = new Map<
    string,
    { realized: HistoricalDailyGmv; bySource: Record<SourceKey, number>; projected: number; hasHistoricalRealized: boolean }
  >();
  for (const day of chartDays) {
    const realized = historicalDailyGmv.totals.get(day);
    const bySource = emptyBySource();
    if (realized) {
      for (const src of SOURCE_KEYS) bySource[src] = historicalDailyGmv.platforms.get(src)?.get(day)?.gmv ?? 0;
    }
    dailyMap.set(day, {
      realized: realized ? { ...realized } : emptyHistoricalDailyGmv(),
      bySource,
      projected: 0,
      hasHistoricalRealized: Boolean(realized),
    });
  }
  for (const p of perPlatform) {
    for (const row of p.sold) {
      if (!row.close_time_utc) continue;
      const key = etDateKey(row.close_time_utc);
      if (!chartDaySet.has(key)) continue;
      const bucket = dailyMap.get(key);
      if (!bucket) continue;
      if (!bucket.hasHistoricalRealized) {
        const amount = row.final_price_usd ?? 0;
        bucket.realized.all += amount;
        bucket.realized.domestic += amount;
        if (amount > 0) bucket.realized.soldLots += 1;
        // Tracked auctions only cover AD/GD (GI is historical-only).
        bucket.bySource[p.platform] += amount;
      }
    }
    for (const row of p.openProjections) {
      if (!row.close_time_utc) continue;
      const key = etDateKey(row.close_time_utc);
      if (!chartDaySet.has(key)) continue;
      const bucket = dailyMap.get(key);
      if (!bucket) continue;
      bucket.projected += row.projected_gmv_usd;
    }
  }

  const daily = chartDays.map((date) => {
    const v = dailyMap.get(date) ?? { realized: emptyHistoricalDailyGmv(), bySource: emptyBySource(), projected: 0 };
    return {
      date,
      realized_gmv_usd: Math.round(v.realized.all),
      domestic_realized_gmv_usd: Math.round(v.realized.domestic),
      international_realized_gmv_usd: Math.round(v.realized.international),
      projected_gmv_usd: Math.round(v.projected),
      ad_realized_gmv_usd: Math.round(v.bySource.AD),
      gd_realized_gmv_usd: Math.round(v.bySource.GD),
      gi_realized_gmv_usd: Math.round(v.bySource.GI),
      realized_revenue_usd: Math.round(v.realized.all * takeRate),
      domestic_realized_revenue_usd: Math.round(v.realized.domestic * takeRate),
      international_realized_revenue_usd: Math.round(v.realized.international * takeRate),
      projected_revenue_usd: Math.round(v.projected * takeRate),
      ad_realized_revenue_usd: Math.round(v.bySource.AD * takeRate),
      gd_realized_revenue_usd: Math.round(v.bySource.GD * takeRate),
      gi_realized_revenue_usd: Math.round(v.bySource.GI * takeRate),
    };
  });

  const rows = perPlatform.map((p) => {
    const totalGmv = p.realizedGmv + p.projectedOpenGmv;
    return {
      platform: p.platform,
      realized_gmv_usd: Math.round(p.realizedGmv),
      realized_revenue_usd: Math.round(p.realizedGmv * takeRate),
      auctions_closed: p.closed.length,
      auctions_sold: p.auctionsSold,
      close_rate: Math.round(p.closeRate * 10000) / 10000,
      avg_hammer_usd: Math.round(p.avgHammer),
      realized_source: p.realizedSource,
      projection_model: p.projectionModel,
      scheduled_open_auctions: p.open.length,
      scheduled_open_bid_usd: Math.round(p.openBid),
      projected_remaining_gmv_usd: Math.round(p.projectedOpenGmv),
      projected_remaining_revenue_usd: Math.round(p.projectedOpenGmv * takeRate),
      projected_total_gmv_usd: Math.round(totalGmv),
      projected_total_revenue_usd: Math.round(totalGmv * takeRate),
    };
  });

  const quarterDaily = daily.filter((row) => quarterDaySet.has(row.date));
  const projected_total_gmv_usd = quarterDaily.reduce((s, r) => s + r.realized_gmv_usd + r.projected_gmv_usd, 0);
  const projected_total_revenue_usd = quarterDaily.reduce((s, r) => s + r.realized_revenue_usd + r.projected_revenue_usd, 0);
  // Realized-only totals: used as the "all data" headline (which is historical,
  // so it must exclude the current quarter's open-auction projection).
  const realized_total_gmv_usd = quarterDaily.reduce((s, r) => s + r.realized_gmv_usd, 0);
  const realized_total_revenue_usd = quarterDaily.reduce((s, r) => s + r.realized_revenue_usd, 0);

  const debug = await collectDebug(nowIso, startIso, endIso);

  return {
    quarter: label,
    quarter_start: startIso,
    quarter_end: endIso,
    take_rate: takeRate,
    is_current: isCurrent,
    available_quarters: availableQuarters,
    // Earliest day for which we have GMV data (drives date-input min bounds so
    // users can't query dates with no data). Falls back to the view start.
    earliest_data_date: historicalStartKey ?? start.toISOString().slice(0, 10),
    platforms: rows,
    daily,
    projected_total_gmv_usd,
    projected_total_revenue_usd,
    realized_total_gmv_usd,
    realized_total_revenue_usd,
    debug,
  };
}
