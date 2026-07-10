import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { scrapeListings } from "@/lib/scraper";
import { scrapeMarketplaceMetrics, type SellerInfo } from "@/lib/marketplace-metrics";
import { computeRevenueForecast, ingestAuctions } from "@/lib/auctions";
import { fetchSoldRange } from "@/lib/sold-export";
import { writeSoldLots, isAzureSqlConfigured } from "@/lib/azure-sql";
import { fetchNewContracts, fetchContractSummary } from "@/lib/contracts";
import { fetchSamOpportunities } from "@/lib/sam-opportunities";
import { fetchAllStateContracts } from "@/lib/state-contracts";
import { sendDailySummary } from "@/lib/email";
import { CronLogger, type SourceSummary } from "@/lib/cron-log";

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
  const runStateContracts = isDailyRun || forceDaily || searchParams.get("state") === "1";

  const logger = new CronLogger();

  // Each source is a self-contained scrape + write that returns its cron_runs
  // summary alongside any payload later steps (email, response) need. Sources
  // run in parallel and are isolated: one failing is logged, not fatal.
  const listingsTask = logger.track(
    "listings",
    async () => {
      const { allsurplus, govdeals } = await scrapeListings();
      const { error } = await supabaseAdmin
        .from("listings")
        .upsert({ date, timestamp, allsurplus, govdeals }, { onConflict: "date" });
      return { allsurplus, govdeals, error: error?.message ?? null };
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
  // marketplace_sellers, which powers the Government Sellers widget (Contracts).
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
        const { error } = await supabaseAdmin
          .from("marketplace_sellers")
          .upsert(sellerRows, { onConflict: "date,platform,account_id" });
        sellersError = error?.message ?? null;
        sellersStored = error ? 0 : sellerRows.length;
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
      // Bound the whole capture so a cold/paused serverless DB (or a slow Maestro
      // pull) can't push the shared 60s cron past maxDuration and get the function
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

  const federalTask = logger.track(
    "federal_contracts",
    async () => {
      const newContracts = await fetchNewContracts(99999);
      const contractSummary = await fetchContractSummary(newContracts).catch(() => null);
      let stored = 0;
      if (newContracts.length > 0) {
        const { error } = await supabaseAdmin
          .from("federal_contracts")
          .upsert(newContracts.map((c) => ({ ...c, first_seen_date: date })), {
            onConflict: "award_id",
            ignoreDuplicates: true,
          });
        stored = error ? 0 : newContracts.length;
      }
      let snapshot = false;
      if (contractSummary) {
        const { error } = await supabaseAdmin.from("contract_snapshots").upsert(
          {
            date,
            total_active_contracts: contractSummary.total_active_contracts,
            total_obligated_amount: contractSummary.total_obligated_amount,
            new_contracts_last_30d: contractSummary.new_contracts_last_30d,
            new_obligation_last_30d: contractSummary.new_obligation_last_30d,
            top_agencies: contractSummary.top_agencies,
          },
          { onConflict: "date" },
        );
        snapshot = !error;
      }
      return { fetched: newContracts.length, stored, snapshot };
    },
    (r): SourceSummary => ({
      status: "success",
      rows: r.stored,
      detail: { fetched: r.fetched, snapshot: r.snapshot },
    }),
  );

  // SAM.gov: a single fetch fires ~10 requests (probe + brand-title + NAICS
  // searches). SAM personal API keys have a small DAILY quota, so running every
  // 4h (~60 req/day) throttles the key (HTTP 429) and stores nothing — the main
  // reason sam_opportunities stayed empty. Opportunities change slowly, so run
  // SAM once per day (the noon ET run, matching the email) unless forced.
  const runSam = isDailyRun || forceDaily || searchParams.get("sam") === "1";
  const samTask = logger.track(
    "sam",
    async () => {
      if (!runSam) {
        return {
          stored: 0,
          debug: "skipped: SAM runs once/day (noon ET) to stay within the API daily quota",
          error: null,
          skipped: true,
        };
      }
      const samResult = await fetchSamOpportunities(90);
      let stored = 0;
      let error: string | null = null;
      if (samResult.opportunities.length > 0) {
        const { error: e } = await supabaseAdmin
          .from("sam_opportunities")
          .upsert(samResult.opportunities.map((o) => ({ ...o, first_seen_date: date })), {
            onConflict: "notice_id",
            ignoreDuplicates: true,
          });
        error = e?.message ?? null;
        stored = e ? 0 : samResult.opportunities.length;
      }
      return { stored, debug: samResult.debug, error, skipped: false };
    },
    (r): SourceSummary => ({
      status: r.skipped ? "skipped" : r.error ? "failed" : "success",
      rows: r.stored,
      detail: { debug: r.debug },
      error: r.error,
    }),
  );

  const stateTask = logger.track(
    "state_contracts",
    async () => {
      if (!runStateContracts) {
        return { stored: 0, perState: {}, error: null, skipped: true };
      }
      const stateResult = await fetchAllStateContracts();
      let stored = 0;
      let error: string | null = null;
      if (stateResult.contracts.length > 0) {
        // Cost-aware merge: insert new rows and update existing rows only when a
        // business field changes. Source freshness comes from cron_runs, avoiding
        // a new PostgreSQL row version for every unchanged contract.
        const rows = stateResult.contracts.map(({ raw_data, ...contract }) => {
          void raw_data;
          return { ...contract, first_seen_date: date, last_seen_date: date };
        });
        const rpc = await supabaseAdmin.rpc("upsert_state_contracts_cost_aware", { p_rows: rows });
        if (!rpc.error) {
          stored = Number(rpc.data ?? 0);
        } else {
          // Rolling-deploy fallback until migration 027 is installed.
          const fallback = await supabaseAdmin.from("state_contracts").upsert(rows, {
            onConflict:
              "state_code,source_dataset_id,contract_id,vendor_normalized,year,quarter,customer_agency,record_type",
            ignoreDuplicates: false,
          });
          error = fallback.error?.message ?? null;
          stored = fallback.error ? 0 : rows.length;
        }
      }
      return { stored, perState: stateResult.perState, error, skipped: false };
    },
    (r): SourceSummary => ({
      status: r.skipped ? "skipped" : r.error ? "failed" : "success",
      rows: r.stored,
      detail: { perState: r.perState },
      error: r.error,
    }),
  );

  const [listingResult] = await Promise.all([
    listingsTask,
    metricsTask,
    auctionsTask,
    soldCaptureTask,
    federalTask,
    samTask,
    stateTask,
  ]);

  // Materialize the current forecast while Azure SQL is already awake. Normal
  // dashboard views then read one small Supabase row instead of waking SQL.
  await logger.track(
    "forecast_snapshot",
    async () => {
      if (!runSoldCapture) return { skipped: true, stored: 0, error: null as string | null };
      try {
        const payload = await computeRevenueForecast(1);
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

  // Email on the DST-safe daily run. ?sendEmail=1 forces.
  const forceEmail = searchParams.get("sendEmail") === "1";
  const skipEmail = searchParams.get("sendEmail") === "0";
  const shouldEmail = !skipEmail && (forceEmail || isDailyRun);
  let emailResult: { success: boolean; error?: string; chartIncluded?: boolean; chartDebug?: string } = {
    success: false,
    error: shouldEmail ? "skipped" : "skipped: not noon ET run",
  };
  if (shouldEmail && process.env.RESEND_API_KEY && listingResult) {
    emailResult = await sendDailySummary({
      date,
      timestamp,
      allsurplus: listingResult.allsurplus,
      govdeals: listingResult.govdeals,
    });
    logger.push("email", emailResult.success ? "success" : "failed", null, { chartIncluded: emailResult.chartIncluded }, emailResult.error ?? null);
  } else {
    logger.push("email", "skipped", null, null, emailResult.error ?? null);
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
