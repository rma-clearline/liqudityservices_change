import { NextResponse } from "next/server";
import {
  HISTORICAL_SALES_SORT_KEYS,
  fetchHistoricalSalesForDate,
  type HistoricalSalesSortKey,
  type HistoricalSalesSortOrder,
  type HistoricalSalesMarket,
} from "@/lib/historical-sales";

export const dynamic = "force-dynamic";

function clampInt(value: string | null, fallback: number, min: number, max: number) {
  const parsed = value ? Number(value) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function optionalAmount(value: string | null) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalText(value: string | null, maxLength = 120) {
  const text = value?.trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function parseSortBy(value: string | null): HistoricalSalesSortKey {
  if (value && (HISTORICAL_SALES_SORT_KEYS as readonly string[]).includes(value)) {
    return value as HistoricalSalesSortKey;
  }
  return "amount";
}

function parseSortOrder(value: string | null): HistoricalSalesSortOrder {
  return value === "asc" ? "asc" : "desc";
}

function parseMarket(value: string | null): HistoricalSalesMarket {
  if (value === "domestic" || value === "international") return value;
  return "all";
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date");

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }

  const page = clampInt(searchParams.get("page"), 1, 1, 500);
  const pageSize = clampInt(searchParams.get("pageSize"), 250, 25, 1000);
  const minAmount = optionalAmount(searchParams.get("minAmount"));
  const maxAmount = optionalAmount(searchParams.get("maxAmount"));

  try {
    const result = await fetchHistoricalSalesForDate(date, {
      page,
      pageSize,
      sortBy: parseSortBy(searchParams.get("sortBy")),
      sortOrder: parseSortOrder(searchParams.get("sortOrder")),
      market: parseMarket(searchParams.get("market")),
      query: optionalText(searchParams.get("query")),
      minAmount,
      maxAmount,
      currency: optionalText(searchParams.get("currency"), 12),
      country: optionalText(searchParams.get("country"), 80),
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
