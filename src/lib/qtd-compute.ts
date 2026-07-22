// Pure QTD compute — the cumulative-progress math extracted from
// components/qtd-progress.tsx so it runs in Node (the cron report email) as the
// single source of truth. No React/DOM. The client page imports buildModel +
// buildQuarterView from here; the email additionally uses computeQtdHeadline.

import { enumerateQuarterLabelsBetween, etQuarterKey } from "@/lib/time";
import { addDaysKey, cumulate, priorYearQuarter, quarterDayKeys } from "@/lib/qtd-shared";

export type QtdDailyPoint = {
  date: string;
  realized_gmv_usd: number;
  ad_realized_gmv_usd?: number;
  gd_realized_gmv_usd?: number;
  gi_realized_gmv_usd?: number;
};

export type QtdEstimate = {
  quarter: string;
  guidance_low_usd: number | null;
  guidance_high_usd: number | null;
  clearline_estimate_usd: number | null;
  source?: "model" | "manual";
  updated_by?: string | null;
  updated_at?: string | null;
};

export type QtdData = {
  daily: QtdDailyPoint[];
  earliest_data_date: string;
  reported_gmv_by_quarter?: { quarter: string; reported_gmv_usd: number }[];
  model_estimates_by_quarter?: QtdEstimate[];
};

export type ProjectionKey = "shape" | "runrate";

export const PROJECTION_LABEL: Record<ProjectionKey, string> = {
  shape: "Prior-yr shape",
  runrate: "Run rate",
};

export const FALLBACK_CAPTURE = 0.535;

export type QtdModel = {
  realizedByDate: Map<string, number>;
  siteByDate: Map<string, { ad: number; gd: number; gi: number }>;
  lastDataDate: string;
  earliest: string;
  quarters: string[];
  reported: Map<string, number>;
  estimates: Map<string, QtdEstimate>;
  autoCapture: number;
  captureQuarters: { quarter: string; rate: number }[];
};

/** Build the per-quarter-independent model (daily maps, reported/estimate maps,
 *  auto capture rate) from the forecast ALL payload. `todayKey` is the ET day. */
export function buildModel(data: QtdData, todayKey: string, currentQuarter: string): QtdModel | null {
  if (!data) return null;

  const realizedByDate = new Map<string, number>();
  const siteByDate = new Map<string, { ad: number; gd: number; gi: number }>();
  let lastDataDate = "";
  for (const d of data.daily) {
    realizedByDate.set(d.date, d.realized_gmv_usd);
    siteByDate.set(d.date, {
      ad: d.ad_realized_gmv_usd ?? 0,
      gd: d.gd_realized_gmv_usd ?? 0,
      gi: d.gi_realized_gmv_usd ?? 0,
    });
    if (d.realized_gmv_usd > 0 && d.date > lastDataDate && d.date <= todayKey) lastDataDate = d.date;
  }
  const earliest = data.earliest_data_date || data.daily[0]?.date || todayKey;
  const quarters = enumerateQuarterLabelsBetween(etQuarterKey(earliest), currentQuarter).reverse(); // newest first

  const reported = new Map((data.reported_gmv_by_quarter ?? []).map((r) => [r.quarter, r.reported_gmv_usd]));
  const estimates = new Map((data.model_estimates_by_quarter ?? []).map((e) => [e.quarter, e]));

  // Auto capture rate: mean scraped÷reported over the last 3 reported quarters
  // whose window is fully covered by daily data.
  const captures: { quarter: string; rate: number }[] = [];
  for (const [q, rep] of [...reported.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const keys = quarterDayKeys(q);
    if (keys.length === 0 || keys[0] < earliest || keys[keys.length - 1] > lastDataDate) continue;
    const scrapedSum = keys.reduce((s, k) => s + (realizedByDate.get(k) ?? 0), 0);
    if (scrapedSum > 0 && rep > 0) captures.push({ quarter: q, rate: scrapedSum / rep });
  }
  const recent = captures.slice(-3);
  const autoCapture = recent.length ? recent.reduce((s, c) => s + c.rate, 0) / recent.length : FALLBACK_CAPTURE;

  return { realizedByDate, siteByDate, lastDataDate, earliest, quarters, reported, estimates, autoCapture, captureQuarters: recent };
}

/** Everything the page derives for one quarter (cumulatives, Y/Y, projections,
 *  FQE, WoW). Pure so it can run for both the selected quarter (the chart) and
 *  the current quarter (the earnings-preview section, pinned to "now"). */
export function buildQuarterView(model: QtdModel, selected: string) {
  const { realizedByDate, lastDataDate } = model;

  const dayKeys = quarterDayKeys(selected);
  if (dayKeys.length === 0) return null;
  const D = dayKeys.length;
  const startKey = dayKeys[0];
  const endKey = dayKeys[D - 1];
  const dataThrough = lastDataDate < endKey ? lastDataDate : endKey;
  // Days into period with data (0 if the quarter hasn't started/no data).
  const d = dayKeys.filter((k) => k <= dataThrough).length;
  if (d === 0) return null;
  const complete = d === D;

  const curCum = cumulate(dayKeys, realizedByDate);
  const qtd = curCum[d - 1];

  // Prior-year same fiscal quarter, aligned by day index.
  const lyKeys = quarterDayKeys(priorYearQuarter(selected));
  const lyAvailable =
    lyKeys.length > 0 && lyKeys[0] >= model.earliest && lyKeys[lyKeys.length - 1] <= lastDataDate;
  const lyCum = lyAvailable ? cumulate(lyKeys, realizedByDate) : null;
  const lyD = lyCum?.length ?? 0;
  const lyAt = (i: number) => (lyCum ? lyCum[Math.min(i, lyD - 1)] : 0);
  const lyQtd = lyCum ? lyAt(d - 1) : null;
  const yoy = lyQtd && lyQtd > 0 ? qtd / lyQtd - 1 : null;

  // LY REPORTED GMV prorated to day i using LY's captured daily shape — the
  // denominator for the reported-anchored Y/Y shown in Scaled mode. Using
  // lyCum's true final value (not lyAt(D-1)) makes lyReportedAt(D-1) equal
  // lyReported exactly even when the quarters' day counts differ.
  const lyReported = model.reported.get(priorYearQuarter(selected)) ?? null;
  const lyCapturedTotal = lyCum ? lyCum[lyCum.length - 1] : 0;
  const lyReportedAt =
    lyReported != null && lyReported > 0 && lyCum != null && lyCapturedTotal > 0
      ? (i: number) => lyReported * (lyAt(i) / lyCapturedTotal)
      : null;

  // Projections (captured units). Anchor every path at day d so the dashed
  // lines extend the solid QTD line.
  const shapeAvailable = !complete && lyCum != null && lyAt(d - 1) > 0;
  const shapeAt = (i: number) => qtd + (lyAt(i) - lyAt(d - 1)) * (qtd / lyAt(d - 1));
  const runRateAt = (i: number) => (qtd / d) * (i + 1);

  const fqe = {
    shape: shapeAvailable ? shapeAt(D - 1) : null,
    runrate: !complete ? runRateAt(D - 1) : null,
    actual: complete ? qtd : null,
  };
  // Primary FQE: prior-yr shape, else run-rate.
  const primaryFqe = fqe.actual ?? fqe.shape ?? fqe.runrate ?? qtd;
  const primaryMethod = fqe.actual != null ? "complete quarter" : fqe.shape != null ? PROJECTION_LABEL.shape : PROJECTION_LABEL.runrate;

  // "What changed in the last week": same primary method, data as of 7 days earlier.
  let wow: number | null = null;
  if (!complete && d > 8) {
    const d7 = d - 7;
    const qtd7 = curCum[d7 - 1];
    let prevFqe: number | null = null;
    if (shapeAvailable && lyAt(d7 - 1) > 0) prevFqe = (qtd7 / lyAt(d7 - 1)) * lyAt(D - 1);
    else if (qtd7 > 0) prevFqe = (qtd7 / d7) * D;
    const nowFqe = fqe.shape ?? fqe.runrate;
    if (prevFqe && prevFqe > 0 && nowFqe) wow = nowFqe / prevFqe - 1;
  }

  return {
    dayKeys, D, d, startKey, endKey, dataThrough, complete,
    curCum, qtd, lyCum, lyAt, lyQtd, yoy, lyAvailable, lyReported, lyReportedAt,
    shapeAvailable, shapeAt, runRateAt,
    fqe, primaryFqe, primaryMethod, wow,
    reported: model.reported.get(selected) ?? null,
    estimate: model.estimates.get(selected) ?? null,
  };
}

export type QuarterView = NonNullable<ReturnType<typeof buildQuarterView>>;

export type QtdHeadline = {
  currentQuarter: string;
  dataThrough: string;
  d: number;
  D: number;
  captureRate: number;
  qtdCaptured: number;
  qtdScaled: number;
  yoyDisplay: number | null; // reported-anchored scaled Y/Y (or captured-vs-captured fallback)
  scaledFqe: number;
  primaryMethod: string;
  guidanceLow: number | null;
  guidanceHigh: number | null;
  guidanceMid: number | null;
  clearline: number | null;
  t7dYoy: number | null;
  /** Day-of-quarter chart series for the email QTD charts. `current`/`lastYear`/
   *  `shape` are SCALED $ (dollar chart); `yoy` is the implied cumulative Y/Y
   *  fraction (Y/Y chart), in-data days only. */
  series: {
    day: number;
    date: string;
    current: number | null;
    lastYear: number | null;
    shape: number | null; // prior-yr-shape projection (dashed), anchored at day d
    yoy: number | null;
  }[];
};

/**
 * Node-facing headline compute for the report email. Builds the model, pins to
 * the current quarter, applies scaled-to-total basis at the auto capture rate
 * (or an override %), and returns the headline numbers + the scaled cumulative
 * chart series. Mirrors the page's Scaled-mode math exactly. Returns null when
 * there is no in-quarter data yet.
 */
export function computeQtdHeadline(
  data: QtdData,
  opts: { todayKey?: string; captureOverridePct?: number } = {},
): QtdHeadline | null {
  const todayKey = opts.todayKey ?? new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const currentQuarter = etQuarterKey(todayKey);
  const model = buildModel(data, todayKey, currentQuarter);
  if (!model) return null;
  const view = buildQuarterView(model, currentQuarter);
  if (!view) return null;

  const override = opts.captureOverridePct;
  const captureRate =
    override != null && Number.isFinite(override) && override > 0 && override <= 100 ? override / 100 : model.autoCapture;
  const scale = 1 / captureRate;

  // Reported-anchored scaled Y/Y (matches the page's Scaled-mode card + chart).
  const lyRepAt = view.lyReportedAt;
  const reportedAnchor = lyRepAt != null && lyRepAt(view.d - 1) > 0;
  const lyRepQtd = reportedAnchor && lyRepAt ? lyRepAt(view.d - 1) : null;
  const yoyDisplay = lyRepQtd != null ? (view.qtd * scale) / lyRepQtd - 1 : view.yoy;

  const est = view.estimate;
  const guidanceLow = est?.guidance_low_usd ?? null;
  const guidanceHigh = est?.guidance_high_usd ?? null;
  const guidanceMid = guidanceLow && guidanceHigh ? (guidanceLow + guidanceHigh) / 2 : null;

  // T7D Y/Y (52-week, weekday-aligned) through the latest data day.
  const realized = model.realizedByDate;
  const sumRange = (from: string, to: string) => {
    let s = 0;
    for (let k = from; k <= to; k = addDaysKey(k, 1)) s += realized.get(k) ?? 0;
    return s;
  };
  const t7dEnd = model.lastDataDate;
  const t7dStart = addDaysKey(t7dEnd, -6);
  let t7dYoy: number | null = null;
  if (t7dStart >= model.earliest) {
    const cur = sumRange(t7dStart, t7dEnd);
    const lyStart = addDaysKey(t7dStart, -364);
    if (lyStart >= model.earliest) {
      const ly = sumRange(lyStart, addDaysKey(t7dEnd, -364));
      t7dYoy = ly > 0 ? cur / ly - 1 : null;
    }
  }

  // Implied cumulative Y/Y at day i (matches the page's Y/Y mode): reported-
  // anchored when available (scaled cum ÷ LY-reported-prorated-to-day − 1), else
  // captured-vs-captured (scale cancels).
  const impliedYoy = (raw: number, i: number): number | null => {
    if (reportedAnchor && lyRepAt) {
      const dn = lyRepAt(i);
      return dn > 0 ? (raw * scale) / dn - 1 : null;
    }
    const lv = view.lyAt(i);
    return view.lyCum && lv > 0 ? raw / lv - 1 : null;
  };

  const series = view.dayKeys.map((date, i) => {
    const inData = i < view.d;
    const lyVal = view.lyCum ? view.lyAt(i) : null;
    const anchor = i === view.d - 1;
    return {
      day: i + 1,
      date,
      current: inData ? view.curCum[i] * scale : null,
      lastYear: reportedAnchor && lyRepAt ? lyRepAt(i) : lyVal != null ? lyVal * scale : null,
      shape: view.shapeAvailable && (anchor || i >= view.d) ? view.shapeAt(i) * scale : null,
      yoy: inData ? impliedYoy(view.curCum[i], i) : null,
    };
  });

  return {
    currentQuarter,
    dataThrough: view.dataThrough,
    d: view.d,
    D: view.D,
    captureRate,
    qtdCaptured: view.qtd,
    qtdScaled: view.qtd * scale,
    yoyDisplay,
    scaledFqe: view.primaryFqe * scale,
    primaryMethod: view.primaryMethod,
    guidanceLow,
    guidanceHigh,
    guidanceMid,
    clearline: est?.clearline_estimate_usd ?? null,
    t7dYoy,
    series,
  };
}
