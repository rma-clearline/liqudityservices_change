import { NextResponse } from "next/server";
import { scrapeListings } from "@/lib/scraper";
import { computeRevenueForecast, ingestAuctions } from "@/lib/auctions";
import { fetchSoldRange } from "@/lib/sold-export";
import {
  writeSoldLots,
  isAzureSqlConfigured,
  getDistinctSellersForFees,
  getSellerFeesFresh,
  upsertSellerFees,
  refreshFeeAnalytics,
  refreshSoldSupersession,
  type SellerFeeRow,
} from "@/lib/azure-sql";
import { fetchBidbox } from "@/lib/asset-fees";
import { etQuarterKey } from "@/lib/time";
import { quarterDayKeys } from "@/lib/qtd-shared";
import { sendReportEmail, type ReportEmailResult } from "@/lib/report-email";
import { CronLogger, type SourceSummary } from "@/lib/cron-log";
import {
  azUpsertListing,
  azUpsertForecastSnapshot,
  azRunRetention,
  azClaimReportSend,
  azReleaseReportSend,
} from "@/lib/azure-tables";

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
      try {
        await azUpsertListing({ date, timestamp, allsurplus, govdeals });
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
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

  // Set when the capture times out: resolves true once the ABANDONED write (and its
  // supersession re-mark) actually lands. Everything downstream reads sold_lots, so it
  // must wait for this rather than compute on pre-capture data — see the wait below.
  let lateCaptureWrite: Promise<boolean> | null = null;

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
      const work = (async () => {
        const fetched = await fetchSoldRange(from, to, { maxPages: 400 });
        // A truncated fetch still writes its (real) rows but must not claim day
        // coverage — storeCoversRange would serve the undercount as complete.
        const { written } = await writeSoldLots(fetched.rows, { markCoverage: !fetched.truncated });
        return { written, from, to, truncated: fetched.truncated, skipped: false, error: null as string | null };
      })();
      try {
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("sold_lots capture timeout")), timeoutMs)),
        ]);
      } catch (e) {
        // The race rejects on timeout but does NOT cancel the fetch+write, which keeps
        // running on this long-lived container and can MERGE fresh relist rows AFTER
        // the supersession refresh below — leaving both attempts counted in
        // SOLD_CURRENT until the next capture run. Chain a follow-up refresh onto the
        // abandoned write so a late landing re-marks immediately.
        lateCaptureWrite = work
          .then(async () => {
            const s = await refreshSoldSupersession();
            console.log(`[cron] sold supersession (late capture write): ${s.changed} row(s) re-marked in ${s.ms}ms`);
            return true;
          })
          .catch(() => false);
        void lateCaptureWrite;
        return { written: 0, from, to, truncated: false, skipped: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    (r): SourceSummary => ({
      status: r.skipped ? "skipped" : r.error ? "failed" : r.truncated ? "partial" : "success",
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
  // NOT started here: this fans out 8 concurrent Maestro bidbox fetches for up to 30s,
  // and Maestro is a shared, finite resource. Run inside the parallel group it starved
  // the other Maestro consumers — sold_lots would blow its capture budget whenever this
  // had a backlog to price (noon), which is what made the noon/5pm reports go stale.
  // Invoked AFTER the report instead; the Take Rate page it feeds tolerates a lag of one
  // run. Same lesson as a585b4b (fee ANALYTICS starving the pool) applied to the FETCH.
  const runSellerFeeTask = () => logger.track(
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

  const [listingResult, , soldCaptureResult] = await Promise.all([
    listingsTask,
    auctionsTask,
    soldCaptureTask,
  ]);

  // The capture's timeout rejects the TASK but does not cancel its write, which keeps
  // running on this long-lived container and lands minutes later. Everything below reads
  // sold_lots — the supersession re-mark, the forecast snapshot, and the report email —
  // so proceeding immediately computes on PRE-capture data. That is exactly how the
  // 2026-08-03 noon and 5pm reports came out identical ($170.55M both): the 21:00 capture
  // timed out at 45s, its write landed at 21:05, and the email had already computed.
  // Wait (bounded) for the abandoned write so the report reflects this run's own capture.
  let lateCaptureLanded = false;
  if (soldCaptureResult?.error && lateCaptureWrite) {
    const waitMs = Number(process.env.SOLD_CAPTURE_LATE_WAIT_MS) || 300_000;
    const t0 = Date.now();
    lateCaptureLanded = await Promise.race([
      lateCaptureWrite,
      new Promise<boolean>((r) => setTimeout(() => r(false), waitMs)),
    ]);
    console.log(
      `[cron] late sold-capture write ${lateCaptureLanded ? "landed" : "did NOT land"} after ${Math.round((Date.now() - t0) / 1000)}s`,
    );
  }

  // A relisted asset resells under a new auctionId, and row_key is keyed by auction, so
  // the failed attempt would keep counting as GMV alongside the completed sale. Re-mark
  // superseded rows now that this run's lots are in: ~10s and idempotent, but it MUST run
  // after the sold capture and before the forecast snapshot below, because it is what
  // keeps SOLD_CURRENT (the deduped read surface in azure-sql.ts that every aggregation
  // goes through) in step with what was just ingested.
  let supersessionOk = true;
  if (runSoldCapture && isAzureSqlConfigured()) {
    try {
      const s = await refreshSoldSupersession();
      console.log(`[cron] sold supersession: ${s.changed} row(s) re-marked in ${s.ms}ms`);
    } catch (e) {
      supersessionOk = false;
      console.error("[cron] sold supersession failed:", e instanceof Error ? e.message : String(e));
    }
  }

  // Materialize the current forecast while Azure SQL is already awake. Normal
  // dashboard views then read one small Supabase row instead of waking SQL.
  await logger.track(
    "forecast_snapshot",
    async () => {
      if (!runSoldCapture) return { skipped: true, stored: 0, error: null as string | null };
      if (!supersessionOk) {
        // A failed refresh means SOLD_CURRENT may still hold both attempts of a relist
        // just ingested; persisting now would freeze that double count into the snapshot
        // the dashboard serves. Keep the previous snapshot until a refresh succeeds.
        return { skipped: false, stored: 0, error: "skipped: supersession refresh failed — snapshot would carry relist double-counts" };
      }
      // Same reasoning for a timed-out capture: the race rejected but the write is still
      // in flight (see the capture task above), so rows can land — unmarked, or as a
      // half-merged day — while this computes. The chained refresh repairs SOLD_CURRENT
      // for live readers, but a snapshot written mid-flight would freeze the bad number
      // for hours, since /api/forecast prefers the stored snapshot. Skip this run —
      // UNLESS the wait above confirmed the abandoned write (and its supersession
      // re-mark) already landed, in which case nothing is in flight and the read is
      // complete. Without that exemption a timed-out capture skipped the snapshot on
      // every noon run, leaving /api/forecast on the previous day's snapshot.
      if (soldCaptureResult?.error && !lateCaptureLanded) {
        return { skipped: false, stored: 0, error: `skipped: sold capture did not complete (${soldCaptureResult.error}) — snapshot could freeze an in-flight write` };
      }
      try {
        const payload = await computeRevenueForecast(1);
        await azUpsertForecastSnapshot(payload.quarter, payload);
        return { skipped: false, stored: 1, error: null };
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
  // cannot contend with the writers above (azRunRetention: cron_runs >90d,
  // closed auctions >120d).
  await logger.track(
    "retention",
    async () => {
      if (!isDailyRun && !forceDaily && searchParams.get("retention") !== "1") {
        return { skipped: true, deleted: 0, error: null as string | null };
      }
      try {
        const c = await azRunRetention();
        return { skipped: false, deleted: c.cron_runs + c.auctions, error: null as string | null };
      } catch (e) {
        return { skipped: false, deleted: 0, error: e instanceof Error ? e.message : String(e) };
      }
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
  // Which once-a-day slot this send belongs to. The ledger claim below makes the
  // slot idempotent: ANY extra invocation that reaches this step (a manual
  // ?sold=1 refresh, a job retry, or a second fire overlapping a slow run) is a
  // no-op instead of a second mail to the whole recipient list. ?sendEmail=1 is
  // an explicit human "send one now", so it bypasses the claim by design.
  const slot = isDailyRun ? "noon" : "evening";
  let emailResult: ReportEmailResult = {
    success: false,
    error: shouldEmail ? "skipped" : "skipped: not a report-hour run",
  };
  if (shouldEmail && process.env.RESEND_API_KEY) {
    const claimed = forceEmail || (await azClaimReportSend(date, slot, logger.runId));
    if (!claimed) {
      emailResult = { success: false, error: `skipped: ${slot} report already sent today` };
      logger.push("email", "skipped", null, null, emailResult.error ?? null);
    } else {
      emailResult = await sendReportEmail({ date, timestamp });
      // A failed send must not burn the slot — release it so a later run retries.
      if (!emailResult.success && !forceEmail) await azReleaseReportSend(date, slot);
      // Persist the headline in the email row so the NEXT report can diff against it.
      logger.push("email", emailResult.success ? "success" : "failed", null, { charts: emailResult.charts, headline: emailResult.headline ?? null, slot }, emailResult.error ?? null);
    }
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
  // Seller-fee backfill runs HERE — after the capture, snapshot and report email — so its
  // 8-way Maestro fan-out can no longer starve them (see runSellerFeeTask above). Awaited
  // before the analytics refresh below so that refresh sees the fees this run just wrote.
  await runSellerFeeTask();

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
