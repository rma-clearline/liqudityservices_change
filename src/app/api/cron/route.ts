import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { scrapeListings } from "@/lib/scraper";
import { scrapeMarketplaceMetrics, type SellerInfo } from "@/lib/marketplace-metrics";
import { ingestAuctions } from "@/lib/auctions";
import { fetchSoldRange } from "@/lib/sold-export";
import { writeSoldLots, isAzureSqlConfigured } from "@/lib/azure-sql";
import { fetchNewContracts, fetchContractSummary } from "@/lib/contracts";
import { fetchSamOpportunities } from "@/lib/sam-opportunities";
import { fetchAllStateContracts } from "@/lib/state-contracts";
import { sendDailySummary } from "@/lib/email";
import { CronLogger, type SourceSummary } from "@/lib/cron-log";

export const maxDuration = 60;
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
    () => ingestAuctions(),
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
  const runSam =
    now.getHours() === 12 || searchParams.get("sam") === "1" || searchParams.get("sendEmail") === "1";
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
      const stateResult = await fetchAllStateContracts();
      let stored = 0;
      let error: string | null = null;
      if (stateResult.contracts.length > 0) {
        // Merge (not ignore-duplicates): state datasets refresh sales/amounts on
        // existing contracts every quarter, so we MUST update matched rows rather
        // than drop them. `last_seen_date` advances every run (drives freshness);
        // `first_seen_date` is preserved on update by a DB trigger (migration 023).
        const { error: e } = await supabaseAdmin
          .from("state_contracts")
          .upsert(
            stateResult.contracts.map((c) => ({ ...c, first_seen_date: date, last_seen_date: date })),
            {
              onConflict:
                "state_code,source_dataset_id,contract_id,vendor_normalized,year,quarter,customer_agency,record_type",
              ignoreDuplicates: false,
            },
          );
        error = e?.message ?? null;
        stored = e ? 0 : stateResult.contracts.length;
      }
      return { stored, perState: stateResult.perState, error };
    },
    (r): SourceSummary => ({
      status: r.error ? "failed" : "success",
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

  // Email — only on the noon ET run (cron fires every 4h). ?sendEmail=1 forces.
  const forceEmail = searchParams.get("sendEmail") === "1";
  const skipEmail = searchParams.get("sendEmail") === "0";
  const isNoonRun = now.getHours() === 12;
  const shouldEmail = !skipEmail && (forceEmail || isNoonRun);
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
