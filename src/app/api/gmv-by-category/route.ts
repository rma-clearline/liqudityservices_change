import { NextResponse } from "next/server";
import { categoryByPeriod, fetchSoldRange, type ExportPeriod } from "@/lib/sold-export";
import { getCategoryDaily, isAzureSqlConfigured } from "@/lib/azure-sql";
import { ttlCache } from "@/lib/cache";
import { etTodayKey, quarterBounds } from "@/lib/time";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Cache the (only) expensive step — the Azure SQL GROUP BY — keyed by range.
// The per-period/per-category shaping is cheap in-memory JS, so period and
// Top-N changes reuse these rows and never re-hit the DB. Coalesced + per-replica
// (pairs with the business-hours keep-warm), mirroring the forecast route.
type CategoryDailyRows = Awaited<ReturnType<typeof getCategoryDaily>>;
const categoryDailyCache = ttlCache<CategoryDailyRows>(Number(process.env.CATEGORY_CACHE_MS) || 15 * 60_000);

async function loadCategoryDaily(from: string, to: string): Promise<CategoryDailyRows> {
  // The store is provisioned (no auto-pause / cold start), so this is sub-second;
  // the timeout is only a guard against a stuck connection. On failure we return a
  // clean 503 rather than falling through to a full-range Maestro pull with little
  // budget left (which is what let the ingress emit a non-JSON body — see below).
  const timeoutMs = Number(process.env.CATEGORY_STORE_TIMEOUT_MS) || 20_000;
  return Promise.race([
    getCategoryDaily(from, to),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("category store timeout")), timeoutMs)),
  ]);
}

function parsePeriod(v: string | null): ExportPeriod {
  return v === "day" || v === "week" || v === "month" || v === "quarter" ? v : "quarter";
}

// Revenue-by-category composition. Prefer the durable Azure store: one indexed
// GROUP BY returns complete, deduped (incl. GI) composition in well under a
// second. The old path pulled the ENTIRE range from Maestro live (value-ranked,
// paged in weekly chunks), which on the chart's full-history range exceeded
// maxDuration — the container was killed mid-request and the ingress returned a
// plaintext "upstream connect error ..." body that broke the client's JSON parse
// ("Unexpected token 'u'"). Maestro stays the fallback only when the store is
// unconfigured or empty for the range.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const cur = quarterBounds(new Date());
  let from = (searchParams.get("from") ?? "").trim();
  let to = (searchParams.get("to") ?? "").trim();
  if (!DATE_RE.test(from)) from = cur.start.toISOString().slice(0, 10);
  if (!DATE_RE.test(to)) to = etTodayKey();
  if (from > to) [from, to] = [to, from];
  const period = parsePeriod(searchParams.get("period"));

  // Return the top-K categories (K well above the max selectable Top-N) with the
  // long tail already folded into "Other". The client folds further to its chosen
  // Top-N in memory — merging ranks (Top-N..K] into the residual "Other" — so Top-N
  // toggles reuse this response and never re-request (hence no `topN` param here).
  // K bounds the payload: the store carries ~1k long-tail free-text categories,
  // virtually all of which the UI would collapse into "Other" anyway.
  const SERVER_TOPN = 15;

  try {
    if (isAzureSqlConfigured()) {
      let daily: CategoryDailyRows;
      try {
        daily = await categoryDailyCache.get(`${from}|${to}`, () => loadCategoryDaily(from, to));
      } catch {
        return NextResponse.json(
          { error: "Category breakdown is temporarily unavailable — please retry." },
          { status: 503 },
        );
      }
      if (daily.length > 0) {
        const rows = daily.map((d) => ({ category: d.category, close_date_et: d.date, sale_amount_usd: d.gmv }));
        const { categories, data } = categoryByPeriod(rows, period, SERVER_TOPN);
        // Store data is complete (not a value-ranked sample), so truncated=false.
        return NextResponse.json({ from, to, period, categories, data, truncated: false, source: "store" });
      }
      // Store has no rows for this range (e.g. entirely pre-store) — fall through.
    }

    // Fallback: Maestro sold archive (value-ranked, bounded pages).
    const fetched = await fetchSoldRange(from, to, { maxPages: 60 });
    const { categories, data } = categoryByPeriod(fetched.rows, period, SERVER_TOPN);
    return NextResponse.json({
      from,
      to,
      period,
      categories,
      data,
      total_in_range: fetched.total_in_range,
      truncated: fetched.truncated,
      source: "maestro",
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
