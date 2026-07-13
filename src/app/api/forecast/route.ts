import { NextResponse } from "next/server";
import { applyForecastTakeRate, computeRevenueForecast, type RevenueForecast } from "@/lib/auctions";
import { ttlCache } from "@/lib/cache";
import { loadReportedQuarterlyGmv } from "@/lib/reported-gmv";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Database work depends on the quarter, not the take rate. Cache a 100%-rate base
// forecast and apply the requested rate in memory so slider changes are free.
const forecastCache = ttlCache<RevenueForecast>(Number(process.env.FORECAST_CACHE_MS) || 15 * 60_000);

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
  // Attach the reported-GMV benchmark here (not in the snapshot): it's full-history,
  // take-rate-independent, and cheap, so it's always fresh regardless of the selected
  // quarter or when the cron last regenerated the snapshot.
  const reported_gmv_by_quarter = await loadReportedQuarterlyGmv();
  return NextResponse.json({ ...applyForecastTakeRate(base, takeRate), reported_gmv_by_quarter });
}
