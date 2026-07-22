import { Resend } from "resend";
import { supabase } from "./supabase";
import type { ListingRow } from "./supabase";
import { downsample, MAX_CHART_LABELS, renderChartPng } from "./chart-utils";

function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

type EmailParams = {
  date: string;
  timestamp: string;
  allsurplus: number | null;
  govdeals: number | null;
};

function fmtNum(n: number | null) {
  return n != null ? n.toLocaleString("en-US") : "N/A";
}

export async function generateChartImage(rows: ListingRow[]): Promise<{ image: string | null; debug?: string }> {
  const withData = rows.filter((r) => r.allsurplus != null || r.govdeals != null);
  if (withData.length === 0) return { image: null, debug: "no data rows" };

  const chronological = [...withData].reverse();

  // Cutoff: last 1 year shown on chart; earlier rows are used only for Y/Y lookup.
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const displayCutoff = oneYearAgo.toISOString().slice(0, 10);

  // Build date → row map for Y/Y lookup (take latest row per date).
  const byDate = new Map<string, ListingRow>();
  for (const r of chronological) byDate.set(r.date, r);

  const priorYearValue = (dateStr: string, key: "allsurplus" | "govdeals"): number | null => {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return null;
    d.setFullYear(d.getFullYear() - 1);
    // Search a ±7-day window around the prior-year date for the nearest available value.
    for (let offset = 0; offset <= 7; offset++) {
      for (const sign of [0, -1, 1]) {
        if (offset === 0 && sign !== 0) continue;
        const probe = new Date(d);
        probe.setDate(probe.getDate() + sign * offset);
        const key2 = probe.toISOString().slice(0, 10);
        const row = byDate.get(key2);
        const v = row?.[key];
        if (v != null) return v;
      }
    }
    return null;
  };

  const displayed = chronological.filter((r) => r.date >= displayCutoff);
  if (displayed.length === 0) return { image: null, debug: "no rows in display window" };

  // QuickChart free tier allows max 250 labels — downsample if needed
  const sampled = downsample(displayed, MAX_CHART_LABELS);

  const labels = sampled.map((r) => r.date);
  const asData = sampled.map((r) => (r.allsurplus != null ? r.allsurplus : null));
  const gdData = sampled.map((r) => (r.govdeals != null ? r.govdeals : null));

  const pctChange = (curr: number | null, prev: number | null): number | null => {
    if (curr == null || prev == null || prev === 0) return null;
    return ((curr - prev) / prev) * 100;
  };

  const asYoy = sampled.map((r) => pctChange(r.allsurplus, priorYearValue(r.date, "allsurplus")));
  const gdYoy = sampled.map((r) => pctChange(r.govdeals, priorYearValue(r.date, "govdeals")));
  const hasYoy = asYoy.some((v) => v != null) || gdYoy.some((v) => v != null);

  const datasets: Record<string, unknown>[] = [
    {
      label: "AllSurplus",
      data: asData,
      borderColor: "#2563eb",
      borderWidth: 2,
      pointRadius: 0,
      fill: false,
      spanGaps: true,
      yAxisID: "y-count",
    },
    {
      label: "GovDeals",
      data: gdData,
      borderColor: "#16a34a",
      borderWidth: 2,
      pointRadius: 0,
      fill: false,
      spanGaps: true,
      yAxisID: "y-count",
    },
  ];

  if (hasYoy) {
    datasets.push(
      {
        label: "AllSurplus Y/Y %",
        data: asYoy,
        borderColor: "#2563eb",
        borderDash: [6, 4],
        borderWidth: 1.5,
        pointRadius: 0,
        fill: false,
        spanGaps: true,
        yAxisID: "y-yoy",
      },
      {
        label: "GovDeals Y/Y %",
        data: gdYoy,
        borderColor: "#16a34a",
        borderDash: [6, 4],
        borderWidth: 1.5,
        pointRadius: 0,
        fill: false,
        spanGaps: true,
        yAxisID: "y-yoy",
      },
    );
  }

  const chartConfig = {
    type: "line",
    data: { labels, datasets },
    options: {
      title: { display: true, text: "LQDT Active Listings (1 Year) — solid: count, dashed: Y/Y %" },
      scales: {
        xAxes: [{ ticks: { maxTicksLimit: 12, fontSize: 10 } }],
        yAxes: [
          {
            id: "y-count",
            position: "left",
            ticks: { beginAtZero: false },
            scaleLabel: { display: true, labelString: "Active Listings" },
          },
          {
            id: "y-yoy",
            position: "right",
            scaleLabel: { display: true, labelString: "Y/Y Growth (%)" },
            gridLines: { drawOnChartArea: false },
          },
        ],
      },
      legend: { position: "bottom" },
    },
  };

  return renderChartPng(chartConfig, { width: 800, height: 400 });
}

export async function sendDailySummary({ date, timestamp, allsurplus, govdeals }: EmailParams) {
  const to = process.env.NOTIFICATION_EMAIL;
  if (!to) return { success: false, error: "NOTIFICATION_EMAIL not set" };

  // Fetch 2 years: the most-recent 1 year is displayed, the earlier year
  // powers the Y/Y growth comparison line.
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const chartCutoff = twoYearsAgo.toISOString().slice(0, 10);

  const { data: allRows } = await supabase
    .from("listings")
    .select("*")
    .gte("date", chartCutoff)
    .order("date", { ascending: false })
    .order("timestamp", { ascending: false });

  const chartResult = await generateChartImage(allRows ?? []);

  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const tableCutoff = oneYearAgo.toISOString().slice(0, 10);
  const rows = (allRows ?? []).filter((r) => r.date >= tableCutoff);

  const attachments: { filename: string; content: string; content_type: string; contentId: string }[] = [];
  let chartHtml = "";
  if (chartResult.image) {
    attachments.push({
      filename: "chart.png",
      content: chartResult.image,
      content_type: "image/png",
      contentId: "chart_img",
    });
    chartHtml = `<img src="cid:chart_img" style="width:100%;max-width:800px;margin:16px 0;" alt="Listings Chart" />`;
  }

  const tableRows = (rows ?? [])
    .map(
      (r) =>
        `<tr>
          <td style="padding:3px 10px 3px 0;border-bottom:1px solid #eee;">${r.date}</td>
          <td style="padding:3px 10px 3px 0;border-bottom:1px solid #eee;text-align:right;">${fmtNum(r.allsurplus)}</td>
          <td style="padding:3px 0;border-bottom:1px solid #eee;text-align:right;">${fmtNum(r.govdeals)}</td>
        </tr>`,
    )
    .join("");

  const { error } = await getResend().emails.send({
    from: process.env.RESEND_FROM_EMAIL || "LQDT Tracker <notifications@resend.dev>",
    to: to.split(",").map((e) => e.trim()),
    subject: `LQDT Listings Snapshot — ${date}`,
    attachments,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:800px;">
        <h2 style="margin-bottom:4px;">LQDT Listings Snapshot</h2>
        <p style="color:#666;margin-top:0;">${date} ${timestamp} ET</p>
        <table style="margin-bottom:20px;">
          <tr>
            <td style="padding-right:24px;"><strong>AllSurplus:</strong> ${fmtNum(allsurplus)} active listings</td>
            <td><strong>GovDeals:</strong> ${fmtNum(govdeals)} active listings</td>
          </tr>
        </table>
        ${chartHtml}
        <h3 style="margin-top:24px;">1-Year History</h3>
        <table style="border-collapse:collapse;font-size:13px;">
          <tr style="border-bottom:2px solid #333;">
            <th style="padding:4px 10px 4px 0;text-align:left;">Date</th>
            <th style="padding:4px 10px 4px 0;text-align:right;">AllSurplus</th>
            <th style="padding:4px 0;text-align:right;">GovDeals</th>
          </tr>
          ${tableRows}
        </table>
      </div>
    `,
  });

  return error
    ? { success: false, error: error.message, chartIncluded: !!chartResult.image, chartDebug: chartResult.debug }
    : { success: true, chartIncluded: !!chartResult.image, chartDebug: chartResult.debug };
}
