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
import { dateKeyToUtcDate, dateRangeForEtDay, etDateKey, etMonthKey, etQuarterKey, etWeekKey } from "./time";
import { classifySellerLevel, type GovLevel } from "./gov-seller";
import { isDomesticCountry, parseSale, rowKey, type HistoricalSaleRow } from "./historical-sales";

const PAGE_SIZE = 1000;
// Maestro sorts the whole result set on every page, so wide windows are slow
// (a 3-month window took ~35s and started returning 400s; a 1-week window is
// sub-second). We split the range into ~weekly chunks and spend a bounded page
// budget across them, value-ranked (currentBid desc) within each week. GMV is
// top-heavy, so this still captures the large majority of GMV; narrow ranges
// get complete coverage. All env-overridable.
const CHUNK_DAYS = Number(process.env.GMV_EXPORT_CHUNK_DAYS) || 7;
const PAGE_BUDGET = Number(process.env.GMV_EXPORT_PAGE_BUDGET) || 60;
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

// Cap concurrent Maestro requests: firing many sold-page requests at once makes
// Maestro 400 ("exception logged for Correlation ID …") or drop connections.
const CONCURRENCY = Number(process.env.GMV_EXPORT_CONCURRENCY) || 4;

type PageResult = { rows: Record<string, unknown>[]; total: number; ok: boolean };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchPageOnce(fromIso: string, toIso: string, page: number): Promise<PageResult> {
  try {
    const res = await fetch(`${MAESTRO_URL}${SOLD_SEARCH_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": MAESTRO_KEY,
        "x-user-id": "-1",
        "x-api-correlation-id": randomUUID(),
      },
      // "AD" site = broadest sold archive (incl. GD/GI), sorted by currentBid desc.
      body: JSON.stringify(buildSoldPayload("AD", fromIso, toIso, page, PAGE_SIZE)),
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      await res.text().catch(() => "");
      return { rows: [], total: 0, ok: false };
    }
    const data = await res.json();
    return { rows: extractListings(data), total: Number(res.headers.get("x-total-count") ?? 0), ok: true };
  } catch {
    return { rows: [], total: 0, ok: false };
  }
}

/** Fetch one page with backoff retries — Maestro's failures here are transient. */
async function fetchPage(fromIso: string, toIso: string, page: number, retries = 3): Promise<PageResult> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetchPageOnce(fromIso, toIso, page);
    if (r.ok || attempt >= retries) return r;
    await sleep(300 * 2 ** attempt);
  }
}

/** Run async tasks with bounded concurrency, preserving input order. */
async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

type Chunk = { fromIso: string; toIso: string };

/** Split [from, to] (ET day keys) into ≤CHUNK_DAYS windows with UTC ISO bounds. */
function chunkRange(from: string, to: string): Chunk[] {
  const chunks: Chunk[] = [];
  let cursor = from;
  for (let guard = 0; cursor <= to && guard < 520; guard++) {
    const startD = dateKeyToUtcDate(cursor);
    if (!startD) break;
    const endD = new Date(startD);
    endD.setUTCDate(endD.getUTCDate() + (CHUNK_DAYS - 1));
    let endKey = endD.toISOString().slice(0, 10);
    if (endKey > to) endKey = to;
    chunks.push({ fromIso: dateRangeForEtDay(cursor).fromDate, toIso: dateRangeForEtDay(endKey).toDate });
    const next = new Date(startD);
    next.setUTCDate(next.getUTCDate() + CHUNK_DAYS);
    cursor = next.toISOString().slice(0, 10);
  }
  return chunks;
}

const rangeCache = new Map<string, { at: number; val: SoldExportFetch }>();

/**
 * Fetch + classify sold lots in [from, to] (ET days). The range is split into
 * weekly chunks; each chunk is paged value-ranked up to a share of the global
 * page budget (breadth-first across chunks), so wide ranges stay fast/reliable
 * while narrow ranges get complete coverage. Returns dedup'd, classified rows.
 */
export async function fetchSoldRange(from: string, to: string): Promise<SoldExportFetch> {
  const cacheKey = `${from}|${to}`;
  const hit = rangeCache.get(cacheKey);
  if (hit && Date.now() - hit.at < RANGE_CACHE_MS) return hit.val;

  if (!MAESTRO_KEY) throw new Error("MAESTRO_API_KEY is not configured");

  const fx = await loadFxRates();
  const chunks = chunkRange(from, to);
  if (chunks.length === 0) {
    return { rows: [], total_in_range: 0, fetched: 0, truncated: false };
  }
  const pagesPerChunk = Math.max(1, Math.floor(PAGE_BUDGET / chunks.length));

  // Phase 1: page 1 of every chunk (per-chunk totals + each week's top lots).
  const firstPages = await runPool(chunks, CONCURRENCY, (c) => fetchPage(c.fromIso, c.toIso, 1));
  if (firstPages.every((r) => !r.ok)) {
    throw new Error("Maestro sold-archive request failed — please retry in a moment.");
  }

  let totalInRange = 0;
  let truncated = false;
  const takePerChunk = firstPages.map((r) => {
    if (!r.ok) {
      truncated = true;
      return 0;
    }
    totalInRange += r.total;
    const needed = Math.max(1, Math.ceil(r.total / PAGE_SIZE));
    const take = Math.min(needed, pagesPerChunk);
    if (needed > take) truncated = true;
    return take;
  });

  // Phase 2: deeper pages, breadth-first (page 2 of all chunks, then page 3…),
  // capped by the remaining budget so total requests stay bounded.
  const maxTake = takePerChunk.reduce((m, t) => Math.max(m, t), 0);
  const deeper: { chunk: Chunk; page: number }[] = [];
  for (let p = 2; p <= maxTake; p++) {
    takePerChunk.forEach((take, idx) => {
      if (p <= take) deeper.push({ chunk: chunks[idx], page: p });
    });
  }
  const budgetForDeeper = Math.max(0, PAGE_BUDGET - chunks.length);
  const deeperCapped = deeper.slice(0, budgetForDeeper);
  if (deeperCapped.length < deeper.length) truncated = true;
  const deeperPages = await runPool(deeperCapped, CONCURRENCY, (t) => fetchPage(t.chunk.fromIso, t.chunk.toIso, t.page));
  if (deeperPages.some((r) => !r.ok)) truncated = true;

  const seen = new Set<string>();
  const rows: SoldExportRow[] = [];
  for (const raw of [...firstPages, ...deeperPages].flatMap((r) => r.rows)) {
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

  const val: SoldExportFetch = { rows, total_in_range: totalInRange, fetched: rows.length, truncated };
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
