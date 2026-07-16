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
// Maestro sorts the whole result set on every page, so WIDE windows are slow (a
// 3-month window took ~35s and started 400ing) while a 1-week window is
// sub-second. We split the range into ~weekly chunks and, by default, fetch
// EVERY page of every non-empty chunk (complete coverage — no value-ranked
// sampling). A high `maxPages` safety cap bounds a single request; callers that
// only need a sample (the category chart) pass a small maxPages. Ranges up to
// ~1 quarter (~200 pages) complete in one request; the export modal splits
// wider ranges into per-quarter requests. All env-overridable.
const CHUNK_DAYS = Number(process.env.GMV_EXPORT_CHUNK_DAYS) || 7;
const DEFAULT_MAX_PAGES = Number(process.env.GMV_EXPORT_MAX_PAGES) || 500;
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
const CONCURRENCY = Number(process.env.GMV_EXPORT_CONCURRENCY) || 5;

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

/** Fetch one page with backoff retries — Maestro's failures here are transient
 *  (throttling under load). Retry hard so a blip never silently zeroes a week. */
async function fetchPage(fromIso: string, toIso: string, page: number, retries = 4): Promise<PageResult> {
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
 * Thrown when a sold-lot fetch — the live Maestro pull (fetchSoldRange's maxRows
 * preflight) OR the Azure-store read (the export route's countSoldLots guard) —
 * is asked for a range holding more lots than one request can safely materialize
 * on the small app container. The export route maps this to a clean, retryable
 * 503 so the client re-requests the range as smaller COMPLETE slices instead of
 * the container dying and the platform emitting a raw 503.
 */
export class RangeTooLargeError extends Error {
  readonly code = "range_too_large" as const;
  constructor(
    readonly from: string,
    readonly to: string,
    readonly totalInRange: number,
    readonly maxRows: number,
  ) {
    // NOTE: the modal surfaces this text VERBATIM as the terminal error when the
    // window can't be split further — don't promise a retry here; the client owns
    // (and reports) its own retry/split behavior.
    super(
      `Range ${from}..${to} holds ${totalInRange.toLocaleString()} lots — more than the ` +
        `${maxRows.toLocaleString()}-lot single-request cap. Narrow the date range or filters.`,
    );
    this.name = "RangeTooLargeError";
  }
}

/**
 * Fetch + classify sold lots in [from, to] (ET days). The range is split into
 * weekly chunks; by default EVERY page of every non-empty chunk is fetched
 * (complete coverage), bounded only by `maxPages` as a safety cap. Empty chunks
 * (e.g. pre-archive weeks) are skipped so they don't waste the budget. Callers
 * that only need a sample (the category chart) pass a small `maxPages`.
 * Returns dedup'd, classified rows. For ranges wider than the modal exports in
 * one shot (~1 quarter), the modal splits into per-quarter calls.
 */
export async function fetchSoldRange(
  from: string,
  to: string,
  opts: { maxPages?: number; maxRows?: number } = {},
): Promise<SoldExportFetch> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const cacheKey = `${from}|${to}|${maxPages}|${opts.maxRows ?? ""}`;
  const hit = rangeCache.get(cacheKey);
  if (hit && Date.now() - hit.at < RANGE_CACHE_MS) return hit.val;

  if (!MAESTRO_KEY) throw new Error("MAESTRO_API_KEY is not configured");

  const fx = await loadFxRates();
  const chunks = chunkRange(from, to);
  if (chunks.length === 0) {
    return { rows: [], total_in_range: 0, fetched: 0, truncated: false };
  }

  // Phase 1: page 1 of every chunk → per-chunk totals (x-total-count).
  const firstPages = await runPool(chunks, CONCURRENCY, (c) => fetchPage(c.fromIso, c.toIso, 1));
  if (firstPages.every((r) => !r.ok)) {
    throw new Error("Maestro sold-archive request failed — please retry in a moment.");
  }

  let totalInRange = 0;
  let truncated = false;
  // Non-empty chunks that need more than their first page.
  const deeperNeed: { chunk: Chunk; pagesNeeded: number }[] = [];
  firstPages.forEach((r, idx) => {
    if (!r.ok) {
      truncated = true; // a page-1 failed after retries → partial coverage
      return;
    }
    totalInRange += r.total;
    const pagesNeeded = Math.ceil(r.total / PAGE_SIZE);
    if (pagesNeeded > 1) deeperNeed.push({ chunk: chunks[idx], pagesNeeded });
  });

  // Preflight size guard for live fetches: if the range holds more lots than one
  // request can safely materialize (a dense month on the small app container),
  // abort *before* the expensive Phase-2 pull rather than letting the container
  // die and the platform emit a raw 503. The caller (export route) surfaces this
  // as a clean, retryable JSON error; the modal then re-requests the range in
  // smaller COMPLETE slices (never a value-ranked sample — see Bug 2). Only the
  // cheap page-1 probes above have run at this point, so this costs little.
  if (opts.maxRows != null && totalInRange > opts.maxRows) {
    throw new RangeTooLargeError(from, to, totalInRange, opts.maxRows);
  }

  // Phase 2: ALL remaining pages of every non-empty chunk, breadth-first
  // (page 2 of each, then page 3…), bounded by the maxPages safety cap.
  const maxNeeded = deeperNeed.reduce((m, c) => Math.max(m, c.pagesNeeded), 1);
  const deeper: { chunk: Chunk; page: number }[] = [];
  for (let p = 2; p <= maxNeeded; p++) {
    for (const c of deeperNeed) if (p <= c.pagesNeeded) deeper.push({ chunk: c.chunk, page: p });
  }
  const budgetForDeeper = Math.max(0, maxPages - chunks.length);
  const deeperCapped = deeper.slice(0, budgetForDeeper);
  if (deeperCapped.length < deeper.length) truncated = true; // hit the maxPages safety cap
  const deeperPages = await runPool(deeperCapped, CONCURRENCY, (t) => fetchPage(t.chunk.fromIso, t.chunk.toIso, t.page));
  if (deeperPages.some((r) => !r.ok)) truncated = true;

  const seen = new Set<string>();
  const rows: SoldExportRow[] = [];
  for (const raw of [...firstPages.flatMap((r) => r.rows), ...deeperPages.flatMap((r) => r.rows)]) {
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

export type CategoryByPeriod = {
  categories: string[]; // top-N category names + "Other"
  data: Array<Record<string, number | string>>; // [{ period, [category]: gmv, ... }]
};

/** Minimal row shape category composition needs — satisfied by both a full
 *  SoldExportRow (Maestro path) and the store's pre-aggregated daily-category rows. */
export type CategoryInputRow = { category: string | null; close_date_et: string; sale_amount_usd: number | null };

/**
 * GMV by (period × category), keeping the top-N categories (by total GMV) and
 * bucketing the rest as "Other" — shaped for a stacked bar chart.
 */
export function categoryByPeriod(rows: CategoryInputRow[], period: ExportPeriod, topN = 8): CategoryByPeriod {
  const catTotals = new Map<string, number>();
  for (const r of rows) {
    const c = r.category || "Uncategorized";
    catTotals.set(c, (catTotals.get(c) ?? 0) + (r.sale_amount_usd ?? 0));
  }
  const topCats = [...catTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map((e) => e[0]);
  const topSet = new Set(topCats);
  const categories = [...topCats, "Other"];

  const periodMap = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const p = periodKey(r.close_date_et, period);
    const c0 = r.category || "Uncategorized";
    const cat = topSet.has(c0) ? c0 : "Other";
    let bucket = periodMap.get(p);
    if (!bucket) {
      bucket = Object.fromEntries(categories.map((c) => [c, 0]));
      periodMap.set(p, bucket);
    }
    bucket[cat] += r.sale_amount_usd ?? 0;
  }

  const data = [...periodMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([p, vals]) => ({
      period: p,
      ...Object.fromEntries(categories.map((c) => [c, Math.round(vals[c] ?? 0)])),
    }));
  return { categories, data };
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
