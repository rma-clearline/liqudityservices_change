import { NextResponse } from "next/server";
import {
  aggregateExport,
  applyExportFilters,
  fetchSoldRange,
  periodKey,
  RangeTooLargeError,
  type ExportFilters,
  type ExportMarket,
  type ExportPeriod,
  type ExportSite,
  type ExportType,
  type PivotRow,
  type SoldExportRow,
} from "@/lib/sold-export";
import { countSoldLots, isAzureSqlConfigured, readSoldLots, storeCoversRange } from "@/lib/azure-sql";
import { loadHistoricalDailyTotalsForExport } from "@/lib/auctions";
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

// The Azure SQL store (provisioned S2, always-on — no serverless auto-pause) is
// the correct, COMPLETE source for any covered range, so we wait for it rather
// than bail early to the lossy live-Maestro fallback. 50s comfortably covers a
// dense single month's raw read on the S2 tier while staying under the ingress
// limit; it only guards a genuinely stuck connection. (Env-overridable.)
const STORE_TIMEOUT_MS = Number(process.env.STORE_READ_TIMEOUT_MS) || 50000;

// A single export request must materialize its whole result on the small app
// container. If a live-fallback range would exceed this many lots, fetchSoldRange
// aborts with RangeTooLargeError (a clean, retryable 503) instead of attempting a
// doomed full pull; the modal then re-requests the range in smaller COMPLETE
// slices. Set well above a normal fallback (the last few uncovered days) but below
// a dense month (~150k lots). (Env-overridable.)
const LIVE_FALLBACK_MAX_LOTS = Number(process.env.EXPORT_LIVE_MAX_LOTS) || 60000;

// Same guard for the STORE path: a covered dense range (a full dense month is
// ~70k lots; the API accepts up to 366 days ≈ 830k) would be materialized as wide
// JS rows + one giant CSV string and can OOM the container — the platform then
// kills the replica and 503s everything, including the retries. countSoldLots
// (an indexed COUNT, ~1s) refuses it cheaply BEFORE the read, as a clean
// range_too_large 503 the modal answers by splitting. Higher than the live cap:
// a store read is one query, not an 800-page live pull, so memory is the only
// constraint. Default sized for the 1Gi container. (Env-overridable.)
const STORE_MAX_LOTS = Number(process.env.EXPORT_STORE_MAX_LOTS) || 120000;

// KNOWN LIMITATION: this races but does NOT cancel the losing promise — a store
// read that exceeds the budget keeps buffering rows in the background (until the
// driver's 120s requestTimeout) while the caller moves on to the Maestro fallback.
// Cancelling would require plumbing mssql request.cancel() through readSoldLots;
// with the count guard bounding reads and 1Gi of memory, the residual overlap
// window isn't worth that complexity today.
function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label)), STORE_TIMEOUT_MS)),
  ]);
}

// Prefer the durable Azure store, but ONLY for a range it FULLY covers (every ET
// day present) — otherwise a leading/interior gap would be served as a complete $0
// result. Fall back to the live Maestro feed when the store is unconfigured, doesn't
// fully cover the range, or is unreachable/slow within the timeout.
async function loadSoldRows(from: string, to: string, filters: ExportFilters): Promise<SoldSource> {
  if (isAzureSqlConfigured()) {
    const readFilters = {
      site: filters.site === "all" ? undefined : filters.site,
      sellerType: filters.type === "government" || filters.type === "retail" ? filters.type : undefined,
      govLevel: filters.type === "federal" || filters.type === "state" || filters.type === "local" ? filters.type : undefined,
      market: filters.market === "all" ? undefined : filters.market,
      category: filters.category,
      state: filters.state,
      country: filters.country,
      minUsd: filters.minUsd,
      maxUsd: filters.maxUsd,
    };
    try {
      // ONE shared timeout budget for the whole store attempt (coverage check +
      // count guard + read), not one per call: sequential withTimeout guards would
      // let a stalled DB connection burn several×STORE_TIMEOUT_MS and blow the
      // request budget. Returns null when the range isn't fully covered → fall
      // through to Maestro.
      const rows = await withTimeout(
        (async () => {
          if (!(await storeCoversRange(from, to))) return null;
          // Refuse a too-large read BEFORE materializing it (see STORE_MAX_LOTS).
          const lotCount = await countSoldLots(from, to, readFilters);
          if (lotCount > STORE_MAX_LOTS) throw new RangeTooLargeError(from, to, lotCount, STORE_MAX_LOTS);
          return readSoldLots(from, to, readFilters);
        })(),
        "store timeout",
      );
      if (rows !== null) {
        return { rows, total_in_range: rows.length, fetched: rows.length, truncated: false, source: "sold_lots" };
      }
      // store doesn't fully cover the range → fall through to Maestro
    } catch (e) {
      // Too-large means "split the window" — Maestro can't serve it either (the
      // live path would just refuse it again after wasted probes), so surface it.
      if (e instanceof RangeTooLargeError) throw e;
      // store unreachable / slow / partial → fall through to Maestro
    }
  }
  const f = await fetchSoldRange(from, to, { maxRows: LIVE_FALLBACK_MAX_LOTS });
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

const nextDayKey = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
};

type HistExport = Awaited<ReturnType<typeof loadHistoricalDailyTotalsForExport>>;

// The historical CSV is a daily AGGREGATE: it carries the deduped ALL total and a
// per-site (AD/GD/GI) split and a domestic/international split — but NO gov/retail
// type, NO category, NO per-lot rows, and no site×market cross. So it can only
// honor a site-only OR market-only filter; anything finer excludes historical.
function historicalHonorsFilters(f: ExportFilters): boolean {
  if (f.type !== "all" || f.category || f.state || f.country || f.minUsd != null || f.maxUsd != null) return false;
  if (f.site !== "all" && f.market !== "all") return false; // no site×market cross in the CSV
  return true;
}

// Resolve the (gmv, lots, site, market) a historical day contributes under the
// current filter. Uses the deduped ALL total when unfiltered (what the monthly
// table sums), a single site's total when site-filtered, or the domestic/intl
// split when market-filtered. Null when the day/site isn't present.
function histDay(hist: HistExport, date: string, f: ExportFilters): { gmv: number; lots: number; site: string; market: string } | null {
  const t = hist.byDate.get(date);
  if (!t) return null;
  // Round PER DAY, exactly as the forecast's daily series does (Math.round on each
  // realized_gmv_usd), so summed periods reconcile to the monthly table to the dollar.
  if (f.site !== "all") {
    const p = hist.platforms.get(f.site)?.get(date);
    if (!p) return null;
    return { gmv: Math.round(p.gmv), lots: p.lots, site: f.site, market: "all" };
  }
  if (f.market === "domestic") return { gmv: Math.round(t.domestic), lots: 0, site: "all", market: "domestic" };
  if (f.market === "international") return { gmv: Math.round(t.international), lots: 0, site: "all", market: "international" };
  return { gmv: Math.round(t.gmv), lots: t.lots, site: "all", market: "all" };
}

// Historical pivot rows for [from,to] — one aggregate row per period at the CSV's
// granularity, so the historical totals reconcile to the monthly table exactly.
function historicalPivot(hist: HistExport, from: string, to: string, period: ExportPeriod, f: ExportFilters): PivotRow[] {
  const map = new Map<string, PivotRow>();
  for (const [date] of hist.byDate) {
    if (date < from || date > to) continue;
    const d = histDay(hist, date, f);
    if (!d) continue;
    const pk = periodKey(date, period);
    const key = `${pk}|${d.site}|all|${d.market}`;
    const cur = map.get(key);
    if (cur) {
      cur.gmv_usd += d.gmv;
      cur.lots += d.lots;
    } else {
      map.set(key, { period: pk, site: d.site, type: "all", market: d.market, gmv_usd: d.gmv, lots: d.lots });
    }
  }
  return [...map.values()];
}

// Historical RAW rows: per-day aggregate. Per-lot detail predates the store (aged
// out of Maestro), so these are clearly-labeled daily totals, not individual lots.
function historicalRaw(hist: HistExport, from: string, to: string, f: ExportFilters): Record<string, unknown>[] {
  const dates = [...hist.byDate.keys()].filter((d) => d >= from && d <= to).sort();
  const rows: Record<string, unknown>[] = [];
  for (const date of dates) {
    const d = histDay(hist, date, f);
    if (!d) continue;
    rows.push({
      close_date_et: date,
      site: d.site === "all" ? "All sites" : siteLabel(d.site),
      seller_type: "all",
      market: d.market,
      title: "Daily total (pre-store — per-lot detail unavailable)",
      sale_amount_usd: Math.round(d.gmv * 100) / 100,
    });
  }
  return rows;
}

function histLotsInRange(hist: HistExport, from: string, to: string, f: ExportFilters): number {
  let n = 0;
  for (const [date] of hist.byDate) {
    if (date < from || date > to) continue;
    const d = histDay(hist, date, f);
    if (d) n += d.lots;
  }
  return n;
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

  // Split at the historical-CSV boundary. Historical days come from the SAME daily
  // CSV the monthly forecast table reads (so totals reconcile to the dollar, and a
  // month the store only partially covers — e.g. 2025-07 — is whole again instead
  // of collapsing to aged-out Maestro's last few days). The live tail after the CSV
  // comes from the per-lot store, which the monthly table's live days also use.
  const hist = await loadHistoricalDailyTotalsForExport();
  const csvEnd = hist.maxDate;
  const useHist = Boolean(csvEnd) && from <= csvEnd && historicalHonorsFilters(filters);
  const histTo = to <= csvEnd ? to : csvEnd;
  const liveFrom = !csvEnd || from > csvEnd ? from : nextDayKey(csvEnd);
  const hasLive = !csvEnd || liveFrom <= to;

  let live: SoldSource = { rows: [], total_in_range: 0, fetched: 0, truncated: false, source: "sold_lots" };
  if (hasLive) {
    try {
      live = await loadSoldRows(liveFrom, to, filters);
    } catch (e) {
      // A range too large to fetch live in one request → clean, retryable 503 so the
      // client re-requests it as smaller complete slices. Anything else → 502.
      if (e instanceof RangeTooLargeError) {
        return NextResponse.json({ error: e.message, code: e.code }, { status: 503 });
      }
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }
  const liveFiltered = applyExportFilters(live.rows, filters);

  const source = useHist ? (hasLive ? "csv+store" : "csv") : live.source;
  const matched = liveFiltered.length + (useHist ? histLotsInRange(hist, from, histTo, filters) : 0);
  const headers = new Headers({
    "Content-Type": "text/csv; charset=utf-8",
    "X-Export-Total-In-Range": String(live.total_in_range),
    "X-Export-Fetched": String(live.fetched),
    "X-Export-Matched": String(matched),
    "X-Export-Truncated": String(live.truncated),
    "X-Export-From": from,
    "X-Export-To": to,
    "X-Export-Source": source,
  });

  if (mode === "pivot") {
    const period = parsePeriod(searchParams.get("period"));
    const pivotMap = new Map<string, PivotRow>();
    for (const r of aggregateExport(liveFiltered, period)) {
      pivotMap.set(`${r.period}|${r.site}|${r.type}|${r.market}`, r);
    }
    if (useHist) {
      for (const r of historicalPivot(hist, from, histTo, period, filters)) {
        const key = `${r.period}|${r.site}|${r.type}|${r.market}`;
        const c = pivotMap.get(key);
        if (c) {
          c.gmv_usd += r.gmv_usd;
          c.lots += r.lots;
        } else {
          pivotMap.set(key, r);
        }
      }
    }
    const pivot = [...pivotMap.values()]
      .map((r) => ({
        ...r,
        site: r.site === "all" ? "All sites" : siteLabel(r.site),
        gmv_usd: Math.round(r.gmv_usd * 100) / 100,
      }))
      .sort(
        (a, b) =>
          a.period.localeCompare(b.period) ||
          a.site.localeCompare(b.site) ||
          a.type.localeCompare(b.type) ||
          a.market.localeCompare(b.market),
      );
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

  const rawRows: Record<string, unknown>[] = [
    ...(useHist ? historicalRaw(hist, from, histTo, filters) : []),
    ...liveFiltered.map((r) => ({ ...r, site: siteLabel(r.site) })),
  ];
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
    { key: "opening_bid_usd", label: "Opening Bid (USD)" },
    { key: "bid_count", label: "Bids" },
    { key: "start_time_et", label: "Auction Start (ET)" },
    { key: "asset_status_cd", label: "Status" },
    { key: "category_code", label: "Category Code" },
    { key: "url", label: "URL" },
    { key: "asset_id", label: "Asset ID" },
    { key: "auction_id", label: "Auction ID" },
  ]);
  headers.set("Content-Disposition", `attachment; filename="lqdt-gmv-transactions-${from}_to_${to}.csv"`);
  return new Response(csv, { headers });
}
