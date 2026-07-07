import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const DEFAULT_TICKER = "LQDT";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Cache successful Yahoo responses per (ticker, from, to) for a few minutes — the
// series only changes daily, and this avoids hammering Yahoo on every dashboard
// load. Inline (not the shared helper) so the 400/502 error responses below stay
// intact; only successes are cached.
type PricePayload = {
  ticker: string;
  name: string | null;
  currency: string;
  source: string;
  prices: Array<{ date: string; close: number }>;
};
const priceCache = new Map<string, { at: number; data: PricePayload }>();
const PRICE_TTL_MS = Number(process.env.STOCK_PRICE_CACHE_MS) || 5 * 60_000;

type YahooChartResponse = {
  chart?: {
    result?: Array<{
      meta?: {
        currency?: string;
        symbol?: string;
        longName?: string;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          close?: Array<number | null>;
        }>;
      };
    }>;
    error?: {
      description?: string;
    } | null;
  };
};

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function defaultFromDate() {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return formatDate(date);
}

function normalizeTicker(value: string | null) {
  const ticker = (value || DEFAULT_TICKER).trim().toUpperCase();
  if (!/^[A-Z0-9.^-]{1,16}$/.test(ticker)) {
    throw new Error("ticker must be 1-16 characters");
  }
  return ticker;
}

function parseDateParam(value: string | null, fallback: string) {
  if (!value) return fallback;
  if (!DATE_RE.test(value)) throw new Error("dates must be YYYY-MM-DD");
  return value;
}

function epochSeconds(date: string, addDays = 0) {
  const [year, month, day] = date.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day + addDays) / 1000);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  try {
    const ticker = normalizeTicker(searchParams.get("ticker"));
    const to = parseDateParam(searchParams.get("to"), formatDate(new Date()));
    const from = parseDateParam(searchParams.get("from"), defaultFromDate());

    if (from > to) {
      return NextResponse.json({ error: "from must be on or before to" }, { status: 400 });
    }

    const cacheKey = `${ticker}|${from}|${to}`;
    const cachedHit = priceCache.get(cacheKey);
    if (cachedHit && Date.now() - cachedHit.at < PRICE_TTL_MS) {
      return NextResponse.json(cachedHit.data);
    }

    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`);
    url.searchParams.set("period1", String(epochSeconds(from)));
    url.searchParams.set("period2", String(epochSeconds(to, 1)));
    url.searchParams.set("interval", "1d");
    url.searchParams.set("events", "history");
    url.searchParams.set("includeAdjustedClose", "true");

    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        "User-Agent": "liqudityservices-dashboard/1.0",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return NextResponse.json(
        { error: `stock price request failed: ${response.status} ${body.slice(0, 160)}` },
        { status: 502 },
      );
    }

    const payload = (await response.json()) as YahooChartResponse;
    const chartError = payload.chart?.error;
    if (chartError) {
      return NextResponse.json({ error: chartError.description || "stock price request failed" }, { status: 502 });
    }

    const result = payload.chart?.result?.[0];
    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    const prices: Array<{ date: string; close: number }> = [];

    for (let index = 0; index < timestamps.length; index += 1) {
      const close = closes[index];
      if (typeof close !== "number" || !Number.isFinite(close)) continue;
      prices.push({
        date: formatDate(new Date(timestamps[index] * 1000)),
        close: Math.round(close * 100) / 100,
      });
    }

    const data: PricePayload = {
      ticker: result?.meta?.symbol ?? ticker,
      name: result?.meta?.longName ?? null,
      currency: result?.meta?.currency ?? "USD",
      source: "Yahoo Finance chart",
      prices,
    };
    priceCache.set(cacheKey, { at: Date.now(), data });
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
