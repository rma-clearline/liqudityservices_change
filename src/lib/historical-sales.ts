import "server-only";

import { randomUUID } from "node:crypto";

const MAESTRO_URL = process.env.MAESTRO_API_URL || "https://maestro.lqdt1.com";
const MAESTRO_KEY = process.env.MAESTRO_API_KEY;

const CURRENCY_MAP: Record<string, string> = {
  USD: "USD", ZAR: "ZAR", EUR: "EUR", GBP: "GBP", CAD: "CAD",
  AUD: "AUD", INR: "INR", BRL: "BRL", MXN: "MXN", JPY: "JPY",
  CNY: "CNY",
};

let cachedRates: Record<string, number> | null = null;
let ratesFetchedAt = 0;

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

function safeNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function safeString(raw: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

function isDomesticCountry(country: string) {
  const normalized = country.trim().toUpperCase();
  return (
    normalized === "USA" ||
    normalized === "US" ||
    normalized === "UNITED STATES" ||
    normalized === "UNITED STATES OF AMERICA"
  );
}

async function fetchUsdRates(): Promise<Record<string, number>> {
  if (cachedRates && Date.now() - ratesFetchedAt < 3600_000) return cachedRates;
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", {
      cache: "no-store",
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

function toUsd(amount: number, currencyCode: string, rates: Record<string, number>): number | null {
  if (!currencyCode || currencyCode === "USD") return amount;
  const code = CURRENCY_MAP[currencyCode] ?? currencyCode;
  const rate = rates[code];
  if (rate && rate > 0) return amount / rate;
  return null;
}

function formatPartsInEt(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
  };
}

function localEtToUtcMs(date: string, hour: number, minute: number, second: number, millisecond: number) {
  const [year, month, day] = date.split("-").map(Number);
  const targetLocalMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  let utcMs = targetLocalMs + 5 * 60 * 60 * 1000;

  for (let i = 0; i < 3; i += 1) {
    const parts = formatPartsInEt(new Date(utcMs));
    const renderedLocalMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
    utcMs += targetLocalMs - renderedLocalMs;
  }

  return utcMs;
}

function nextDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + 1));
  return d.toISOString().slice(0, 10);
}

function dateRangeForEtDay(date: string) {
  const startMs = localEtToUtcMs(date, 0, 0, 0, 0);
  const endMs = localEtToUtcMs(nextDate(date), 0, 0, 0, 0) - 1;
  return {
    fromDate: new Date(startMs).toISOString(),
    toDate: new Date(endMs).toISOString(),
  };
}

function etDateKey(iso: string) {
  if (!iso) return "";
  const parts = formatPartsInEt(new Date(iso));
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function buildPayload(date: string, page: number, pageSize: number) {
  const { fromDate, toDate } = dateRangeForEtDay(date);
  return {
    businessId: "AD",
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
    displayRows: pageSize,
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

function saleUrl(raw: Record<string, unknown>) {
  if (typeof raw.clickUrl !== "string" || raw.clickUrl.length === 0) return null;
  if (raw.clickUrl.startsWith("http")) return raw.clickUrl;
  return `https://www.govdeals.com${raw.clickUrl.startsWith("/") ? "" : "/"}${raw.clickUrl}`;
}

function rowKey(raw: Record<string, unknown>) {
  return [
    typeof raw.businessId === "string" ? raw.businessId : "",
    raw.accountId ?? "",
    raw.assetId ?? "",
    raw.auctionId ?? "",
  ].join(":");
}

function parseSale(raw: Record<string, unknown>, rates: Record<string, number>): HistoricalSaleRow {
  const currencyCode = typeof raw.currencyCode === "string" && raw.currencyCode ? raw.currencyCode : "USD";
  const nativeAmount = safeNumber(raw.currentBid);
  const usdAmount = toUsd(nativeAmount, currencyCode, rates);

  return {
    platform: typeof raw.businessId === "string" ? raw.businessId : "",
    asset_id: raw.assetId != null ? String(raw.assetId) : "",
    auction_id: raw.auctionId != null ? String(raw.auctionId) : "",
    account_id: raw.accountId != null ? String(raw.accountId) : "",
    title: typeof raw.assetShortDescription === "string" ? raw.assetShortDescription : "",
    seller: typeof raw.companyName === "string" ? raw.companyName : "",
    category: typeof raw.categoryDescription === "string" ? raw.categoryDescription : "",
    country: safeString(raw, ["country", "countryCode", "assetCountry", "locationCountry"]),
    state: safeString(raw, ["locationState", "state", "stateCode", "province", "locationProvince"]),
    close_time_utc: typeof raw.assetAuctionEndDateUtc === "string" ? raw.assetAuctionEndDateUtc : "",
    close_time_display: typeof raw.assetAuctionEndDateDisplay === "string" ? raw.assetAuctionEndDateDisplay : "",
    currency_code: currencyCode,
    sale_amount_native: nativeAmount,
    sale_amount_usd: usdAmount === null ? null : Math.round(usdAmount * 100) / 100,
    bid_count: safeNumber(raw.bidCount),
    url: saleUrl(raw),
  };
}

async function fetchRawSalesPage(date: string, page: number, pageSize: number) {
  if (!MAESTRO_KEY) {
    throw new Error("MAESTRO_API_KEY is not configured");
  }

  const res = await fetch(`${MAESTRO_URL}/search/assets/advanced`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": MAESTRO_KEY,
      "x-user-id": "-1",
      "x-api-correlation-id": randomUUID(),
    },
    body: JSON.stringify(buildPayload(date, page, pageSize)),
    cache: "no-store",
    signal: AbortSignal.timeout(60000),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Maestro HTTP ${res.status}: ${text.slice(0, 300)}`);

  const data = JSON.parse(text);
  const rows: Record<string, unknown>[] = Array.isArray(data?.assetSearchResults)
    ? data.assetSearchResults
    : Array.isArray(data?.searchResults)
      ? data.searchResults
      : Array.isArray(data)
        ? data
        : [];

  return {
    rows,
    total: Number(res.headers.get("x-total-count") ?? rows.length),
  };
}

async function fetchAllSalesForDate(date: string): Promise<CachedSalesDay> {
  const cached = cachedSalesByDate.get(date);
  if (cached && Date.now() - cached.fetchedAt < SALES_CACHE_MS) return cached;

  const [rates, firstPage] = await Promise.all([
    fetchUsdRates(),
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
    .map((row) => parseSale(row, rates));

  const result = {
    fetchedAt: Date.now(),
    totalRaw: firstPage.total,
    rows,
  };
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
