import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { scrapeListings } from "@/lib/scraper";
import { scrapeMarketplaceMetrics } from "@/lib/marketplace-metrics";
import { ingestAuctions } from "@/lib/auctions";
import { fetchNewContracts, fetchContractSummary } from "@/lib/contracts";
import { fetchSamOpportunities } from "@/lib/sam-opportunities";
import { fetchAllStateContracts } from "@/lib/state-contracts";
import { sendDailySummary } from "@/lib/email";

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
  const valid =
    authToken === cronSecret ||
    (querySecret !== null && querySecret === cronSecret);
  if (!valid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" }),
  );
  const date = now.toISOString().slice(0, 10);
  const timestamp = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  // Run all scrapes in parallel
  const [listingResult, metricsResult, auctionsResult, newContracts, samResult, stateResult] = await Promise.all([
    scrapeListings(),
    scrapeMarketplaceMetrics().catch(() => null),
    ingestAuctions().catch((e) => ({ error: e instanceof Error ? e.message : String(e) })),
    fetchNewContracts(99999).catch(() => [] as Awaited<ReturnType<typeof fetchNewContracts>>),
    fetchSamOpportunities(90).catch((e) => ({ opportunities: [], debug: `error: ${e instanceof Error ? e.message : String(e)}` })),
    fetchAllStateContracts().catch((e) => ({ contracts: [], perState: { _error: { count: 0, error: e instanceof Error ? e.message : String(e) } } })),
  ]);

  const { allsurplus, govdeals } = listingResult;

  // Build summary from already-fetched contracts (avoids redundant API calls)
  const contractSummary = await fetchContractSummary(newContracts).catch(() => null);

  // 1. Store listing counts (one row per date; later runs overwrite)
  const { error: dbError } = await supabase
    .from("listings")
    .upsert({ date, timestamp, allsurplus, govdeals }, { onConflict: "date" });

  // 2. Store marketplace metrics + sellers
  let metricsDb: Record<string, unknown> = { success: false, error: "skipped" };
  if (metricsResult) {
    const { debug: adDebug, sellers: adSellers, ...adData } = metricsResult.allsurplus;
    const { debug: gdDebug, sellers: gdSellers, ...gdData } = metricsResult.govdeals;
    const rows = [
      { date, timestamp, ...adData },
      { date, timestamp, ...gdData },
    ];
    const { error } = await supabase
      .from("marketplace_metrics")
      .upsert(rows, { onConflict: "date,platform" });

    // Store seller snapshots
    const toRow = (s: typeof adSellers[number], plat: "AD" | "GD") => {
      const { top_bid_amount, ...rest } = s;
      void top_bid_amount;
      return { date, platform: plat, ...rest };
    };
    const sellerRows = [
      ...adSellers.map((s) => toRow(s, "AD")),
      ...gdSellers.map((s) => toRow(s, "GD")),
    ];
    let sellersStored = 0;
    if (sellerRows.length > 0) {
      const { error: sellerErr } = await supabase
        .from("marketplace_sellers")
        .upsert(sellerRows, { onConflict: "date,platform,account_id" });
      sellersStored = sellerErr ? 0 : sellerRows.length;
    }

    metricsDb = {
      success: !error,
      error: error?.message ?? "",
      adDebug,
      gdDebug,
      adSample: metricsResult.allsurplus.sample_size,
      gdSample: metricsResult.govdeals.sample_size,
      sellersStored,
    };
  }

  // 3. Store new contracts (upsert to avoid duplicates)
  const contractsDb: Record<string, unknown> = { newContracts: 0, snapshot: false, contractsFetched: newContracts.length };
  if (newContracts.length > 0) {
    const contractRows = newContracts.map((c) => ({
      ...c,
      first_seen_date: date,
    }));
    const { error } = await supabase
      .from("federal_contracts")
      .upsert(contractRows, { onConflict: "award_id", ignoreDuplicates: true });
    contractsDb.newContracts = error ? 0 : newContracts.length;
  }

  // 4. Store contract snapshot (one per date; later runs overwrite)
  if (contractSummary) {
    const { error } = await supabase.from("contract_snapshots").upsert(
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
    contractsDb.snapshot = !error;
  }

  // 5. Store SAM.gov opportunities
  let samDb: Record<string, unknown> = { stored: 0, debug: samResult.debug };
  if (samResult.opportunities.length > 0) {
    const samRows = samResult.opportunities.map((o) => ({ ...o, first_seen_date: date }));
    const { error } = await supabase
      .from("sam_opportunities")
      .upsert(samRows, { onConflict: "notice_id", ignoreDuplicates: true });
    samDb = { stored: error ? 0 : samRows.length, debug: samResult.debug, error: error?.message ?? null };
  }

  // 6. Store state contracts
  let stateDb: Record<string, unknown> = { stored: 0, perState: stateResult.perState };
  if (stateResult.contracts.length > 0) {
    const stateRows = stateResult.contracts.map((c) => ({ ...c, first_seen_date: date }));
    const { error } = await supabase
      .from("state_contracts")
      .upsert(stateRows, {
        onConflict: "state_code,source_dataset_id,contract_id,vendor_normalized,year,quarter,customer_agency",
        ignoreDuplicates: true,
      });
    stateDb = { stored: error ? 0 : stateRows.length, perState: stateResult.perState, error: error?.message ?? null };
  }

  // 7. Send email — only on the noon ET run (cron fires every 4h at 00/04/08/12/16/20 UTC;
  // 16 UTC = noon ET during DST, 17 UTC = noon ET during EST, so hour 16 is the closest
  // scheduled slot to local noon year-round). Pass ?sendEmail=1 to override for manual runs.
  const forceEmail = searchParams.get("sendEmail") === "1";
  const skipEmail = searchParams.get("sendEmail") === "0";
  const isNoonRun = now.getHours() === 12;
  const shouldEmail = !skipEmail && (forceEmail || isNoonRun);
  let emailResult: { success: boolean; error?: string; chartIncluded?: boolean; chartDebug?: string } = {
    success: false,
    error: shouldEmail ? "skipped" : "skipped: not noon ET run",
  };
  if (shouldEmail && process.env.RESEND_API_KEY) {
    emailResult = await sendDailySummary({ date, timestamp, allsurplus, govdeals });
  }

  return NextResponse.json({
    date,
    timestamp,
    allsurplus,
    govdeals,
    db: dbError ? { error: dbError.message } : { success: true },
    metrics: metricsDb,
    auctions: auctionsResult,
    contracts: contractsDb,
    sam: samDb,
    stateContracts: stateDb,
    email: emailResult,
  });
}
