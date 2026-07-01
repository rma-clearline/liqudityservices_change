import { NextResponse } from "next/server";
import { computeRevenueForecast, type RevenueForecast } from "@/lib/auctions";

export const dynamic = "force-dynamic";

// The forecast recomputes over the whole auctions table, and is now requested
// by both the executive summary and the forecast section. Cache briefly per
// take rate so a dashboard load doesn't compute it twice.
type CacheEntry = { at: number; data: RevenueForecast };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const takeRateParam = searchParams.get("takeRate");
  const parsed = takeRateParam ? Number(takeRateParam) : 0.2;
  const takeRate = Number.isFinite(parsed) ? parsed : 0.2;
  const quarter = searchParams.get("quarter")?.trim() || undefined;

  const key = `${takeRate.toFixed(4)}|${quarter ?? "current"}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return NextResponse.json(hit.data);
  }

  const forecast = await computeRevenueForecast(takeRate, quarter);
  cache.set(key, { at: Date.now(), data: forecast });
  return NextResponse.json(forecast);
}
