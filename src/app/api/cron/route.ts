import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { scrapeListings } from "@/lib/scraper";
import { scrapeMarketplaceMetrics, type PlatformMetrics, type SellerInfo } from "@/lib/marketplace-metrics";
import { ingestAuctions } from "@/lib/auctions";
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

  const metricsTask = logger.track(
    "marketplace_metrics",
    async () => {
      const metrics = await scrapeMarketplaceMetrics();
      const metricRow = (m: PlatformMetrics) => ({
        date,
        timestamp,
        platform: m.platform,
        total_listings: m.total_listings,
        total_bids: m.total_bids,
        avg_bids_per_listing: m.avg_bids_per_listing,
        total_current_price: m.total_current_price,
        listings_with_bids: m.listings_with_bids,
        bid_rate: m.bid_rate,
        unique_seller_count: m.unique_seller_count,
        listings_closing_24h: m.listings_closing_24h,
        avg_watch_count: m.avg_watch_count,
        listings_with_reserve: m.listings_with_reserve,
        reserve_rate: m.reserve_rate,
        top_categories: m.top_categories,
        sample_size: m.sample_size,
        pages_fetched: m.pages_fetched,
        is_full_coverage: m.is_full_coverage,
      });
      const { error: metricsError } = await supabaseAdmin
        .from("marketplace_metrics")
        .upsert([metricRow(metrics.allsurplus), metricRow(metrics.govdeals)], { onConflict: "date,platform" });

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
      if (sellerRows.length > 0) {
        const { error: sellerErr } = await supabaseAdmin
          .from("marketplace_sellers")
          .upsert(sellerRows, { onConflict: "date,platform,account_id" });
        sellersStored = sellerErr ? 0 : sellerRows.length;
      }
      return {
        metricsError: metricsError?.message ?? null,
        sellersStored,
        adSample: metrics.allsurplus.sample_size,
        gdSample: metrics.govdeals.sample_size,
        adCoverage: metrics.allsurplus.is_full_coverage,
        gdCoverage: metrics.govdeals.is_full_coverage,
      };
    },
    (r): SourceSummary => ({
      status: r.metricsError ? "failed" : "success",
      rows: (r.metricsError ? 0 : 2) + r.sellersStored,
      detail: {
        adSample: r.adSample,
        gdSample: r.gdSample,
        adCoverage: r.adCoverage,
        gdCoverage: r.gdCoverage,
        sellersStored: r.sellersStored,
      },
      error: r.metricsError,
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

  const samTask = logger.track(
    "sam",
    async () => {
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
      return { stored, debug: samResult.debug, error };
    },
    (r): SourceSummary => ({
      status: r.error ? "failed" : "success",
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
        const { error: e } = await supabaseAdmin
          .from("state_contracts")
          .upsert(stateResult.contracts.map((c) => ({ ...c, first_seen_date: date })), {
            onConflict:
              "state_code,source_dataset_id,contract_id,vendor_normalized,year,quarter,customer_agency,record_type",
            ignoreDuplicates: true,
          });
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
