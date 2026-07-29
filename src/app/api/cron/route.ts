import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { scrapeListings } from "@/lib/scraper";
import { scrapeMarketplaceMetrics, type SellerInfo } from "@/lib/marketplace-metrics";
import { computeRevenueForecast, ingestAuctions } from "@/lib/auctions";
import { fetchSoldRange } from "@/lib/sold-export";
import {
  writeSoldLots,
  isAzureSqlConfigured,
  getDistinctSellersForFees,
  getSellerFeesFresh,
  upsertSellerFees,
  refreshFeeAnalytics,
  type SellerFeeRow,
} from "@/lib/azure-sql";
import { fetchBidbox } from "@/lib/asset-fees";
import { etQuarterKey } from "@/lib/time";
import { quarterDayKeys } from "@/lib/qtd-shared";
import { sendReportEmail, type ReportEmailResult } from "@/lib/report-email";
import { CronLogger, type SourceSummary } from "@/lib/cron-log";
import { useAzureData } from "@/lib/data-backend";
import { azUpsertListing, azUpsertMarketplaceSellers, azUpsertForecastSnapshot } from "@/lib/azure-tables";

// Daily reconciliation also materializes the forecast after ingestion.
export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }

  const authHeader = request.headers.get("authorization");
  const { searchParams } = new URL(request.url);
  const querySecret = searchParams.get("secret");
  const authToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const valid = authToken === cronSecret || (querySecret !== null && querySecret === cronSecret);
  if (!valid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const date = now.toISOString().slice(0, 10);
  const timestamp = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  // The scheduler fires at fixed UTC hours, so noon ET shifts with daylight
  // saving time. Accept either 11 or 12 ET by default; four-hour scheduling
  // means only one of them can occur on a given day.
  const dailyHours = (process.env.DAILY_INGEST_HOURS_ET || "11,12")
    .split(",")
    .map(Number)
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);
  const isDailyRun = dailyHours.includes(now.getHours());
  const forceDaily = searchParams.get("daily") === "1" || searchParams.get("sendEmail") === "1";
  const runSoldCapture = isDailyRun || forceDaily || searchParams.get("sold") === "1";

  // Preview trigger: build + send the report ONLY (to rma@clearlinecap.com),
  // running no scrapers and writing no cron_runs — for reviewing the output.
  if (searchParams.get("sendReportOnly") === "1") {
    if (!process.env.RESEND_API_KEY) {
      return NextResponse.json({ error: "RESEND_API_KEY not set" }, { status: 500 });
    }
    const preview = await sendReportEmail({ date, timestamp, toOverride: "rma@clearlinecap.com" });
    return NextResponse.json({ mode: "report-preview", to: "rma@clearlinecap.com", date, timestamp, ...preview });
  }

  const logger = new CronLogger();

  // Each source is a self-contained scrape + write that returns its cron_runs
  // summary alongside any payload later steps (email, response) need. Sources
  // run in parallel and are isolated: one failing is logged, not fatal.
  const listingsTask = logger.track(
    "listings",
    async () => {
      const { allsurplus, govdeals } = await scrapeListings();
      let error: string | null = null;
      if (useAzureData()) {
        try {
          await azUpsertListing({ date, timestamp, allsurplus, govdeals });
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
      } else {
        const res = await supabaseAdmin
          .from("listings")
          .upsert({ date, timestamp, allsurplus, govdeals }, { onConflict: "date" });
        error = res.error?.message ?? null;
      }
      return { allsurplus, govdeals, error };
    },
    (r): SourceSummary => ({
      status: r.error ? "failed" : "success",
      rows: r.error ? 0 : 1,
      detail: { allsurplus: r.allsurplus, govdeals: r.govdeals },
      error: r.error,
    }),
  );

  // The marketplace_metrics cards were removed from the UI; we no longer persist
  // that table. This task still scrapes the marketplace to populate
  // marketplace_sellers, which powers the Top Sellers table on the Marketplace page.
  const metricsTask = logger.track(
    "marketplace_metrics",
    async () => {
      const metrics = await scrapeMarketplaceMetrics();
      const sellerRow = (s: SellerInfo, platform: "AD" | "GD") => ({
        date,
        platform,
        account_id: s.account_id,
        company_name: s.company_name,
        country: s.country,
        state: s.state,
        listing_count: s.listing_count,
        total_current_bid: s.total_current_bid,
        total_bids: s.total_bids,
        top_bid_asset_id: s.top_bid_asset_id,
        sub_business_id: s.sub_business_id,
      });
      const sellerRows = [
        ...metrics.allsurplus.sellers.map((s) => sellerRow(s, "AD")),
        ...metrics.govdeals.sellers.map((s) => sellerRow(s, "GD")),
      ];
      let sellersStored = 0;
      let sellersError: string | null = null;
      if (sellerRows.length > 0) {
        if (useAzureData()) {
          try {
            await azUpsertMarketplaceSellers(sellerRows);
            sellersStored = sellerRows.length;
          } catch (e) {
            sellersError = e instanceof Error ? e.message : String(e);
          }
        } else {
          const { error } = await supabaseAdmin
            .from("marketplace_sellers")
            .upsert(sellerRows, { onConflict: "date,platform,account_id" });
          sellersError = error?.message ?? null;
          sellersStored = error ? 0 : sellerRows.length;
        }
      }
      // scrapeMarketplaceMetrics never throws; a total fetch failure returns
      // empty metrics (sample_size 0, no sellers). Surface that as a failed run
      // rather than a silent 0-row "success" (which would leave the freshness
      // badge green during an outage).
      const scrapeFailed = metrics.allsurplus.sample_size === 0 && metrics.govdeals.sample_size === 0;
      return {
        sellersStored,
        sellersError,
        scrapeFailed,
        adSample: metrics.allsurplus.sample_size,
        gdSample: metrics.govdeals.sample_size,
        scrapeDebug: `AD: ${metrics.allsurplus.debug ?? "?"}; GD: ${metrics.govdeals.debug ?? "?"}`,
      };
    },
    (r): SourceSummary => ({
      status: r.sellersError || r.scrapeFailed ? "failed" : "success",
      rows: r.sellersStored,
      detail: { adSample: r.adSample, gdSample: r.gdSample, sellersStored: r.sellersStored },
      error: r.sellersError ?? (r.scrapeFailed ? `marketplace scrape returned 0 listings (${r.scrapeDebug})` : null),
    }),
  );

  const auctionsTask = logger.track(
    "auctions",
    () => ingestAuctions({ includeSold: runSoldCapture }),
    (r): SourceSummary => {
      const upserted = r.allsurplus.upserted + r.govdeals.upserted + r.sold.allsurplus.upserted + r.sold.govdeals.upserted;
      const error = r.rlsHint ?? r.allsurplus.upsertError ?? r.govdeals.upsertError ?? r.allsurplus.fetchError ?? r.govdeals.fetchError ?? null;
      return {
        status: error && upserted === 0 ? "failed" : error ? "partial" : "success",
        rows: upserted,
        detail: { closures: r.closures },
        error,
      };
    },
  );

  // Durable per-lot capture into Azure SQL (lqdt.sold_lots). Writes the last few
  // ET days' COMPLETE, deduped feed (via fetchSoldRange — true marketplace, incl.
  // GI) so the data is preserved before Maestro's ~12-month archive rolls it off.
  // Idempotent MERGE (row_key), so re-running each 4h just refreshes late-settling
  // lots. A short trailing window keeps it well within maxDuration.
  const soldCaptureTask = logger.track(
    "sold_lots",
    async () => {
      if (!runSoldCapture) {
        return { written: 0, from: null, to: null, truncated: false, skipped: true, error: null };
      }
      if (!isAzureSqlConfigured()) {
        return { written: 0, from: null, to: null, truncated: false, skipped: true, error: null };
      }
      const lookback = Number(process.env.SOLD_CAPTURE_LOOKBACK_DAYS) || 3;
      const to = date; // ET today (see `now` above)
      const fromDate = new Date(`${date}T00:00:00Z`);
      fromDate.setUTCDate(fromDate.getUTCDate() - (lookback - 1));
      const from = fromDate.toISOString().slice(0, 10);
      // Bound the whole capture so a slow store read (or a slow Maestro pull)
      // can't push the shared 60s cron past maxDuration and get the function
      // killed — which would drop cron_runs logging and the noon email for every
      // task. On timeout this task is marked failed; the rest of the cron proceeds.
      const timeoutMs = Number(process.env.SOLD_CAPTURE_TIMEOUT_MS) || 45000;
      try {
        return await Promise.race([
          (async () => {
            const fetched = await fetchSoldRange(from, to, { maxPages: 400 });
            const { written } = await writeSoldLots(fetched.rows);
            return { written, from, to, truncated: fetched.truncated, skipped: false, error: null as string | null };
          })(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("sold_lots capture timeout")), timeoutMs)),
        ]);
      } catch (e) {
        return { written: 0, from, to, truncated: false, skipped: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    (r): SourceSummary => ({
      status: r.skipped ? "skipped" : r.error ? "failed" : "success",
      rows: r.written,
      detail: { from: r.from, to: r.to, truncated: r.truncated },
      error: r.error,
    }),
  );

  // Capture each seller's LQDT admin (seller) fee % — a per-seller contracted rate
  // from Maestro's per-asset detail endpoint. Only sellers not already fresh in the
  // store are fetched, capped per run, so coverage of the quarter's sellers fills in
  // over successive daily runs without hammering Maestro. Own time budget so it can
  // never push the shared cron past maxDuration. Best-effort: failures are logged,
  // never fatal to the rest of the cron.
  const sellerFeeTask = logger.track(
    "seller_fees",
    async () => {
      if (!runSoldCapture || !isAzureSqlConfigured()) {
        return { fetched: 0, remaining: 0, skipped: true, error: null as string | null };
      }
      const timeoutMs = Number(process.env.SELLER_FEE_TIMEOUT_MS) || 30000;
      const maxPerRun = Number(process.env.SELLER_FEE_MAX_PER_RUN) || 150;
      try {
        return await Promise.race([
          (async () => {
            const quarterStart = quarterDayKeys(etQuarterKey(date))[0] ?? date;
            const sellers = await getDistinctSellersForFees(quarterStart); // top-GMV first
            const fresh = await getSellerFeesFresh(30);
            const missing = sellers.filter((s) => s.account_id && !fresh.has(`${s.site}:${s.account_id}`));
            const todo = missing.slice(0, maxPerRun);
            // Internal deadline with headroom under the hard timeout; flush each batch so a
            // slow tail never discards the whole run's fetched fees (partial progress persists).
            const deadline = Date.now() + timeoutMs - 4000;
            const BATCH = 40;
            let fetched = 0;
            let attempted = 0;
            for (let start = 0; start < todo.length && Date.now() < deadline; start += BATCH) {
              const batch = todo.slice(start, start + BATCH);
              attempted += batch.length;
              const rows: SellerFeeRow[] = [];
              let i = 0;
              const worker = async () => {
                while (i < batch.length && Date.now() < deadline) {
                  const s = batch[i++];
                  const to = Math.min(8000, deadline - Date.now());
                  if (to <= 250) break;
                  const b = await fetchBidbox(s.site, s.asset_id, s.account_id, s.auction_id, to, true);
                  // Persist when EITHER fee is known (a lot may expose the premium or the
                  // admin fee, not both); still bumps fetched_at so the seller is fresh.
                  if (b && (b.adminFeePercent != null || b.premiumPercent != null))
                    rows.push({
                      site: s.site,
                      account_id: s.account_id,
                      admin_fee_percent: b.adminFeePercent,
                      buyer_premium_percent: b.premiumPercent,
                    });
                }
              };
              await Promise.all(Array.from({ length: 8 }, worker));
              if (rows.length) fetched += await upsertSellerFees(rows);
            }
            return { fetched, remaining: Math.max(0, missing.length - attempted), skipped: false, error: null as string | null };
          })(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("seller_fees capture timeout")), timeoutMs)),
        ]);
      } catch (e) {
        return { fetched: 0, remaining: 0, skipped: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    (r): SourceSummary => ({
      status: r.skipped ? "skipped" : r.error ? "failed" : "success",
      rows: r.fetched,
      detail: { remaining: r.remaining },
      error: r.error,
    }),
  );

  const [listingResult] = await Promise.all([
    listingsTask,
    metricsTask,
    auctionsTask,
    soldCaptureTask,
    sellerFeeTask,
  ]);

  // Materialize the current forecast while Azure SQL is already awake. Normal
  // dashboard views then read one small Supabase row instead of waking SQL.
  await logger.track(
    "forecast_snapshot",
    async () => {
      if (!runSoldCapture) return { skipped: true, stored: 0, error: null as string | null };
      try {
        const payload = await computeRevenueForecast(1);
        if (useAzureData()) {
          await azUpsertForecastSnapshot(payload.quarter, payload);
          return { skipped: false, stored: 1, error: null };
        }
        const { error } = await supabaseAdmin.from("forecast_snapshots").upsert(
          { quarter: payload.quarter, payload, generated_at: new Date().toISOString() },
          { onConflict: "quarter" },
        );
        return { skipped: false, stored: error ? 0 : 1, error: error?.message ?? null };
      } catch (error) {
        return { skipped: false, stored: 0, error: error instanceof Error ? error.message : String(error) };
      }
    },
    (r): SourceSummary => ({
      status: r.skipped ? "skipped" : r.error ? "failed" : "success",
      rows: r.stored,
      error: r.error,
    }),
  );

  // Keep operational/history tables bounded. This runs after ingestion so it
  // cannot contend with the writers above. Migration 024 installs the RPC.
  await logger.track(
    "retention",
    async () => {
      if (!isDailyRun && !forceDaily && searchParams.get("retention") !== "1") {
        return { skipped: true, deleted: 0, error: null as string | null };
      }
      const { data, error } = await supabaseAdmin.rpc("run_cost_retention");
      const counts = (data ?? {}) as Record<string, unknown>;
      const deleted = Object.values(counts).reduce<number>(
        (sum, value) => sum + (typeof value === "number" ? value : 0),
        0,
      );
      return { skipped: false, deleted, error: error?.message ?? null };
    },
    (r): SourceSummary => ({
      status: r.skipped ? "skipped" : r.error ? "failed" : "success",
      rows: r.deleted,
      error: r.error,
    }),
  );

  // Report email on exactly two runs — noon + 5pm ET — tied to the specific
  // fire, not the raw hour, so DST can't misroute it:
  //   - noon:    the daily lqdt-cron fire (isDailyRun, 16:00 UTC → ET 12/11).
  //   - evening: the 5pm lqdt-sold-capture fire (?sold=1 at ET 16/17, 21:00 UTC).
  // Gating the evening send on ?sold=1 excludes the 4pm-EDT every-4h lqdt-cron
  // fire (20:00 UTC → ET hour 16, but no sold flag) — the spurious third send —
  // and the ET-hour bound excludes the 11pm sold-capture fire (03:00 UTC → 22/23).
  // ?sendEmail=1 forces, ?sendEmail=0 suppresses. The forecast snapshot above is
  // refreshed before this step on both runs, so the QTD numbers are fresh.
  const eveningHours = (process.env.REPORT_EVENING_HOURS_ET || "16,17")
    .split(",")
    .map(Number)
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  const forceEmail = searchParams.get("sendEmail") === "1";
  const skipEmail = searchParams.get("sendEmail") === "0";
  const eveningReport = searchParams.get("sold") === "1" && eveningHours.includes(now.getHours());
  const shouldEmail = !skipEmail && (forceEmail || isDailyRun || eveningReport);
  let emailResult: ReportEmailResult = {
    success: false,
    error: shouldEmail ? "skipped" : "skipped: not a report-hour run",
  };
  if (shouldEmail && process.env.RESEND_API_KEY) {
    emailResult = await sendReportEmail({ date, timestamp });
    // Persist the headline in the email row so the NEXT report can diff against it.
    logger.push("email", emailResult.success ? "success" : "failed", null, { charts: emailResult.charts, headline: emailResult.headline ?? null }, emailResult.error ?? null);
  } else {
    logger.push("email", "skipped", null, null, emailResult.error ?? null);
  }

  // Precompute the Take Rate page's fee analytics into lqdt.analytics_cache. The
  // underlying sold_lots ⋈ seller_fees aggregation takes ~2.5 min on this tier, so it can
  // neither run on a request path nor block the cron response — it is fired and forgotten
  // on the long-running container, and a failure just leaves the previous snapshot in place.
  //
  // Fired LAST, after the report email: it used to run before the forecast snapshot and
  // the email, and its (then concurrent) queries starved the pool so the email's
  // getSoldDaily timed out and mailed a live quarter collapsed to the sparse tracked feed.
  if (runSoldCapture && isAzureSqlConfigured()) {
    const analyticsFrom = new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10);
    void refreshFeeAnalytics(analyticsFrom)
      .then((r) => console.log(`[cron] fee_analytics refreshed in ${r.ms}ms`))
      .catch((e) => console.error("[cron] fee_analytics failed:", e instanceof Error ? e.message : String(e)));
  }

  const runs = await logger.flush();

  return NextResponse.json({
    run_id: logger.runId,
    date,
    timestamp,
    runs,
    email: emailResult,
  });
}
