import { NextResponse } from "next/server";
import { computeRevenueForecast, type RevenueForecast } from "@/lib/auctions";
import { ttlCache } from "@/lib/cache";

export const dynamic = "force-dynamic";

// The forecast recomputes over the whole auctions table (+ Azure SQL), and is
// requested by both the executive summary and the forecast section. Cache briefly
// per (takeRate, quarter) so a dashboard load doesn't compute it twice.
const forecastCache = ttlCache<RevenueForecast>(60_000);

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const takeRateParam = searchParams.get("takeRate");
  const parsed = takeRateParam ? Number(takeRateParam) : 0.2;
  const takeRate = Number.isFinite(parsed) ? parsed : 0.2;
  const quarter = searchParams.get("quarter")?.trim() || undefined;

  const key = `${takeRate.toFixed(4)}|${quarter ?? "current"}`;
  const forecast = await forecastCache.get(key, () => computeRevenueForecast(takeRate, quarter));
  return NextResponse.json(forecast);
}
