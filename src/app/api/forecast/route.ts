import { NextResponse } from "next/server";
import { applyForecastTakeRate, computeRevenueForecast, type RevenueForecast } from "@/lib/auctions";
import { getSoldDailyByGroup, isAzureSqlConfigured, type SoldGroupDailyRow } from "@/lib/azure-sql";
import { ttlCache } from "@/lib/cache";
import { loadModelEstimatesMerged, loadModelMetrics, loadReportedQuarterlyGmv } from "@/lib/reported-gmv";
import { supabase } from "@/lib/supabase";
import { etTodayKey } from "@/lib/time";

export const dynamic = "force-dynamic";

// Database work depends on the quarter, not the take rate. Cache a 100%-rate base
// forecast and apply the requested rate in memory so slider changes are free.
const forecastCache = ttlCache<RevenueForecast>(Number(process.env.FORECAST_CACHE_MS) || 15 * 60_000);
// Full-history daily gov/retail/intl split for the QTD page (quarter=ALL only).
const groupDailyCache = ttlCache<SoldGroupDailyRow[]>(Number(process.env.FORECAST_CACHE_MS) || 15 * 60_000);

async function loadBaseForecast(quarter?: string): Promise<RevenueForecast> {
  const snapshot = await supabase
    .from("forecast_snapshots")
    .select("payload")
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!snapshot.error && snapshot.data?.payload) {
    const payload = snapshot.data.payload as unknown as RevenueForecast;
    if (!quarter || payload.quarter === quarter) return payload;
  }
  // Migration-safe fallback and historical-quarter path.
  return computeRevenueForecast(1, quarter);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const takeRateParam = searchParams.get("takeRate");
  const parsed = takeRateParam ? Number(takeRateParam) : 0.2;
  const takeRate = Math.max(0, Math.min(1, Number.isFinite(parsed) ? parsed : 0.2));
  const quarter = searchParams.get("quarter")?.trim() || undefined;

  const key = quarter ?? "current";
  const base = await forecastCache.get(key, () => loadBaseForecast(quarter));
  // Attach the reported-GMV benchmark + model estimates here (not in the snapshot):
  // full-history, take-rate-independent, and cheap, so they're always fresh regardless
  // of the selected quarter or when the cron last regenerated the snapshot.
  const [reported_gmv_by_quarter, model_estimates_by_quarter, model_metrics] = await Promise.all([
    loadReportedQuarterlyGmv(),
    loadModelEstimatesMerged(),
    loadModelMetrics(),
  ]);

  // Daily gov/retail/intl group split — QTD-page (quarter=ALL) only, so the
  // forecast tab's per-quarter requests stay light. Store failures just omit the
  // series; the QTD model sections degrade to "unavailable".
  let sold_by_group_daily: SoldGroupDailyRow[] | undefined;
  if (quarter?.toUpperCase() === "ALL" && isAzureSqlConfigured()) {
    try {
      const timeoutMs = Number(process.env.FORECAST_SOLD_TIMEOUT_MS) || 25_000;
      sold_by_group_daily = await Promise.race([
        groupDailyCache.get("all", () => getSoldDailyByGroup(base.earliest_data_date, etTodayKey())),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("sold-by-group timeout")), timeoutMs),
        ),
      ]);
    } catch (err) {
      // degrade — the rest of the payload is unaffected; the QTD sections show "unavailable"
      console.warn("forecast: sold_by_group_daily unavailable:", err instanceof Error ? err.message : err);
    }
  }

  return NextResponse.json({
    ...applyForecastTakeRate(base, takeRate),
    reported_gmv_by_quarter,
    model_estimates_by_quarter,
    model_metrics,
    ...(sold_by_group_daily ? { sold_by_group_daily } : {}),
  });
}
