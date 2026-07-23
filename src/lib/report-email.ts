// Automated LQDT report email — fired by the cron on the midday + evening runs
// (see app/api/cron/route.ts). Supersedes the old listings-only "snapshot":
// headline QTD tiles, a server-rendered QTD cumulative chart, segment +
// earnings-preview tables, and the listings chart.
//
// Everything is computed server-side in Node from the same loaders the forecast
// route uses (no HTTP hop): the QTD math via the pure qtd-compute / qtd-model-
// compute modules, charts via QuickChart (chart-utils.renderChartPng → inline
// CID PNG), transport via Resend. Charts degrade to text if QuickChart fails;
// the email still sends. Send is skipped when there are no recipients.

import { Resend } from "resend";
import { computeRevenueForecast } from "@/lib/auctions";
import { getSoldDailyByBucket, isAzureSqlConfigured } from "@/lib/azure-sql";
import { renderChartPng } from "@/lib/chart-utils";
import { getListings } from "@/lib/dashboard-data";
import { generateChartImage } from "@/lib/email";
import { buildModel, buildQuarterView, computeQtdHeadline, type QtdData, type QtdHeadline } from "@/lib/qtd-compute";
import { computeQtdModelData, type ListingsDay } from "@/lib/qtd-model-compute";
import { fmtM, fmtPct } from "@/lib/qtd-shared";
import { supabaseAdmin } from "@/lib/supabase";
import { addDaysKey } from "@/lib/qtd-shared";
import { etQuarterKey, formatQuarterLabel } from "@/lib/time";

function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

/** Dashboard base URL for the report's links (no trailing slash). */
const APP_URL = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "https://lqdt.clearlineflow.com").replace(/\/+$/, "");

/** Headline snapshot persisted in the cron_runs email row so the NEXT report can
 *  show "since last report" deltas. Kept tiny + stable. */
export type HeadlineSnapshot = { fqe: number; qtdScaled: number; yoy: number | null; dataThrough: string };

/** Most recent successful scheduled report's headline (for "since last report"),
 *  read from the cron_runs email log. Previews don't write, so this only ever
 *  reflects the last real send. Null on the first report / any read failure. */
async function loadPreviousReportHeadline(): Promise<HeadlineSnapshot | null> {
  // Optional manual baseline (JSON): seeds the first report's deltas before any
  // prior send exists, and lets the deltas be tested where cron_runs isn't
  // reachable. Ignored once real sends log their own headline.
  const override = process.env.REPORT_PREV_HEADLINE;
  if (override) {
    try {
      const h = JSON.parse(override);
      if (h && typeof h.fqe === "number") return h as HeadlineSnapshot;
    } catch {
      // malformed override → fall through to the log
    }
  }
  try {
    const { data } = await supabaseAdmin
      .from("cron_runs")
      .select("detail, started_at")
      .eq("source", "email")
      .eq("status", "success")
      .order("started_at", { ascending: false })
      .limit(10);
    for (const row of data ?? []) {
      const hl = (row.detail as { headline?: HeadlineSnapshot } | null)?.headline;
      if (hl && typeof hl.fqe === "number") return hl;
    }
  } catch {
    // best-effort — no deltas if the log is unreadable
  }
  return null;
}

type ReportData = {
  headline: QtdHeadline | null;
  sections: ReturnType<typeof computeQtdModelData> | null;
  reported: number | null; // current-quarter reported total (once reported)
  listings: ListingsDay[];
  latest: { allsurplus: number | null; govdeals: number | null; date: string | null };
  /** Change vs the previous scheduled report (null on the first send). */
  sinceLast: { fqePct: number | null; yoyPp: number | null; prevDataThrough: string } | null;
  /** Days between the data-through date and "today" (freshness guardrail). */
  daysBehind: number | null;
  /** Current headline, returned so the cron can log it for next time's deltas. */
  snapshot: HeadlineSnapshot | null;
};

async function loadReportData(todayKey: string): Promise<ReportData> {
  const currentQuarter = etQuarterKey(todayKey);
  // Full-history forecast (quarter="ALL") — the QTD math needs prior-year daily
  // and the last reported quarters (for the auto capture rate), so the current-
  // quarter forecast snapshot is NOT enough. Matches what the /qtd page fetches.
  const base = await computeRevenueForecast(1, "ALL");

  const [reportedGmv, estimates, metrics, listingRows] = await Promise.all([
    import("@/lib/reported-gmv").then((m) => m.loadReportedQuarterlyGmv()),
    import("@/lib/reported-gmv").then((m) => m.loadModelEstimatesMerged()),
    import("@/lib/reported-gmv").then((m) => m.loadModelMetrics()),
    getListings().catch(() => [] as Awaited<ReturnType<typeof getListings>>),
  ]);

  let buckets: Awaited<ReturnType<typeof getSoldDailyByBucket>> | undefined;
  if (isAzureSqlConfigured()) {
    try {
      buckets = await getSoldDailyByBucket(base.earliest_data_date, todayKey);
    } catch {
      // store slow/unreachable → segment/txn tables degrade to unavailable
    }
  }

  const qtdData: QtdData = {
    daily: base.daily.map((d) => ({
      date: d.date,
      realized_gmv_usd: d.realized_gmv_usd,
      ad_realized_gmv_usd: d.ad_realized_gmv_usd,
      gd_realized_gmv_usd: d.gd_realized_gmv_usd,
      gi_realized_gmv_usd: d.gi_realized_gmv_usd,
    })),
    earliest_data_date: base.earliest_data_date,
    reported_gmv_by_quarter: reportedGmv,
    model_estimates_by_quarter: estimates,
  };

  const headline = computeQtdHeadline(qtdData, { todayKey });
  const model = buildModel(qtdData, todayKey, currentQuarter);
  const viewNow = model ? buildQuarterView(model, currentQuarter) : null;
  const listings: ListingsDay[] = listingRows.map((r) => ({
    date: r.date,
    allsurplus: Number(r.allsurplus ?? 0),
    govdeals: Number(r.govdeals ?? 0),
  }));

  let sections: ReturnType<typeof computeQtdModelData> | null = null;
  if (model) {
    sections = computeQtdModelData({
      metricsRows: metrics,
      bucketDaily: buckets,
      selected: currentQuarter,
      currentQuarter,
      estimates: model.estimates,
      siteByDate: model.siteByDate,
      viewNow,
      captureRate: headline?.captureRate ?? model.autoCapture,
      listings,
    });
  }

  // "Since last report" deltas + freshness, both keyed off the current headline.
  const prev = await loadPreviousReportHeadline();
  let sinceLast: ReportData["sinceLast"] = null;
  let snapshot: HeadlineSnapshot | null = null;
  let daysBehind: number | null = null;
  if (headline) {
    snapshot = { fqe: headline.scaledFqe, qtdScaled: headline.qtdScaled, yoy: headline.yoyDisplay, dataThrough: headline.dataThrough };
    if (prev) {
      sinceLast = {
        fqePct: prev.fqe > 0 ? headline.scaledFqe / prev.fqe - 1 : null,
        yoyPp: headline.yoyDisplay != null && prev.yoy != null ? headline.yoyDisplay - prev.yoy : null,
        prevDataThrough: prev.dataThrough,
      };
    }
    // Days from data-through to today (ET), counting calendar days.
    let n = 0;
    for (let k = headline.dataThrough; k < todayKey && n < 60; k = addDaysKey(k, 1)) n++;
    daysBehind = n;
  }

  const latestListing = listingRows[0] ?? null;
  return {
    headline,
    sections,
    reported: model?.reported.get(currentQuarter) ?? null,
    listings,
    latest: {
      allsurplus: latestListing?.allsurplus ?? null,
      govdeals: latestListing?.govdeals ?? null,
      date: latestListing?.date ?? null,
    },
    sinceLast,
    daysBehind,
    snapshot,
  };
}

// --- QTD cumulative chart (QuickChart Chart.js v2) --------------------------
function buildQtdChartConfig(h: QtdHeadline) {
  const labels = h.series.map((p) => p.date.slice(5)); // MM-DD
  const flat = (v: number | null) => (v == null ? null : labels.map(() => v));
  const line = (label: string, data: (number | null)[], color: string, opts: Record<string, unknown> = {}) => ({
    label,
    data,
    borderColor: color,
    borderWidth: 2,
    pointRadius: 0,
    fill: false,
    spanGaps: true,
    ...opts,
  });

  const datasets: Record<string, unknown>[] = [
    line("Current (scaled)", h.series.map((p) => p.current), "#2563eb", { borderWidth: 2.5 }),
    line("Last year", h.series.map((p) => p.lastYear), "#9ca3af", { borderWidth: 1.5 }),
  ];
  if (h.series.some((p) => p.shape != null)) {
    datasets.push(line("Prior-yr shape → FQE", h.series.map((p) => p.shape), "#7c3aed", { borderWidth: 1.5, borderDash: [6, 3] }));
  }
  if (h.guidanceLow != null) datasets.push(line(`Guidance low ${fmtM(h.guidanceLow)}`, flat(h.guidanceLow)!, "#15803d", { borderWidth: 1, borderDash: [4, 3] }));
  if (h.guidanceHigh != null) datasets.push(line(`Guidance high ${fmtM(h.guidanceHigh)}`, flat(h.guidanceHigh)!, "#15803d", { borderWidth: 1, borderDash: [4, 3] }));
  if (h.clearline != null) datasets.push(line(`Clearline ${fmtM(h.clearline)}`, flat(h.clearline)!, "#d97706", { borderWidth: 1.5, borderDash: [5, 3] }));

  return {
    type: "line",
    data: { labels, datasets },
    options: {
      title: {
        display: true,
        text: `QTD ${formatQuarterLabel(h.currentQuarter)} — cumulative GMV, scaled to total co. (through ${h.dataThrough}, day ${h.d}/${h.D})`,
      },
      scales: {
        xAxes: [{ ticks: { maxTicksLimit: 13, fontSize: 10 } }],
        yAxes: [{ ticks: { beginAtZero: true }, scaleLabel: { display: true, labelString: "Cumulative GMV (USD)" } }],
      },
      legend: { position: "bottom", labels: { fontSize: 10 } },
    },
  };
}

// --- QTD cumulative Y/Y chart (shown ABOVE the dollar chart) ----------------
function buildQtdYoyChartConfig(h: QtdHeadline) {
  const labels = h.series.map((p) => p.date.slice(5)); // MM-DD
  const datasets: Record<string, unknown>[] = [
    {
      label: "Cumulative Y/Y",
      data: h.series.map((p) => (p.yoy == null ? null : p.yoy * 100)),
      borderColor: "#2563eb",
      borderWidth: 2.5,
      pointRadius: 0,
      fill: false,
      spanGaps: true,
    },
    {
      // Zero reference line.
      label: "0%",
      data: labels.map(() => 0),
      borderColor: "#9ca3af",
      borderWidth: 1,
      borderDash: [3, 3],
      pointRadius: 0,
      fill: false,
    },
  ];
  return {
    type: "line",
    data: { labels, datasets },
    options: {
      title: {
        display: true,
        text: `QTD ${formatQuarterLabel(h.currentQuarter)} — cumulative Y/Y % (through ${h.dataThrough}, day ${h.d}/${h.D})`,
      },
      scales: {
        xAxes: [{ ticks: { maxTicksLimit: 13, fontSize: 10 } }],
        yAxes: [{ scaleLabel: { display: true, labelString: "Cumulative Y/Y (%)" } }],
      },
      legend: { position: "bottom", labels: { fontSize: 10 } },
    },
  };
}

// --- HTML helpers -----------------------------------------------------------
const FONT = "font-family:'Segoe UI',system-ui,Arial,sans-serif;";
const chgColor = (v: number | null | undefined) => (v == null ? "#6b7280" : v >= 0 ? "#15803d" : "#b91c1c");
const chg = (v: number | null | undefined) => (v == null ? "—" : `<span style="color:${chgColor(v)}">${fmtPct(v)}</span>`);

function tile(label: string, value: string, sub?: string) {
  return `<td style="padding:6px;vertical-align:top;">
    <div style="border:1px solid #e2e2e2;border-radius:8px;padding:10px 12px;">
      <div style="font-size:11px;color:#6b7280;margin-bottom:2px;">${label}</div>
      <div style="font-size:18px;font-weight:700;color:#111;">${value}</div>
      ${sub ? `<div style="font-size:11px;color:#6b7280;margin-top:2px;">${sub}</div>` : ""}
    </div>
  </td>`;
}

function tilesGrid(cells: string[]): string {
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += 3) {
    rows.push(`<tr>${cells.slice(i, i + 3).join("")}</tr>`);
  }
  return `<table style="width:100%;border-collapse:collapse;table-layout:fixed;">${rows.join("")}</table>`;
}

function buildHtml(d: ReportData, dateLabel: string, timeLabel: string, chartCids: { qtdYoy?: string; qtd?: string; listings?: string }): string {
  const h = d.headline;
  const tiles: string[] = [];
  if (h) {
    const vsMid = h.scaledFqe != null && h.guidanceMid ? h.scaledFqe / h.guidanceMid - 1 : null;
    const vsCl = h.scaledFqe != null && h.clearline ? h.scaledFqe / h.clearline - 1 : null;
    tiles.push(tile("QTD GMV (scaled)", fmtM(h.qtdScaled), `captured ${fmtM(h.qtdCaptured)} · day ${h.d}/${h.D}`));
    tiles.push(tile("QTD Y/Y", h.yoyDisplay != null ? `<span style="color:${chgColor(h.yoyDisplay)}">${fmtPct(h.yoyDisplay)}</span>` : "—", "vs LY reported, prorated"));
    tiles.push(
      tile(
        `FQ estimate (scaled)`,
        fmtM(h.scaledFqe),
        [
          h.guidanceMid != null ? `vs guide mid ${chg(vsMid)}` : null,
          h.clearline != null ? `vs Clearline ${chg(vsCl)}` : null,
        ].filter(Boolean).join(" · ") || h.primaryMethod,
      ),
    );
    tiles.push(tile("T7D Y/Y", h.t7dYoy != null ? `<span style="color:${chgColor(h.t7dYoy)}">${fmtPct(h.t7dYoy)}</span>` : "—", "trailing 7 days vs 52 wks ago"));
    tiles.push(tile("Capture rate", `${(h.captureRate * 100).toFixed(1)}%`, "scraped ÷ reported, last 3 qtrs"));
  }

  // Segment mini-table
  let segmentTable = "";
  if (d.sections?.hasGroups && d.sections.segments.length) {
    const rows = d.sections.segments
      .map(
        (s) => `<tr>
        <td style="padding:3px 8px;border-bottom:1px solid #eee;">${s.name} <span style="color:#9ca3af;">(vs ${s.vs})</span></td>
        <td style="padding:3px 8px;border-bottom:1px solid #eee;text-align:right;">${fmtM(s.qtdGmv)}</td>
        <td style="padding:3px 8px;border-bottom:1px solid #eee;text-align:right;">${chg(s.yoy)}</td>
        <td style="padding:3px 8px;border-bottom:1px solid #eee;text-align:right;">${s.capture ? (s.capture.rate * 100).toFixed(0) + "%" : "—"}</td>
        <td style="padding:3px 8px;border-bottom:1px solid #eee;text-align:right;">${s.impliedTotal != null ? fmtM(s.impliedTotal) : "—"}</td>
      </tr>`,
      )
      .join("");
    segmentTable = `<h3 style="margin:20px 0 6px;font-size:14px;">Segment GMV (QTD, scraped axes)</h3>
      <table style="border-collapse:collapse;font-size:12px;width:100%;">
        <tr style="text-align:left;border-bottom:2px solid #333;">
          <th style="padding:4px 8px;">Segment</th><th style="padding:4px 8px;text-align:right;">QTD GMV</th>
          <th style="padding:4px 8px;text-align:right;">Y/Y</th><th style="padding:4px 8px;text-align:right;">Capture</th>
          <th style="padding:4px 8px;text-align:right;">Implied total</th>
        </tr>${rows}
      </table>`;
  }

  // GMV vs guidance / Clearline (GMV row only — the report is GMV-focused).
  let previewTable = "";
  const gmvRow = d.sections?.preview.rows.find((r) => r.label === "GMV");
  if (gmvRow && (gmvRow.guidanceLow != null || gmvRow.model != null || gmvRow.ours != null)) {
    const r = gmvRow;
    previewTable = `<h3 style="margin:20px 0 6px;font-size:14px;">Full-quarter GMV — guidance vs Clearline vs ours (${formatQuarterLabel(d.headline?.currentQuarter ?? "")})</h3>
      <table style="border-collapse:collapse;font-size:12px;width:100%;">
        <tr style="text-align:left;border-bottom:2px solid #333;">
          <th style="padding:4px 8px;">Guidance</th><th style="padding:4px 8px;text-align:right;">Clearline model</th>
          <th style="padding:4px 8px;text-align:right;">Ours (scaled FQE)</th><th style="padding:4px 8px;text-align:right;">vs mid</th>
        </tr>
        <tr>
          <td style="padding:3px 8px;">${r.guidanceLow != null && r.guidanceHigh != null ? `${fmtM(r.guidanceLow)}–${fmtM(r.guidanceHigh)}` : "—"}</td>
          <td style="padding:3px 8px;text-align:right;">${r.model != null ? fmtM(r.model) : "—"}</td>
          <td style="padding:3px 8px;text-align:right;font-weight:600;">${r.ours != null ? fmtM(r.ours) : "—"}</td>
          <td style="padding:3px 8px;text-align:right;">${chg(r.vsMid)}</td>
        </tr>
      </table>`;
  }

  // Freshness + "since last report" provenance.
  const stale = d.daysBehind != null && d.daysBehind >= 2;
  const freshness = h
    ? `data through ${h.dataThrough}${d.daysBehind != null ? ` <span style="color:${stale ? "#b91c1c" : "#6b7280"}">(${d.daysBehind === 0 ? "today" : d.daysBehind + "d ago"}${stale ? " — stale?" : ""})</span>` : ""}`
    : "";
  let sinceLine = "";
  if (d.sinceLast && (d.sinceLast.fqePct != null || d.sinceLast.yoyPp != null)) {
    const parts: string[] = [];
    if (d.sinceLast.fqePct != null) parts.push(`FQE ${chg(d.sinceLast.fqePct)}`);
    if (d.sinceLast.yoyPp != null)
      parts.push(`QTD Y/Y <span style="color:${chgColor(d.sinceLast.yoyPp)}">${d.sinceLast.yoyPp >= 0 ? "+" : ""}${(d.sinceLast.yoyPp * 100).toFixed(1)}pp</span>`);
    sinceLine = `<p style="font-size:12px;color:#6b7280;margin:8px 0 0;">Since last report (${d.sinceLast.prevDataThrough}): ${parts.join(" · ")}</p>`;
  }

  const qtdYoyImg = chartCids.qtdYoy ? `<img src="cid:${chartCids.qtdYoy}" style="width:100%;max-width:720px;margin:12px 0;" alt="QTD cumulative Y/Y chart" />` : "";
  const qtdImg = chartCids.qtd ? `<img src="cid:${chartCids.qtd}" style="width:100%;max-width:720px;margin:12px 0;" alt="QTD GMV chart" />` : "";
  const listingsImg = chartCids.listings ? `<img src="cid:${chartCids.listings}" style="width:100%;max-width:720px;margin:12px 0;" alt="Listings chart" />` : "";

  const button = `<a href="${APP_URL}/qtd" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:8px 14px;border-radius:6px;">View full dashboard →</a>`;

  return `<div style="${FONT}max-width:720px;color:#111;">
    <table style="width:100%;border-collapse:collapse;"><tr>
      <td style="vertical-align:top;">
        <h2 style="margin:0 0 2px;">LQDT Report</h2>
        <p style="color:#6b7280;margin:0;font-size:13px;">${dateLabel} ${timeLabel} ET${freshness ? ` · ${freshness}` : ""}</p>
      </td>
      <td style="vertical-align:top;text-align:right;white-space:nowrap;">${button}</td>
    </tr></table>
    ${qtdYoyImg}
    ${tiles.length ? `<div style="margin:12px 0 0;">${tilesGrid(tiles)}</div>` : ""}
    ${sinceLine}
    ${qtdImg}
    ${segmentTable}
    ${previewTable}
    <h3 style="margin:22px 0 6px;font-size:14px;">Active listings</h3>
    <p style="font-size:13px;margin:0 0 4px;"><strong>AllSurplus:</strong> ${d.latest.allsurplus?.toLocaleString("en-US") ?? "N/A"} &nbsp;·&nbsp; <strong>GovDeals:</strong> ${d.latest.govdeals?.toLocaleString("en-US") ?? "N/A"}</p>
    ${listingsImg}
    <p style="color:#9ca3af;font-size:11px;margin-top:24px;border-top:1px solid #eee;padding-top:8px;">
      Full detail &amp; interactivity: <a href="${APP_URL}/qtd" style="color:#2563eb;">QTD</a> ·
      <a href="${APP_URL}/forecast" style="color:#2563eb;">Forecast</a> ·
      <a href="${APP_URL}/contracts" style="color:#2563eb;">Contracts</a>.<br/>
      QTD scaled to total company at the capture rate; FQ estimate = prior-year-shape projection. Segment axes (gov/retail/intl)
      are scrape groupings, not LQDT's reported segments. Automated by the LQDT tracker.
    </p>
  </div>`;
}

export type ReportEmailResult = {
  success: boolean;
  error?: string;
  recipients?: number;
  charts?: { qtdYoy: boolean; qtd: boolean; listings: boolean };
  debug?: { qtdYoy?: string; qtd?: string; listings?: string };
  /** Current headline — the cron logs this in the email row so the NEXT report
   *  can show "since last report" deltas. */
  headline?: HeadlineSnapshot | null;
};

/**
 * Build and send the report email. Recipients default to NOTIFICATION_EMAIL;
 * `toOverride` forces a single recipient (preview sends). Skips cleanly when
 * there is no API key or no recipients.
 */
export async function sendReportEmail({
  date,
  timestamp,
  toOverride,
}: {
  date: string;
  timestamp: string;
  toOverride?: string;
}): Promise<ReportEmailResult> {
  if (!process.env.RESEND_API_KEY) return { success: false, error: "RESEND_API_KEY not set" };
  const recipients = (toOverride ?? process.env.NOTIFICATION_EMAIL ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (recipients.length === 0) return { success: false, error: "no recipients" };

  const data = await loadReportData(date);

  // Charts — each independent; failure degrades to text.
  const attachments: { filename: string; content: string; content_type: string; contentId: string }[] = [];
  const chartCids: { qtdYoy?: string; qtd?: string; listings?: string } = {};
  const debug: { qtdYoy?: string; qtd?: string; listings?: string } = {};

  if (data.headline) {
    // Y/Y % chart first (rendered on top), then the cumulative-dollar chart.
    const yoy = await renderChartPng(buildQtdYoyChartConfig(data.headline), { width: 800, height: 400 });
    debug.qtdYoy = yoy.debug;
    if (yoy.image) {
      attachments.push({ filename: "qtd-yoy.png", content: yoy.image, content_type: "image/png", contentId: "chart_qtd_yoy" });
      chartCids.qtdYoy = "chart_qtd_yoy";
    }
    const qtd = await renderChartPng(buildQtdChartConfig(data.headline), { width: 800, height: 400 });
    debug.qtd = qtd.debug;
    if (qtd.image) {
      attachments.push({ filename: "qtd.png", content: qtd.image, content_type: "image/png", contentId: "chart_qtd" });
      chartCids.qtd = "chart_qtd";
    }
  }
  try {
    const listingsChart = await generateChartImage((await getListings()) as never);
    debug.listings = listingsChart.debug;
    if (listingsChart.image) {
      attachments.push({ filename: "listings.png", content: listingsChart.image, content_type: "image/png", contentId: "chart_listings" });
      chartCids.listings = "chart_listings";
    }
  } catch (e) {
    debug.listings = `error: ${e instanceof Error ? e.message : String(e)}`;
  }

  const html = buildHtml(data, date, timestamp, chartCids);
  const { error } = await getResend().emails.send({
    from: process.env.RESEND_FROM_EMAIL || "LQDT Tracker <notifications@resend.dev>",
    to: recipients,
    subject: `LQDT Report — ${date} ${timestamp} ET`,
    attachments,
    html,
  });

  const charts = { qtdYoy: !!chartCids.qtdYoy, qtd: !!chartCids.qtd, listings: !!chartCids.listings };
  return error
    ? { success: false, error: error.message, recipients: recipients.length, charts, debug, headline: data.snapshot }
    : { success: true, recipients: recipients.length, charts, debug, headline: data.snapshot };
}
