import { NextResponse } from "next/server";
import { fetchSoldRange } from "@/lib/sold-export";
import { writeSoldLots, soldCoverage, isAzureSqlConfigured } from "@/lib/azure-sql";

// One-window backfill of the durable sold-lot store. Drive it window-by-window
// (e.g. month by month) so each request stays bounded. Guarded by CRON_SECRET.
// Intended to run against the long-lived dev server or a raised-timeout host —
// a full-year run in one request would exceed a serverless maxDuration.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get("key");
  if (!process.env.CRON_SECRET || key !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isAzureSqlConfigured()) {
    return NextResponse.json({ error: "Azure SQL not configured (AZURE_SQL_*)" }, { status: 500 });
  }

  const from = (searchParams.get("from") ?? "").trim();
  const to = (searchParams.get("to") ?? "").trim();
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json({ error: "from/to must be YYYY-MM-DD (ET)" }, { status: 400 });
  }
  const maxPages = Number(searchParams.get("maxPages")) || 1000;

  const started = Date.now();
  try {
    const fetched = await fetchSoldRange(from, to, { maxPages });
    const { written, skipped } = await writeSoldLots(fetched.rows);
    const coverage = await soldCoverage(from, to);
    return NextResponse.json({
      from,
      to,
      maxPages,
      total_in_range: fetched.total_in_range, // Maestro's count for the range (pre-dedup)
      fetched: fetched.fetched, // deduped rows pulled
      truncated: fetched.truncated, // true → hit the page cap; raise maxPages and re-run
      written, // unique lots upserted to sold_lots
      skipped, // rows that could not be loaded (individually unloadable)
      coverage, // what the store now holds for [from,to]
      ms: Date.now() - started,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
