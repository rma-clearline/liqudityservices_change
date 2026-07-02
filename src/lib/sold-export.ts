import "server-only";

// Range-based sold-lot fetch + classification for the analyst GMV export.
//
// The forecast drill-down (historical-sales.ts) fetches ONE ET day at a time.
// The export needs an arbitrary date RANGE, classified by site (true
// marketplace), type (government vs retail — by seller identity), and market
// (domestic/international), then either dumped raw or pivoted.
//
// Backend = Maestro sold archive (querying the "AD" site, which returns the
// broadest cross-listed archive incl. GD/GI, each row labeled by its own
// businessId). The archive reaches back to ~mid-July 2025. Volume is large
// (a quarter can be hundreds of thousands of lots), so we page value-ranked
// (currentBid desc) up to a cap and report truncation — GMV is top-heavy, so a
// cap still captures the large majority of GMV, and narrow filters return a
// complete slice.

import { randomUUID } from "node:crypto";
import { loadFxRates } from "./fx";
import { buildSoldPayload, extractListings, MAESTRO_KEY, MAESTRO_URL, SOLD_SEARCH_PATH } from "./maestro";
import { dateRangeForEtDay, etDateKey, etMonthKey, etQuarterKey, etWeekKey } from "./time";
import { classifySellerLevel, type GovLevel } from "./gov-seller";
import { isDomesticCountry, parseSale, rowKey, type HistoricalSaleRow } from "./historical-sales";

const PAGE_SIZE = 1000;
// 25 pages × 1000 = 25k top-value lots per export (env-overridable).
const MAX_PAGES = Number(process.env.GMV_EXPORT_MAX_PAGES) || 25;
const RANGE_CACHE_MS = Number(process.env.GMV_EXPORT_CACHE_MS) || 5 * 60_000;

export type ExportSite = "all" | "AD" | "GD" | "GI";
export type ExportType = "all" | "government" | "retail" | "federal" | "state" | "local";
export type ExportMarket = "all" | "domestic" | "international";
export type ExportPeriod = "day" | "week" | "month" | "quarter";

export type ExportFilters = {
  from: string; // YYYY-MM-DD ET
  to: string; // YYYY-MM-DD ET
  site: ExportSite;
  type: ExportType;
  market: ExportMarket;
  category?: string;
  state?: string;
  country?: string;
  minUsd?: number;
  maxUsd?: number;
};

export type SoldExportRow = HistoricalSaleRow & {
  close_date_et: string;
  site: string; // AD/GD/GI — the row's true marketplace
  gov_level: GovLevel; // federal | state | local | commercial
  seller_type: "government" | "retail";
  market: "domestic" | "international";
};

export type SoldExportFetch = {
  rows: SoldExportRow[]; // full range, classified; NOT yet filtered by site/type/etc.
  total_in_range: number; // Maestro x-total-count for the range (all sold lots)
  fetched: number; // rows kept after dedup + day-trim (≤ cap)
  truncated: boolean; // true if the range had more lots than the cap pulled
};

export type PivotRow = {
  period: string;
  site: string;
  type: string;
  market: string;
  gmv_usd: number;
  lots: number;
};

async function fetchPage(fromDate: string, toDate: string, page: number) {
  if (!MAESTRO_KEY) throw new Error("MAESTRO_API_KEY is not configured");
  const res = await fetch(`${MAESTRO_URL}${SOLD_SEARCH_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": MAESTRO_KEY,
      "x-user-id": "-1",
      "x-api-correlation-id": randomUUID(),
    },
    // "AD" site = broadest sold archive (incl. GD/GI), sorted by currentBid desc.
    body: JSON.stringify(buildSoldPayload("AD", fromDate, toDate, page, PAGE_SIZE)),
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Maestro HTTP ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  return { rows: extractListings(data), total: Number(res.headers.get("x-total-count") ?? 0) };
}

const rangeCache = new Map<string, { at: number; val: SoldExportFetch }>();

/** Fetch + classify all sold lots in [from, to] (ET days), value-ranked, capped. */
export async function fetchSoldRange(from: string, to: string): Promise<SoldExportFetch> {
  const cacheKey = `${from}|${to}`;
  const hit = rangeCache.get(cacheKey);
  if (hit && Date.now() - hit.at < RANGE_CACHE_MS) return hit.val;

  const { fromDate } = dateRangeForEtDay(from);
  const { toDate } = dateRangeForEtDay(to);

  const [fx, first] = await Promise.all([loadFxRates(), fetchPage(fromDate, toDate, 1)]);
  const total = first.total;
  const neededPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pages = Math.min(MAX_PAGES, neededPages);
  const truncated = neededPages > MAX_PAGES;

  const remaining = Array.from({ length: pages - 1 }, (_, i) => i + 2);
  const rest = await Promise.all(remaining.map((p) => fetchPage(fromDate, toDate, p)));

  const seen = new Set<string>();
  const rows: SoldExportRow[] = [];
  for (const raw of [first, ...rest].flatMap((r) => r.rows)) {
    const key = rowKey(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    const closeIso = typeof raw.assetAuctionEndDateUtc === "string" ? raw.assetAuctionEndDateUtc : "";
    const closeDateEt = etDateKey(closeIso);
    if (!closeDateEt || closeDateEt < from || closeDateEt > to) continue; // guard to the ET range
    const base = parseSale(raw, fx);
    const gov_level = classifySellerLevel(base.seller);
    rows.push({
      ...base,
      close_date_et: closeDateEt,
      site: base.platform || "",
      gov_level,
      seller_type: gov_level === "commercial" ? "retail" : "government",
      market: isDomesticCountry(base.country) ? "domestic" : "international",
    });
  }

  const val: SoldExportFetch = { rows, total_in_range: total, fetched: rows.length, truncated };
  rangeCache.set(cacheKey, { at: Date.now(), val });
  return val;
}

/** Apply the analyst filters (site/type/market/category/state/country/price). */
export function applyExportFilters(rows: SoldExportRow[], f: ExportFilters): SoldExportRow[] {
  const cat = f.category?.trim().toLowerCase();
  const st = f.state?.trim().toLowerCase();
  const ctry = f.country?.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.site !== "all" && r.site !== f.site) return false;
    if (f.type === "government" && r.seller_type !== "government") return false;
    if (f.type === "retail" && r.seller_type !== "retail") return false;
    if ((f.type === "federal" || f.type === "state" || f.type === "local") && r.gov_level !== f.type) return false;
    if (f.market !== "all" && r.market !== f.market) return false;
    if (cat && !r.category.toLowerCase().includes(cat)) return false;
    if (st && !r.state.toLowerCase().includes(st)) return false;
    if (ctry && !r.country.toLowerCase().includes(ctry)) return false;
    if (f.minUsd != null && (r.sale_amount_usd == null || r.sale_amount_usd < f.minUsd)) return false;
    if (f.maxUsd != null && (r.sale_amount_usd == null || r.sale_amount_usd > f.maxUsd)) return false;
    return true;
  });
}

function periodKey(dateKey: string, period: ExportPeriod): string {
  if (period === "week") return etWeekKey(dateKey);
  if (period === "month") return etMonthKey(dateKey);
  if (period === "quarter") return etQuarterKey(dateKey);
  return dateKey;
}

/** Aggregate GMV (Σ USD) + lot count by period × site × type × market. */
export function aggregateExport(rows: SoldExportRow[], period: ExportPeriod): PivotRow[] {
  const map = new Map<string, PivotRow>();
  for (const r of rows) {
    const p = periodKey(r.close_date_et, period);
    const key = `${p}|${r.site}|${r.seller_type}|${r.market}`;
    let agg = map.get(key);
    if (!agg) {
      agg = { period: p, site: r.site, type: r.seller_type, market: r.market, gmv_usd: 0, lots: 0 };
      map.set(key, agg);
    }
    agg.gmv_usd += r.sale_amount_usd ?? 0;
    agg.lots += 1;
  }
  return Array.from(map.values())
    .map((r) => ({ ...r, gmv_usd: Math.round(r.gmv_usd * 100) / 100 }))
    .sort(
      (a, b) =>
        a.period.localeCompare(b.period) ||
        a.site.localeCompare(b.site) ||
        a.type.localeCompare(b.type) ||
        a.market.localeCompare(b.market),
    );
}
