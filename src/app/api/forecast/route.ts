import { NextResponse } from "next/server";
import { applyForecastTakeRate, computeRevenueForecast, type RevenueForecast } from "@/lib/auctions";
import { getSoldDailyByBucket, isAzureSqlConfigured, type SoldBucketDailyRow } from "@/lib/azure-sql";
import { ttlCache } from "@/lib/cache";
import {
  consignmentTakeRate,
  loadModelEstimatesMerged,
  loadModelMetrics,
  loadModelVintage,
  loadReportedQuarterlyGmv,
} from "@/lib/reported-gmv";
import { azFetchLatestForecastSnapshot } from "@/lib/azure-tables";
import { etTodayKey, quarterBounds } from "@/lib/time";

export const dynamic = "force-dynamic";

// Database work depends on the quarter, not the take rate. Cache a 100%-rate base
// forecast and apply the requested rate in memory so slider changes are free.
const forecastCache = ttlCache<RevenueForecast>(Number(process.env.FORECAST_CACHE_MS) || 15 * 60_000);
// A completed quarter cannot change between cron runs (only the cron writes sold
// data), so a live recompute of one is worth keeping far longer than 15 minutes.
const completedCache = ttlCache<RevenueForecast>(Number(process.env.FORECAST_COMPLETED_CACHE_MS) || 24 * 3_600_000);
// Full-history daily take-rate-bucket split for the QTD page (quarter=ALL only).
const bucketDailyCache = ttlCache<SoldBucketDailyRow[]>(Number(process.env.FORECAST_CACHE_MS) || 15 * 60_000);

const currentQuarterLabel = () => quarterBounds(new Date()).label;

/** Snapshot-first. The cron materialises the current quarter (keyed by its label) and
 *  the QTD page's full-history "ALL" view; anything else — a past quarter — is computed
 *  live. Keyed lookups only: with several snapshots stored, "latest of any" would hand
 *  the forecast tab the ALL payload. */
async function loadBaseForecast(quarter?: string): Promise<RevenueForecast> {
  const key = quarter?.toUpperCase() === "ALL" ? "ALL" : (quarter ?? currentQuarterLabel());
  const snap = await azFetchLatestForecastSnapshot<RevenueForecast>(key).catch(() => null);
  if (snap?.payload?.quarter === key) return snap.payload;
  return computeRevenueForecast(1, quarter);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const takeRateParam = searchParams.get("takeRate");
  const quarter = searchParams.get("quarter")?.trim() || undefined;

  const key = quarter ?? "current";
  // Don't cache a degraded forecast (live-quarter store read failed → collapsed to
  // the sparse tracked feed). Caching one would serve the collapse for the full TTL;
  // skipping the store means the next request re-computes and recovers immediately.
  const isCompletedQuarter = !!quarter && quarter.toUpperCase() !== "ALL" && quarter !== currentQuarterLabel();
  const base = await (isCompletedQuarter ? completedCache : forecastCache).get(key, () => loadBaseForecast(quarter), (f) => !f.store_degraded);
  // Attach the reported-GMV benchmark + model estimates here (not in the snapshot):
  // full-history, take-rate-independent, and cheap, so they're always fresh regardless
  // of the selected quarter or when the cron last regenerated the snapshot.
  const [reported_gmv_by_quarter, model_estimates_by_quarter, model_metrics, vintage] = await Promise.all([
    loadReportedQuarterlyGmv(),
    loadModelEstimatesMerged(),
    loadModelMetrics(),
    loadModelVintage(),
  ]);
  // Stale = the workbook missed an earnings cycle (~a quarter + reporting lag).
  // The mosaic freshness-tier idea, reduced to one flag the QTD page can badge.
  const STALE_MODEL_DAYS = 120;
  const model_vintage = vintage
    ? { ...vintage, stale: Date.now() - Date.parse(vintage.as_of) > STALE_MODEL_DAYS * 86_400_000 }
    : null;

  // Default take rate = the model's consignment (auction) take rate, matched to the
  // quarter actually being served. An explicit ?takeRate still wins — this only decides
  // what an unparameterized request gets, which is what the tab now loads with instead
  // of the old hardcoded 0.2 (roughly 2x what this GMV earns). Resolved here rather than
  // at the top of the handler because it needs the metrics loaded above; no extra I/O.
  const default_take_rate = consignmentTakeRate(model_metrics, base.quarter);
  const parsedTakeRate = takeRateParam ? Number(takeRateParam) : NaN;
  const takeRate = Number.isFinite(parsedTakeRate)
    ? Math.max(0, Math.min(1, parsedTakeRate))
    : default_take_rate.rate;

  // Daily take-rate-bucket split — QTD-page (quarter=ALL) only, so the forecast
  // tab's per-quarter requests stay light. Store failures just omit the series;
  // the QTD model sections degrade to "unavailable".
  let sold_by_bucket_daily: SoldBucketDailyRow[] | undefined;
  if (quarter?.toUpperCase() === "ALL" && isAzureSqlConfigured()) {
    try {
      const timeoutMs = Number(process.env.FORECAST_SOLD_TIMEOUT_MS) || 25_000;
      sold_by_bucket_daily = await Promise.race([
        bucketDailyCache.get("all", async () => {
          // Cron-materialised copy first (see the snapshot task); live query as fallback.
          const snap = await azFetchLatestForecastSnapshot<SoldBucketDailyRow[]>("ALL_BUCKETS").catch(() => null);
          if (Array.isArray(snap?.payload) && snap.payload.length > 0) return snap.payload;
          return getSoldDailyByBucket(base.earliest_data_date, etTodayKey());
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("sold-by-bucket timeout")), timeoutMs),
        ),
      ]);
    } catch (err) {
      // degrade — the rest of the payload is unaffected; the QTD sections show "unavailable"
      console.warn("forecast: sold_by_bucket_daily unavailable:", err instanceof Error ? err.message : err);
    }
  }

  return NextResponse.json({
    ...applyForecastTakeRate(base, takeRate),
    default_take_rate,
    reported_gmv_by_quarter,
    model_estimates_by_quarter,
    model_metrics,
    model_vintage,
    ...(sold_by_bucket_daily ? { sold_by_bucket_daily } : {}),
  });
}
