import { NextResponse } from "next/server";
import {
  aggregateExport,
  applyExportFilters,
  fetchSoldRange,
  type ExportFilters,
  type ExportMarket,
  type ExportPeriod,
  type ExportSite,
  type ExportType,
  type SoldExportRow,
} from "@/lib/sold-export";
import { isAzureSqlConfigured, readSoldLots, storeCoversRange } from "@/lib/azure-sql";
import { toCsv } from "@/lib/format";
import { siteLabel } from "@/lib/sites";
import { etTodayKey, quarterBounds } from "@/lib/time";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type SoldSource = {
  rows: SoldExportRow[];
  total_in_range: number;
  fetched: number;
  truncated: boolean;
  source: "sold_lots" | "maestro";
};

const STORE_TIMEOUT_MS = Number(process.env.STORE_READ_TIMEOUT_MS) || 25000;

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label)), STORE_TIMEOUT_MS)),
  ]);
}

// Prefer the durable Azure store, but ONLY for a range it FULLY covers (every ET
// day present) — otherwise a leading/interior gap would be served as a complete $0
// result. Fall back to the live Maestro feed when the store is unconfigured, doesn't
// fully cover the range, or is cold/slow (times out on a paused serverless DB).
async function loadSoldRows(from: string, to: string, filters: ExportFilters): Promise<SoldSource> {
  if (isAzureSqlConfigured()) {
    try {
      if (await withTimeout(storeCoversRange(from, to), "store coverage timeout")) {
        const rows = await withTimeout(
          readSoldLots(from, to, {
            site: filters.site === "all" ? undefined : filters.site,
            sellerType: filters.type === "government" || filters.type === "retail" ? filters.type : undefined,
            govLevel: filters.type === "federal" || filters.type === "state" || filters.type === "local" ? filters.type : undefined,
            market: filters.market === "all" ? undefined : filters.market,
            category: filters.category,
            state: filters.state,
            country: filters.country,
            minUsd: filters.minUsd,
            maxUsd: filters.maxUsd,
          }),
          "store read timeout",
        );
        return { rows, total_in_range: rows.length, fetched: rows.length, truncated: false, source: "sold_lots" };
      }
    } catch {
      // store unreachable / slow / partial → fall through to Maestro
    }
  }
  const f = await fetchSoldRange(from, to);
  return { rows: f.rows, total_in_range: f.total_in_range, fetched: f.fetched, truncated: f.truncated, source: "maestro" };
}

function parseSite(v: string | null): ExportSite {
  return v === "AD" || v === "GD" || v === "GI" ? v : "all";
}
function parseType(v: string | null): ExportType {
  return ["government", "retail", "federal", "state", "local"].includes(v ?? "") ? (v as ExportType) : "all";
}
function parseMarket(v: string | null): ExportMarket {
  return v === "domestic" || v === "international" ? v : "all";
}
function parsePeriod(v: string | null): ExportPeriod {
  return v === "week" || v === "month" || v === "quarter" ? v : "day";
}
function num(v: string | null): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode") === "pivot" ? "pivot" : "raw";

  // Default range = current quarter start → today (the export covers sold lots).
  const cur = quarterBounds(new Date());
  let from = (searchParams.get("from") ?? "").trim();
  let to = (searchParams.get("to") ?? "").trim();
  if (!DATE_RE.test(from)) from = cur.start.toISOString().slice(0, 10);
  if (!DATE_RE.test(to)) to = etTodayKey();
  if (from > to) [from, to] = [to, from];
  const rangeDays = Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  const maxRangeDays = Number(process.env.EXPORT_MAX_RANGE_DAYS) || 366;
  if (rangeDays > maxRangeDays) {
    return NextResponse.json(
      { error: `Export range is limited to ${maxRangeDays} days; split larger exports into smaller windows.` },
      { status: 400 },
    );
  }

  const filters: ExportFilters = {
    from,
    to,
    site: parseSite(searchParams.get("site")),
    type: parseType(searchParams.get("type")),
    market: parseMarket(searchParams.get("market")),
    category: searchParams.get("category")?.slice(0, 80) || undefined,
    state: searchParams.get("state")?.slice(0, 80) || undefined,
    country: searchParams.get("country")?.slice(0, 80) || undefined,
    minUsd: num(searchParams.get("minUsd")),
    maxUsd: num(searchParams.get("maxUsd")),
  };

  let fetched: SoldSource;
  try {
    fetched = await loadSoldRows(from, to, filters);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }

  const filteredRows = applyExportFilters(fetched.rows, filters);

  const headers = new Headers({
    "Content-Type": "text/csv; charset=utf-8",
    // Coverage metadata the export modal surfaces to the analyst.
    "X-Export-Total-In-Range": String(fetched.total_in_range),
    "X-Export-Fetched": String(fetched.fetched),
    "X-Export-Matched": String(filteredRows.length),
    "X-Export-Truncated": String(fetched.truncated),
    "X-Export-From": from,
    "X-Export-To": to,
    "X-Export-Source": fetched.source,
  });

  if (mode === "pivot") {
    const period = parsePeriod(searchParams.get("period"));
    // Show the full site name (AllSurplus/GovDeals/Industrial) rather than the code.
    const pivot = aggregateExport(filteredRows, period).map((r) => ({ ...r, site: siteLabel(r.site) }));
    const csv = toCsv(pivot, [
      { key: "period", label: "Period" },
      { key: "site", label: "Site" },
      { key: "type", label: "Type" },
      { key: "market", label: "Market" },
      { key: "gmv_usd", label: "GMV (USD)" },
      { key: "lots", label: "Lots" },
    ]);
    headers.set("Content-Disposition", `attachment; filename="lqdt-gmv-pivot-${period}-${from}_to_${to}.csv"`);
    return new Response(csv, { headers });
  }

  const rawRows = filteredRows.map((r) => ({ ...r, site: siteLabel(r.site) }));
  const csv = toCsv(rawRows, [
    { key: "close_date_et", label: "Close Date (ET)" },
    { key: "close_time_utc", label: "Close (UTC)" },
    { key: "site", label: "Site" },
    { key: "seller_type", label: "Type" },
    { key: "gov_level", label: "Seller Level" },
    { key: "seller", label: "Seller" },
    { key: "market", label: "Market" },
    { key: "title", label: "Title" },
    { key: "category", label: "Category" },
    { key: "country", label: "Country" },
    { key: "state", label: "State" },
    { key: "currency_code", label: "Currency" },
    { key: "sale_amount_native", label: "Native Amount" },
    { key: "sale_amount_usd", label: "USD Amount" },
    { key: "bid_count", label: "Bids" },
    { key: "url", label: "URL" },
    { key: "asset_id", label: "Asset ID" },
    { key: "auction_id", label: "Auction ID" },
  ]);
  headers.set("Content-Disposition", `attachment; filename="lqdt-gmv-transactions-${from}_to_${to}.csv"`);
  return new Response(csv, { headers });
}
