import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { supabase } from "./supabase";

const MAESTRO_URL = process.env.MAESTRO_API_URL || "https://maestro.lqdt1.com";
const MAESTRO_KEY =
  process.env.MAESTRO_API_KEY || "af93060f-337e-428c-87b8-c74b5837d6cd";

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

const CURRENCY_MAP: Record<string, string> = {
  USD: "USD", ZAR: "ZAR", EUR: "EUR", GBP: "GBP", CAD: "CAD",
  AUD: "AUD", INR: "INR", BRL: "BRL", MXN: "MXN", JPY: "JPY",
};

let cachedRates: Record<string, number> | null = null;
let ratesFetchedAt = 0;
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

type HistoricalDailyGmvData = {
  totals: Map<string, HistoricalDailyGmv>;
  platforms: Map<"AD" | "GD", Map<string, HistoricalPlatformDailyGmv>>;
};

function historicalCsvPath(rawPath: string | undefined, fallbackFile: string) {
  const normalized = (rawPath || fallbackFile).replace(/\\/g, "/");
  const fileName = path.basename(normalized);
  return path.join(HISTORICAL_GMV_DIR, fileName.endsWith(".csv") ? fileName : fallbackFile);
}

async function fetchUsdRates(): Promise<Record<string, number>> {
  if (cachedRates && Date.now() - ratesFetchedAt < 3600_000) return cachedRates;
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return cachedRates ?? {};
    const data = await res.json();
    const rates: Record<string, number> = data.rates ?? {};
    cachedRates = rates;
    ratesFetchedAt = Date.now();
    return rates;
  } catch {
    return cachedRates ?? {};
  }
}

// Returns the USD-equivalent amount, or null if the currency is non-USD and
// no rate is available. Returning null is important: storing the raw amount
// would silently pollute current_bid_usd / final_price_usd with foreign-
// currency values labeled as USD.
function toUsd(amount: number, currencyCode: string, rates: Record<string, number>): number | null {
  if (!currencyCode || currencyCode === "USD") return amount;
  const code = CURRENCY_MAP[currencyCode] ?? currencyCode;
  const rate = rates[code];
  if (rate && rate > 0) return amount / rate;
  return null;
}

function safeNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && !Number.isNaN(value)) return value;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

function emptyHistoricalDailyGmv(): HistoricalDailyGmv {
  return { all: 0, domestic: 0, international: 0, soldLots: 0 };
}

function emptyHistoricalDailyGmvData(): HistoricalDailyGmvData {
  return {
    totals: new Map(),
    platforms: new Map([
      ["AD", new Map()],
      ["GD", new Map()],
    ]),
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

      if (businessId === "AD" || businessId === "GD") {
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

function buildPayload(businessId: "AD" | "GD", page: number) {
  return {
    category: "",
    groupIds: [],
    businessId,
    searchText: "",
    isQAL: false,
    locationId: null,
    model: "",
    makebrand: "",
    accountIds: [],
    eventId: null,
    auctionTypeId: null,
    page,
    displayRows: PAGE_SIZE,
    sortField: "bestfit",
    sortOrder: "asc",
    requestType: "search",
    responseStyle: "",
    facets: [],
    facetsFilter: [],
    timeType: "atauction",
    sellerTypeId: null,
  };
}

type AuctionRow = {
  platform: "AD" | "GD";
  asset_id: string;
  seller_account_id: string | null;
  seller_company: string | null;
  category: string | null;
  currency_code: string | null;
  current_bid_usd: number | null;
  bid_count: number;
  close_time_utc: string | null;
  status: "open";
  last_seen_at: string;
};

function parseListing(platform: "AD" | "GD", raw: Record<string, unknown>, rates: Record<string, number>, nowIso: string): AuctionRow | null {
  const assetId = raw.assetId != null ? String(raw.assetId) : null;
  if (!assetId) return null;

  const currency = typeof raw.currencyCode === "string" ? raw.currencyCode : "USD";
  const rawBid = safeNumber(raw.currentBid);
  const usd = toUsd(rawBid, currency, rates);
  const currentBidUsd = usd === null ? null : Math.round(usd * 100) / 100;
  const endDate = typeof raw.assetAuctionEndDateUtc === "string" ? raw.assetAuctionEndDateUtc : null;

  return {
    platform,
    asset_id: assetId,
    seller_account_id: raw.accountId != null ? String(raw.accountId) : null,
    seller_company: typeof raw.companyName === "string" ? raw.companyName : null,
    category: typeof raw.categoryDescription === "string" ? raw.categoryDescription : null,
    currency_code: currency,
    current_bid_usd: currentBidUsd,
    bid_count: safeNumber(raw.bidCount),
    close_time_utc: endDate,
    status: "open",
    last_seen_at: nowIso,
  };
}

type FetchPageResult = {
  listings: Record<string, unknown>[];
  total: number | null;
  status: number | null;
  errorMessage: string | null;
  responseKeys: string | null;
};

async function fetchPage(platform: "AD" | "GD", page: number): Promise<FetchPageResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(`${MAESTRO_URL}/search/list`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": MAESTRO_KEY,
        "x-user-id": "-1",
        "x-api-correlation-id": randomUUID(),
      },
      body: JSON.stringify(buildPayload(platform, page)),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { listings: [], total: null, status: res.status, errorMessage: `http ${res.status}: ${body.slice(0, 200)}`, responseKeys: null };
    }
    const data = await res.json();
    const headerCount = res.headers.get("x-total-count");
    const total = headerCount ? parseInt(headerCount, 10) || null : null;
    let listings: Record<string, unknown>[] = [];
    if (Array.isArray(data?.assetSearchResults)) listings = data.assetSearchResults;
    else if (Array.isArray(data?.searchResults)) listings = data.searchResults;
    else if (Array.isArray(data)) listings = data;
    const responseKeys = data && !Array.isArray(data) ? Object.keys(data).slice(0, 10).join(",") : null;
    return { listings, total, status: res.status, errorMessage: null, responseKeys };
  } catch (e) {
    return { listings: [], total: null, status: null, errorMessage: `fetch error: ${e instanceof Error ? e.message : String(e)}`, responseKeys: null };
  } finally {
    clearTimeout(timeout);
  }
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

async function ingestPlatform(platform: "AD" | "GD", rates: Record<string, number>, nowIso: string): Promise<PlatformIngestResult> {
  const result: PlatformIngestResult = {
    upserted: 0, pagesFetched: 0, rowsParsed: 0, rowsSkippedFx: 0, total: null,
    lastStatus: null, fetchError: null, upsertError: null, responseKeys: null,
  };

  for (let page = 1; page <= MAX_PAGES_PER_PLATFORM; page++) {
    const { listings, total, status, errorMessage, responseKeys } = await fetchPage(platform, page);
    if (result.total === null && total !== null) result.total = total;
    result.lastStatus = status;
    if (errorMessage && !result.fetchError) result.fetchError = errorMessage;
    if (responseKeys && !result.responseKeys) result.responseKeys = responseKeys;
    result.pagesFetched++;
    if (listings.length === 0) break;

    const rows = listings
      .map((l) => parseListing(platform, l, rates, nowIso))
      .filter((r): r is AuctionRow => r !== null);
    result.rowsParsed += rows.length;
    result.rowsSkippedFx += rows.filter((r) => r.current_bid_usd === null).length;

    if (rows.length > 0) {
      const { error } = await supabase
        .from("auctions")
        .upsert(rows, { onConflict: "platform,asset_id" });
      if (!error) result.upserted += rows.length;
      else if (!result.upsertError) result.upsertError = error.message;
    }

    if (listings.length < PAGE_SIZE) break;
    if (result.total !== null && page * PAGE_SIZE >= result.total) break;
  }

  return result;
}

type ClosureResult = { sold: number; nosale: number; unknown: number };

async function sweepClosures(nowIso: string): Promise<ClosureResult> {
  const { data, error } = await supabase
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
      // as sold.
      // Keep it out of realized GMV unless a sold feed verifies it.
      unknownIds.push(row.id);
    } else {
      nosaleIds.push(row.id);
    }
  }

  if (nosaleIds.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < nosaleIds.length; i += CHUNK) {
      const chunk = nosaleIds.slice(i, i + CHUNK);
      await supabase
        .from("auctions")
        .update({ status: "closed_nosale", final_price_usd: 0, closed_at: nowIso })
        .in("id", chunk);
    }
  }

  if (unknownIds.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < unknownIds.length; i += CHUNK) {
      const chunk = unknownIds.slice(i, i + CHUNK);
      await supabase
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
  platform: "AD" | "GD";
  asset_id: string;
  seller_account_id: string | null;
  seller_company: string | null;
  category: string | null;
  currency_code: string | null;
  current_bid_usd: number | null;
  final_price_usd: number | null;
  bid_count: number;
  close_time_utc: string | null;
  status: "closed_sold";
  closed_at: string;
  last_seen_at: string;
};

function buildSoldPayload(businessId: "AD" | "GD", fromDate: string, toDate: string, page: number) {
  return {
    businessId,
    category: "",
    subCategory: "",
    groupIds: [],
    searchText: "",
    isQAL: false,
    locationId: null,
    model: "",
    makebrand: "",
    accountIds: [],
    agencies: [],
    eventId: null,
    auctionTypeId: null,
    page,
    displayRows: SOLD_PAGE_SIZE,
    sortField: "currentBid",
    sortOrder: "desc",
    requestType: "search",
    responseStyle: "",
    facets: [],
    facetsFilter: [],
    timeType: "",
    sellerTypeId: null,
    rangeTimeSearchType: "sold",
    fromDate,
    toDate,
  };
}

function parseSoldListing(
  platform: "AD" | "GD",
  raw: Record<string, unknown>,
  rates: Record<string, number>,
  nowIso: string,
): SoldAuctionRow | null {
  const assetId = raw.assetId != null ? String(raw.assetId) : null;
  if (!assetId) return null;

  const currency = typeof raw.currencyCode === "string" && raw.currencyCode ? raw.currencyCode : "USD";
  const rawBid = safeNumber(raw.currentBid);
  const usd = toUsd(rawBid, currency, rates);
  const priceUsd = usd === null ? null : Math.round(usd * 100) / 100;
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
    bid_count: safeNumber(raw.bidCount),
    close_time_utc: endDate,
    status: "closed_sold",
    closed_at: nowIso,
    last_seen_at: nowIso,
  };
}

async function fetchSoldPage(
  platform: "AD" | "GD",
  fromDate: string,
  toDate: string,
  page: number,
): Promise<FetchPageResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(`${MAESTRO_URL}/search/assets/advanced`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": MAESTRO_KEY,
        "x-user-id": "-1",
        "x-api-correlation-id": randomUUID(),
      },
      body: JSON.stringify(buildSoldPayload(platform, fromDate, toDate, page)),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { listings: [], total: null, status: res.status, errorMessage: `http ${res.status}: ${body.slice(0, 200)}`, responseKeys: null };
    }
    const data = await res.json();
    const headerCount = res.headers.get("x-total-count");
    const total = headerCount ? parseInt(headerCount, 10) || null : null;
    let listings: Record<string, unknown>[] = [];
    if (Array.isArray(data?.assetSearchResults)) listings = data.assetSearchResults;
    else if (Array.isArray(data?.searchResults)) listings = data.searchResults;
    else if (Array.isArray(data)) listings = data;
    const responseKeys = data && !Array.isArray(data) ? Object.keys(data).slice(0, 10).join(",") : null;
    return { listings, total, status: res.status, errorMessage: null, responseKeys };
  } catch (e) {
    return { listings: [], total: null, status: null, errorMessage: `fetch error: ${e instanceof Error ? e.message : String(e)}`, responseKeys: null };
  } finally {
    clearTimeout(timeout);
  }
}

// Fetches recently-sold auctions for one platform and upserts them as
// closed_sold with a final price. Matches (platform, asset_id) so it corrects
// rows we previously tracked as open, and inserts sold lots we never saw open.
async function ingestSoldPlatform(
  platform: "AD" | "GD",
  rates: Record<string, number>,
  nowIso: string,
  fromDate: string,
  toDate: string,
): Promise<PlatformIngestResult> {
  const result: PlatformIngestResult = {
    upserted: 0, pagesFetched: 0, rowsParsed: 0, rowsSkippedFx: 0, total: null,
    lastStatus: null, fetchError: null, upsertError: null, responseKeys: null,
  };

  const seen = new Set<string>();
  for (let page = 1; page <= SOLD_MAX_PAGES; page++) {
    const { listings, total, status, errorMessage, responseKeys } = await fetchSoldPage(platform, fromDate, toDate, page);
    if (result.total === null && total !== null) result.total = total;
    result.lastStatus = status;
    if (errorMessage && !result.fetchError) result.fetchError = errorMessage;
    if (responseKeys && !result.responseKeys) result.responseKeys = responseKeys;
    result.pagesFetched++;
    if (listings.length === 0) break;

    const rows = listings
      .map((l) => parseSoldListing(platform, l, rates, nowIso))
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
      const { error } = await supabase
        .from("auctions")
        .upsert(rows, { onConflict: "platform,asset_id" });
      if (!error) result.upserted += rows.length;
      else if (!result.upsertError) result.upsertError = error.message;
    }

    if (listings.length < SOLD_PAGE_SIZE) break;
    if (result.total !== null && page * SOLD_PAGE_SIZE >= result.total) break;
  }

  return result;
}

async function ingestSoldAuctions(rates: Record<string, number>, nowIso: string) {
  const toDate = nowIso;
  const fromDate = new Date(Date.now() - SOLD_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const [allsurplus, govdeals] = await Promise.all([
    ingestSoldPlatform("AD", rates, nowIso, fromDate, toDate),
    ingestSoldPlatform("GD", rates, nowIso, fromDate, toDate),
  ]);
  return { allsurplus, govdeals };
}

export async function ingestAuctions(): Promise<AuctionsIngestResult> {
  const rates = await fetchUsdRates();
  const nowIso = new Date().toISOString();

  const [allsurplus, govdeals] = await Promise.all([
    ingestPlatform("AD", rates, nowIso),
    ingestPlatform("GD", rates, nowIso),
  ]);

  // Mark recently-sold auctions before sweeping the rest closed, so a lot that
  // sold isn't misfiled as closed_nosale/unknown.
  const sold = await ingestSoldAuctions(rates, nowIso);

  const closures = await sweepClosures(nowIso);

  const result: AuctionsIngestResult = { allsurplus, govdeals, sold, closures };

  // If we parsed rows but upserted zero, it's almost always RLS blocking writes.
  const parsed = allsurplus.rowsParsed + govdeals.rowsParsed;
  const upserted = allsurplus.upserted + govdeals.upserted;
  if (parsed > 0 && upserted === 0) {
    result.rlsHint =
      "Parsed rows but upserted 0. Likely RLS: auctions table has no insert policy for the anon role. " +
      "Add one: create policy \"anon write\" on auctions for all using (true) with check (true);";
  }

  return result;
}

export type RevenueForecast = {
  quarter: string;
  quarter_start: string;
  quarter_end: string;
  take_rate: number;
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
    realized_revenue_usd: number;
    domestic_realized_revenue_usd: number;
    international_realized_revenue_usd: number;
    projected_revenue_usd: number;
  }[];
  projected_total_gmv_usd: number;
  projected_total_revenue_usd: number;
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

function quarterBounds(d: Date): { start: Date; end: Date; label: string } {
  // Determine the quarter from the Eastern-time calendar date, matching the ET
  // day bucketing used everywhere else (see etDateKey / auction_daily_stats).
  // Using UTC here flipped the quarter ~4-5h early at the boundary, so on the
  // evening of the last day of a quarter (ET) the dashboard jumped to the next
  // quarter — which has no data yet — and showed all zeros.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(d);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value); // 1-based
  const q = Math.floor((month - 1) / 3);
  const start = new Date(Date.UTC(y, q * 3, 1));
  const end = new Date(Date.UTC(y, q * 3 + 3, 1));
  return { start, end, label: `${y}Q${q + 1}` };
}

// Convert a UTC ISO timestamp to a YYYY-MM-DD date in America/New_York.
// Matches the `auction_daily_stats` view's bucketing.
function etDateKey(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const d = parts.find((p) => p.type === "day")?.value ?? "";
  return `${y}-${m}-${d}`;
}

function enumerateQuarterDays(start: Date, end: Date): string[] {
  const days: string[] = [];
  const cursor = new Date(start);
  while (cursor < end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function dateKeyToUtcDate(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function earliestHistoricalDate(data: HistoricalDailyGmvData) {
  let earliest: string | null = null;
  for (const date of data.totals.keys()) {
    if (earliest === null || date < earliest) earliest = date;
  }
  return earliest;
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
    supabase
      .from("auctions")
      .select("platform, status, close_time_utc"),
    supabase
      .from("auctions")
      .select("*")
      .limit(1),
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

export async function computeRevenueForecast(takeRate = 0.2): Promise<RevenueForecast> {
  const now = new Date();
  const nowIso = now.toISOString();
  const { start, end, label } = quarterBounds(now);
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const historicalDailyGmv = await loadHistoricalDailyGmv();
  const quarterDays = enumerateQuarterDays(start, end);
  const quarterDaySet = new Set(quarterDays);
  const historicalStartKey = earliestHistoricalDate(historicalDailyGmv);
  const historicalStart = historicalStartKey ? dateKeyToUtcDate(historicalStartKey) : null;
  const chartStart = historicalStart && historicalStart < start ? historicalStart : start;
  const chartDays = enumerateQuarterDays(chartStart, end);
  const chartDaySet = new Set(chartDays);

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

  const dailyMap = new Map<string, { realized: HistoricalDailyGmv; projected: number; hasHistoricalRealized: boolean }>();
  for (const day of chartDays) {
    const realized = historicalDailyGmv.totals.get(day);
    dailyMap.set(day, {
      realized: realized ? { ...realized } : emptyHistoricalDailyGmv(),
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

  const daily = chartDays
    .map((date) => {
      const v = dailyMap.get(date) ?? { realized: emptyHistoricalDailyGmv(), projected: 0 };
      return {
        date,
        realized_gmv_usd: Math.round(v.realized.all),
        domestic_realized_gmv_usd: Math.round(v.realized.domestic),
        international_realized_gmv_usd: Math.round(v.realized.international),
        projected_gmv_usd: Math.round(v.projected),
        realized_revenue_usd: Math.round(v.realized.all * takeRate),
        domestic_realized_revenue_usd: Math.round(v.realized.domestic * takeRate),
        international_realized_revenue_usd: Math.round(v.realized.international * takeRate),
        projected_revenue_usd: Math.round(v.projected * takeRate),
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

  const debug = await collectDebug(nowIso, startIso, endIso);

  return {
    quarter: label,
    quarter_start: startIso,
    quarter_end: endIso,
    take_rate: takeRate,
    platforms: rows,
    daily,
    projected_total_gmv_usd,
    projected_total_revenue_usd,
    debug,
  };
}
