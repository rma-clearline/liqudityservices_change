import "server-only";

import { randomUUID } from "node:crypto";
import { convertToUsd, loadFxRates } from "./fx";
import { buildSoldPayload, extractListings, MAESTRO_KEY, MAESTRO_URL, safeNumber, safeString, SOLD_SEARCH_PATH } from "./maestro";
import { dateRangeForEtDay, etDateKey } from "./time";

const FULL_FETCH_PAGE_SIZE = 1000;
const MAX_FULL_FETCH_PAGES = Number(process.env.HISTORICAL_SALES_MAX_PAGES) || 25;
const SALES_CACHE_MS = Number(process.env.HISTORICAL_SALES_CACHE_MS) || 5 * 60_000;

export const HISTORICAL_SALES_SORT_KEYS = [
  "amount",
  "name",
  "seller",
  "category",
  "country",
  "currency",
  "bids",
  "closed",
  "platform",
] as const;

export type HistoricalSalesSortKey = (typeof HISTORICAL_SALES_SORT_KEYS)[number];
export type HistoricalSalesSortOrder = "asc" | "desc";
export type HistoricalSalesMarket = "all" | "domestic" | "international";

export type HistoricalSaleRow = {
  platform: string;
  asset_id: string;
  auction_id: string;
  account_id: string;
  title: string;
  seller: string;
  category: string;
  country: string;
  state: string;
  close_time_utc: string;
  close_time_display: string;
  currency_code: string;
  sale_amount_native: number;
  sale_amount_usd: number | null;
  bid_count: number;
  url: string | null;
};

export type HistoricalSalesResult = {
  date: string;
  page: number;
  page_size: number;
  total: number;
  unfiltered_total: number;
  facets: {
    currencies: string[];
    countries: string[];
  };
  rows: HistoricalSaleRow[];
};

export type HistoricalSalesOptions = {
  page: number;
  pageSize: number;
  sortBy: HistoricalSalesSortKey;
  sortOrder: HistoricalSalesSortOrder;
  market: HistoricalSalesMarket;
  query?: string;
  minAmount?: number;
  maxAmount?: number;
  currency?: string;
  country?: string;
};

type CachedSalesDay = {
  fetchedAt: number;
  totalRaw: number;
  rows: HistoricalSaleRow[];
};

const cachedSalesByDate = new Map<string, CachedSalesDay>();

export function isDomesticCountry(country: string) {
  const normalized = country.trim().toUpperCase();
  return (
    normalized === "USA" ||
    normalized === "US" ||
    normalized === "UNITED STATES" ||
    normalized === "UNITED STATES OF AMERICA"
  );
}

function saleUrl(raw: Record<string, unknown>): string | null {
  // Prefer the feed-provided clickUrl when present.
  if (typeof raw.clickUrl === "string" && raw.clickUrl.length > 0) {
    if (raw.clickUrl.startsWith("http")) return raw.clickUrl;
    return `https://www.govdeals.com${raw.clickUrl.startsWith("/") ? "" : "/"}${raw.clickUrl}`;
  }
  // The sold archive usually omits clickUrl, so construct the listing URL from
  // ids the same way the seller tables do (top-sellers.tsx): asset + account on
  // the row's marketplace domain. GI (industrial) surfaces on AllSurplus.
  const biz = typeof raw.businessId === "string" ? raw.businessId : "";
  const assetId = raw.assetId != null ? String(raw.assetId) : "";
  const accountId = raw.accountId != null ? String(raw.accountId) : "";
  if (!assetId || !accountId) return null;
  const domain = biz === "GD" ? "www.govdeals.com" : "www.allsurplus.com";
  return `https://${domain}/asset/${assetId}/${accountId}`;
}

export function rowKey(raw: Record<string, unknown>) {
  return [
    typeof raw.businessId === "string" ? raw.businessId : "",
    raw.accountId ?? "",
    raw.assetId ?? "",
    raw.auctionId ?? "",
  ].join(":");
}

export function parseSale(raw: Record<string, unknown>, fx: Awaited<ReturnType<typeof loadFxRates>>): HistoricalSaleRow {
  const currencyCode = typeof raw.currencyCode === "string" && raw.currencyCode ? raw.currencyCode : "USD";
  const nativeAmount = safeNumber(raw.currentBid);
  const { usd } = convertToUsd(nativeAmount, currencyCode, fx);

  return {
    // platform is the row's true marketplace (AD/GD/GI), not the AD-site query.
    platform: typeof raw.businessId === "string" ? raw.businessId : "",
    asset_id: raw.assetId != null ? String(raw.assetId) : "",
    auction_id: raw.auctionId != null ? String(raw.auctionId) : "",
    account_id: raw.accountId != null ? String(raw.accountId) : "",
    title: safeString(raw, ["assetShortDescription"]),
    seller: safeString(raw, ["companyName", "displaySellerName"]),
    category: safeString(raw, ["categoryDescription"]),
    country: safeString(raw, ["country", "countryCode", "assetCountry", "locationCountry"]),
    state: safeString(raw, ["locationState", "state", "stateCode", "province", "locationProvince"]),
    close_time_utc: typeof raw.assetAuctionEndDateUtc === "string" ? raw.assetAuctionEndDateUtc : "",
    close_time_display: typeof raw.assetAuctionEndDateDisplay === "string" ? raw.assetAuctionEndDateDisplay : "",
    currency_code: currencyCode,
    sale_amount_native: nativeAmount,
    sale_amount_usd: usd === null ? null : Math.round(usd * 100) / 100,
    bid_count: safeNumber(raw.bidCount),
    url: saleUrl(raw),
  };
}

async function fetchRawSalesPage(date: string, page: number, pageSize: number) {
  if (!MAESTRO_KEY) throw new Error("MAESTRO_API_KEY is not configured");

  const { fromDate, toDate } = dateRangeForEtDay(date);
  const res = await fetch(`${MAESTRO_URL}${SOLD_SEARCH_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": MAESTRO_KEY,
      "x-user-id": "-1",
      "x-api-correlation-id": randomUUID(),
    },
    // businessId "AD" is the *site*: it returns the broadest sold archive,
    // including GD/GI rows, each labeled by its own row.businessId.
    body: JSON.stringify(buildSoldPayload("AD", fromDate, toDate, page, pageSize)),
    cache: "no-store",
    signal: AbortSignal.timeout(60000),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Maestro HTTP ${res.status}: ${text.slice(0, 300)}`);

  const data = JSON.parse(text);
  return {
    rows: extractListings(data),
    total: Number(res.headers.get("x-total-count") ?? 0),
  };
}

async function fetchAllSalesForDate(date: string): Promise<CachedSalesDay> {
  const cached = cachedSalesByDate.get(date);
  if (cached && Date.now() - cached.fetchedAt < SALES_CACHE_MS) return cached;

  const [fx, firstPage] = await Promise.all([
    loadFxRates(),
    fetchRawSalesPage(date, 1, FULL_FETCH_PAGE_SIZE),
  ]);

  const pageCount = Math.min(
    MAX_FULL_FETCH_PAGES,
    Math.max(1, Math.ceil(firstPage.total / FULL_FETCH_PAGE_SIZE)),
  );

  const remainingPages = Array.from({ length: pageCount - 1 }, (_, index) => index + 2);
  const remainingResults = await Promise.all(
    remainingPages.map((page) => fetchRawSalesPage(date, page, FULL_FETCH_PAGE_SIZE)),
  );

  const seen = new Set<string>();
  const rows = [firstPage, ...remainingResults]
    .flatMap((result) => result.rows)
    .filter((row) => {
      const closeIso = typeof row.assetAuctionEndDateUtc === "string" ? row.assetAuctionEndDateUtc : "";
      return etDateKey(closeIso) === date;
    })
    .filter((row) => {
      const key = rowKey(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((row) => parseSale(row, fx));

  const result = { fetchedAt: Date.now(), totalRaw: firstPage.total, rows };
  cachedSalesByDate.set(date, result);
  return result;
}

function includesQuery(row: HistoricalSaleRow, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    row.title,
    row.seller,
    row.category,
    row.country,
    row.state,
    row.currency_code,
    row.platform,
    row.asset_id,
    row.auction_id,
    row.account_id,
  ].join(" ").toLowerCase().includes(needle);
}

function filterRows(rows: HistoricalSaleRow[], options: HistoricalSalesOptions) {
  return rows.filter((row) => {
    if (options.market === "domestic" && !isDomesticCountry(row.country)) return false;
    if (options.market === "international" && (!row.country || isDomesticCountry(row.country))) return false;
    if (options.query && !includesQuery(row, options.query)) return false;
    if (options.currency && row.currency_code !== options.currency) return false;
    if (options.country && row.country !== options.country) return false;
    if (options.minAmount != null && (row.sale_amount_usd == null || row.sale_amount_usd < options.minAmount)) return false;
    if (options.maxAmount != null && (row.sale_amount_usd == null || row.sale_amount_usd > options.maxAmount)) return false;
    return true;
  });
}

function compareNullableNumber(a: number | null, b: number | null, order: HistoricalSalesSortOrder) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return order === "asc" ? a - b : b - a;
}

function compareText(a: string, b: string, order: HistoricalSalesSortOrder) {
  const result = a.localeCompare(b, "en-US", { numeric: true, sensitivity: "base" });
  return order === "asc" ? result : -result;
}

function sortRows(rows: HistoricalSaleRow[], sortBy: HistoricalSalesSortKey, sortOrder: HistoricalSalesSortOrder) {
  return [...rows].sort((a, b) => {
    if (sortBy === "amount") return compareNullableNumber(a.sale_amount_usd, b.sale_amount_usd, sortOrder);
    if (sortBy === "bids") return compareNullableNumber(a.bid_count, b.bid_count, sortOrder);
    if (sortBy === "closed") {
      return compareNullableNumber(
        a.close_time_utc ? Date.parse(a.close_time_utc) : null,
        b.close_time_utc ? Date.parse(b.close_time_utc) : null,
        sortOrder,
      );
    }
    if (sortBy === "name") return compareText(a.title, b.title, sortOrder);
    if (sortBy === "seller") return compareText(a.seller, b.seller, sortOrder);
    if (sortBy === "category") return compareText(a.category, b.category, sortOrder);
    if (sortBy === "country") return compareText(a.country, b.country, sortOrder);
    if (sortBy === "currency") return compareText(a.currency_code, b.currency_code, sortOrder);
    return compareText(a.platform, b.platform, sortOrder);
  });
}

function buildFacets(rows: HistoricalSaleRow[]) {
  return {
    currencies: Array.from(new Set(rows.map((row) => row.currency_code).filter(Boolean))).sort(),
    countries: Array.from(new Set(rows.map((row) => row.country).filter(Boolean))).sort(),
  };
}

export async function fetchHistoricalSalesForDate(
  date: string,
  options: HistoricalSalesOptions,
): Promise<HistoricalSalesResult> {
  const allSales = await fetchAllSalesForDate(date);
  const filteredRows = filterRows(allSales.rows, options);
  const sortedRows = sortRows(filteredRows, options.sortBy, options.sortOrder);
  const start = (options.page - 1) * options.pageSize;
  const rows = sortedRows.slice(start, start + options.pageSize);

  return {
    date,
    page: options.page,
    page_size: options.pageSize,
    total: filteredRows.length,
    unfiltered_total: allSales.rows.length,
    facets: buildFacets(allSales.rows),
    rows,
  };
}
