"use client";

// Model-driven QTD sections (below the headline chart/tables):
//   A. Segment GMV  — scraped gov/retail/intl split vs reported GovDeals/RSCG/CAG
//   B. Earnings preview — scaled FQE × model take rate vs guidance/consensus
//   C. Transactions & ASP — captured lots vs reported completed transactions
//   D. Supply & demand — active listings productivity + bid intensity
//
// Inputs: the forecast payload's `model_metrics` (long-format workbook export) and
// `sold_by_group_daily` (per-day gov/retail/intl gmv/lots/bids), both optional —
// each section degrades independently — plus the parent's /api/listings fetch.
//
// All math lives in the pure `computeQtdModelData` so the page's CSV export can
// emit exactly the numbers the sections render.
//
// The gov/retail/intl groups are honest scrape axes, NOT LQDT's segments: GD-site
// retail sellers mix RSCG and CAG, so each group carries its OWN capture rate vs
// the closest reported segment(s) and is never scaled by the headline rate.

import { useMemo, type ReactNode } from "react";
import { fitTakeRates, type FitObservation } from "@/lib/take-rate-fit";
import { enumerateQuarterLabelsBetween, etQuarterKey, formatQuarterLabel } from "@/lib/time";
import { fmtM, fmtPct, MetricsTable, priorYearQuarter, quarterDayKeys, StatCard, type MCol } from "./qtd-shared";

type Group = "gov" | "retail" | "intl";
export type SoldBucketName = "gov_veh" | "gov_other" | "ret_veh" | "ret_other" | "heavy" | "intl" | "ad_dtc";
export type ModelMetricRow = { quarter: string; metric: string; value: number; kind: "reported" | "forecast" };
export type BucketDailyRow = { date: string; bucket: SoldBucketName; gmv: number; lots: number; bids: number };
export type ListingsDay = { date: string; allsurplus: number; govdeals: number };

const BUCKETS: SoldBucketName[] = ["gov_veh", "gov_other", "ret_veh", "ret_other", "heavy", "intl", "ad_dtc"];
const BUCKET_LABEL: Record<SoldBucketName, string> = {
  gov_veh: "Gov vehicles & equip",
  gov_other: "Gov other",
  ret_veh: "Retail vehicles",
  ret_other: "Retail other",
  heavy: "Retail heavy equip",
  intl: "International (GI)",
  ad_dtc: "AllSurplus DTC",
};
// The gov/retail/intl group axes are derived by summing buckets. (Trace AD-site
// government sellers — ~$0.02M/qtr — now count as retail via ad_dtc.)
const BUCKET_TO_GROUP: Record<SoldBucketName, Group> = {
  gov_veh: "gov",
  gov_other: "gov",
  ret_veh: "retail",
  ret_other: "retail",
  heavy: "retail",
  intl: "intl",
  ad_dtc: "retail",
};

type Estimate = {
  quarter: string;
  guidance_low_usd: number | null;
  guidance_high_usd: number | null;
  clearline_estimate_usd: number | null;
};

type ViewNow = {
  qtd: number;
  d: number;
  D: number;
  complete: boolean;
  primaryFqe: number;
  primaryMethod: string;
} | null;

const SEGMENTS: { key: Group; name: string; sub: string; reportedMetrics: string[]; vs: string }[] = [
  { key: "gov", name: "Government", sub: "gov sellers on AD/GD", reportedMetrics: ["govdeals_gmv"], vs: "GovDeals" },
  { key: "retail", name: "Retail", sub: "retail sellers on AD/GD", reportedMetrics: ["rscg_gmv", "cag_gmv"], vs: "RSCG+CAG" },
  { key: "intl", name: "International", sub: "site GI", reportedMetrics: ["cag_gmv"], vs: "CAG" },
];

const HISTORY_METRICS = [
  { metric: "govdeals_gmv", title: "GovDeals GMV (reported)" },
  { metric: "rscg_gmv", title: "RSCG GMV (reported)" },
  { metric: "cag_gmv", title: "CAG GMV (reported)" },
  { metric: "machinio_revs", title: "Machinio revenue (reported)" },
] as const;

const OPS_METRICS = [
  { metric: "completed_transactions", label: "Completed transactions" },
  { metric: "auction_participants", label: "Auction participants" },
  { metric: "registered_buyers", label: "Registered buyers" },
] as const;

export type QtdModelInput = {
  metricsRows?: ModelMetricRow[];
  bucketDaily?: BucketDailyRow[];
  selected: string;
  currentQuarter: string;
  estimates: Map<string, Estimate>;
  siteByDate: Map<string, { ad: number; gd: number; gi: number }>;
  viewNow: ViewNow;
  captureRate: number;
  listings: ListingsDay[] | "error" | null;
};

export type QtdModelData = {
  hasGroups: boolean;
  hasMetrics: boolean;
  groupFirst: string;
  groupLast: string;
  dg: number;
  totalDays: number;
  matchedDays: number | null;
  segments: {
    key: Group;
    name: string;
    sub: string;
    vs: string;
    qtdGmv: number;
    yoy: number | null;
    capture: { rate: number; n: number } | null;
    impliedTotal: number | null;
  }[];
  segmentHistory: {
    metric: string;
    title: string;
    rows: { quarter: string; basis: "reported" | "model E"; value: number; yoy: number | null }[];
  }[];
  preview: {
    rows: {
      label: string;
      kind: "usd" | "eps" | "pct";
      guidanceLow: number | null;
      guidanceHigh: number | null;
      guidanceMid: number | null;
      model: number | null;
      ours: number | null;
      vsMid: number | null;
    }[];
    takeRate: number | null;
    takeRateIsForecast: boolean;
    consensus: number | null;
    consensusDelta: number | null;
    scaledFqe: number | null;
    method: string | null;
    guidanceMid: number | null;
    impliedBeat: number | null;
    beat: { avg: number; wins: number; n: number } | null;
  };
  txns: {
    lotsQtd: number;
    lotsYoy: number | null;
    lyLotsMatched: number;
    capture: { rate: number; n: number } | null;
    fqe: number | null;
    method: string;
    modelTxn: number | null;
    modelTxnIsForecast: boolean;
    selectedComplete: boolean;
  };
  aspRows: {
    q: string;
    isQtd: boolean;
    scraped: number | null;
    scrapedYoy: number | null;
    rep: number | null;
    repE: boolean;
    repYoy: number | null;
  }[];
  ops: {
    quarters: string[];
    rows: { metric: string; label: string; cells: { q: string; value: number | null; yoy: number | null }[] }[];
  };
  listingRows:
    | {
        q: string;
        isQtd: boolean;
        as: number;
        asYoy: number | null;
        gd: number;
        gdYoy: number | null;
        gmvPerGd: number | null;
        gmvPerAs: number | null;
      }[]
    | null;
  bids: { qtd: number; perLot: number | null; perLotMatched: number | null; lyPerLot: number | null; yoy: number | null } | null;
  latestParticipants: number | null;
  /** Bucket take-rate model: θ = revenue per SCRAPED bucket dollar (capture
   *  absorbed), prior-anchored bounded fit on the reported quarters. */
  takeRateModel: {
    available: boolean;
    nQuarters: number;
    converged: boolean;
    coeffs: {
      bucket: SoldBucketName;
      label: string;
      theta: number;
      approxTake: number;
      qtdGmv: number;
      fqeGmv: number | null;
      revContribution: number | null;
    }[];
    backtest: { q: string; actual: number; predicted: number; errPct: number }[];
    mixRevenue: number | null;
    mixTakeRate: number | null;
    machinioAdd: number;
    /** Purchase-model revenue add-back (purchase_gmv × purchase_take_rate) —
     *  handled outside the fit because most purchase GMV isn't scraped. */
    purchaseAdd: number;
  } | null;
};

/** Everything the four sections (and the CSV export) derive from the payload. */
export function computeQtdModelData(input: QtdModelInput): QtdModelData {
  const { metricsRows, bucketDaily, selected, currentQuarter, estimates, siteByDate, viewNow, captureRate, listings } = input;

  // --- model metrics: metric → quarter → { reported?, forecast? } ------------
  const metrics = new Map<string, Map<string, { reported?: number; forecast?: number }>>();
  for (const r of metricsRows ?? []) {
    let byQ = metrics.get(r.metric);
    if (!byQ) metrics.set(r.metric, (byQ = new Map()));
    let cell = byQ.get(r.quarter);
    if (!cell) byQ.set(r.quarter, (cell = {}));
    if (cell[r.kind] == null) cell[r.kind] = r.value; // reported never overwritten
  }
  const mVal = (metric: string, q: string, kind?: "reported" | "forecast"): number | null => {
    const cell = metrics.get(metric)?.get(q);
    if (!cell) return null;
    return (kind ? cell[kind] : cell.reported ?? cell.forecast) ?? null;
  };
  const latestReported = (metric: string): number | null => {
    const byQ = metrics.get(metric);
    if (!byQ) return null;
    let bestQ: string | null = null;
    for (const [q, cell] of byQ) if (cell.reported != null && (!bestQ || q > bestQ)) bestQ = q;
    return bestQ != null ? byQ.get(bestQ)!.reported! : null;
  };

  // --- bucket daily series (groups derived by summing buckets) -----------------
  const bMap = new Map<SoldBucketName, Map<string, { gmv: number; lots: number; bids: number }>>();
  const gMap = new Map<Group, Map<string, { gmv: number; lots: number; bids: number }>>();
  let gFirst = "";
  let gLast = "";
  for (const r of bucketDaily ?? []) {
    let byDate = bMap.get(r.bucket);
    if (!byDate) bMap.set(r.bucket, (byDate = new Map()));
    byDate.set(r.date, { gmv: r.gmv, lots: r.lots, bids: r.bids });
    const grp = BUCKET_TO_GROUP[r.bucket] ?? "retail";
    let gByDate = gMap.get(grp);
    if (!gByDate) gMap.set(grp, (gByDate = new Map()));
    const cell = gByDate.get(r.date) ?? { gmv: 0, lots: 0, bids: 0 };
    cell.gmv += r.gmv;
    cell.lots += r.lots;
    cell.bids += r.bids;
    gByDate.set(r.date, cell);
    if (r.gmv > 0 || r.lots > 0) {
      if (!gFirst || r.date < gFirst) gFirst = r.date;
      if (r.date > gLast) gLast = r.date;
    }
  }
  const hasGroups = gFirst !== "";
  const sumG = (grp: Group | "all", keys: string[], field: "gmv" | "lots" | "bids") => {
    const list: Group[] = grp === "all" ? ["gov", "retail", "intl"] : [grp];
    let s = 0;
    for (const gg of list) {
      const byDate = gMap.get(gg);
      if (!byDate) continue;
      for (const k of keys) s += byDate.get(k)?.[field] ?? 0;
    }
    return s;
  };
  const sumB = (b: SoldBucketName, keys: string[]) => {
    const byDate = bMap.get(b);
    if (!byDate) return 0;
    let s = 0;
    for (const k of keys) s += byDate.get(k)?.gmv ?? 0;
    return s;
  };
  /** Keys of quarter `q` restricted to the group series' coverage. */
  const qKeysCovered = (q: string) => quarterDayKeys(q).filter((k) => k >= gFirst && k <= gLast);
  // Quarters (chronological) covered by the group series, tolerating ≤2 missing
  // edge days (the store starts 2025-07-02; the headline blend starts 07-01).
  const coveredQuarters = !hasGroups
    ? []
    : enumerateQuarterLabelsBetween(etQuarterKey(gFirst), etQuarterKey(gLast)).filter((q) => {
        const keys = quarterDayKeys(q);
        return keys.length > 0 && qKeysCovered(q).length >= keys.length - 2;
      });

  // Selected-quarter window on the group series (may lag the headline by ≤1 day).
  const qKeys = quarterDayKeys(selected);
  const dg = hasGroups ? qKeys.filter((k) => k <= gLast).length : 0;
  const qtdKeys = qKeys.slice(0, dg);
  const lyQKeys = quarterDayKeys(priorYearQuarter(selected));
  const selectedComplete = dg > 0 && dg >= qKeys.length;
  // Day-of-quarter–aligned Y/Y windows, restricted to day indexes whose LY date the
  // group series covers (skips the store's missing first day(s) on BOTH sides so
  // the comparison stays like-for-like). Null when <90% of the window matches.
  let matched: { cur: string[]; ly: string[] } | null = null;
  if (hasGroups && dg > 0 && lyQKeys.length > 0) {
    const cur: string[] = [];
    const ly: string[] = [];
    const n = Math.min(dg, lyQKeys.length);
    for (let i = 0; i < n; i++) {
      if (lyQKeys[i] >= gFirst && lyQKeys[i] <= gLast) {
        cur.push(qKeys[i]);
        ly.push(lyQKeys[i]);
      }
    }
    matched = cur.length > 0 && cur.length >= n * 0.9 ? { cur, ly } : null;
  }
  // Full LY quarter (coverage-restricted) for the prior-yr-shape lots projection.
  const lyFullKeys = qKeysCovered(priorYearQuarter(selected));
  const lyFullUsable = lyQKeys.length > 0 && lyFullKeys.length >= lyQKeys.length - 2;

  // --- A. segments ---------------------------------------------------------------
  const segments = SEGMENTS.map((seg) => {
    const rates: number[] = [];
    for (const q of coveredQuarters) {
      const reps = seg.reportedMetrics.map((m) => mVal(m, q, "reported"));
      if (reps.some((r) => r == null || r <= 0)) continue;
      const scraped = sumG(seg.key, qKeysCovered(q), "gmv");
      if (scraped <= 0) continue;
      rates.push(scraped / reps.reduce<number>((s, r) => s + (r ?? 0), 0));
    }
    const recent = rates.slice(-3);
    const capture = recent.length ? { rate: recent.reduce((s, x) => s + x, 0) / recent.length, n: recent.length } : null;
    const qtdGmv = sumG(seg.key, qtdKeys, "gmv");
    const lyG = matched ? sumG(seg.key, matched.ly, "gmv") : 0;
    return {
      key: seg.key,
      name: seg.name,
      sub: seg.sub,
      vs: seg.vs,
      qtdGmv,
      yoy: matched && lyG > 0 ? sumG(seg.key, matched.cur, "gmv") / lyG - 1 : null,
      capture,
      impliedTotal: capture ? qtdGmv / capture.rate : null,
    };
  });

  // Reported segment history (pinned to the latest data, like the key metrics).
  const segmentHistory = HISTORY_METRICS.map(({ metric, title }) => {
    const byQ = metrics.get(metric);
    const rows: QtdModelData["segmentHistory"][number]["rows"] = [];
    if (byQ) {
      const reportedQs = [...byQ.entries()]
        .filter(([, cell]) => cell.reported != null)
        .map(([q]) => q)
        .sort();
      for (const q of reportedQs.slice(-6)) {
        const prior = byQ.get(priorYearQuarter(q))?.reported ?? null;
        const v = byQ.get(q)!.reported!;
        rows.push({ quarter: q, basis: "reported", value: v, yoy: prior != null && prior > 0 ? v / prior - 1 : null });
      }
      const fc = byQ.get(currentQuarter)?.forecast;
      if (fc != null && !reportedQs.includes(currentQuarter)) {
        const prior = byQ.get(priorYearQuarter(currentQuarter))?.reported ?? null;
        rows.push({
          quarter: currentQuarter,
          basis: "model E",
          value: fc,
          yoy: prior != null && prior > 0 ? fc / prior - 1 : null,
        });
      }
    }
    return { metric, title, rows };
  });

  // --- take-rate model: bucket coefficients fitted on reported quarters ----------
  // θ_b = revenue per SCRAPED bucket dollar (capture absorbed — the fit needs no
  // capture assumption). PURCHASE-model revenue (LQDT recognizes the full sale
  // price, take ≈ 104%, and most purchase GMV — liquidation.com — isn't scraped)
  // is an explicit add-back from the workbook's purchase_gmv × purchase_take_rate,
  // like Machinio: folding it into coefficients produced nonsense "take rates".
  // The fit therefore explains CONSIGNMENT + fee revenue only, and ad_dtc
  // (purchase-model AllSurplus Deals) is excluded — its revenue arrives via the
  // purchase line. Ridge-anchored to economic priors so with few quarters the
  // priors dominate; data takes over as reported quarters accrue.
  let takeRateModel: QtdModelData["takeRateModel"] = null;
  {
    const purchaseRevOf = (q: string): number | null => {
      const pg = mVal("purchase_gmv", q, "reported");
      const pt = mVal("purchase_take_rate", q, "reported");
      return pg != null && pt != null ? pg * pt : null;
    };
    const fitQuarters = coveredQuarters.filter(
      (q) =>
        ["revenue", "machinio_revs", "govdeals_gmv", "govdeals_take_rate"].every((m) => mVal(m, q, "reported") != null) &&
        purchaseRevOf(q) != null,
    );
    if (hasGroups && fitQuarters.length > 0) {
      const consTake = latestReported("consignment_take_rate") ?? 0.112;
      const govTake = latestReported("govdeals_take_rate") ?? 0.1;
      const cagTake = latestReported("cag_take_rate") ?? 0.17;
      // Consignment take-rate priors per bucket. GovDeals' tiered fee schedule
      // makes high-ASP rolling stock skew below the segment average and small
      // lots above it; heavy/intl lean toward CAG's fee structure.
      const FIT_BUCKETS: SoldBucketName[] = ["gov_veh", "gov_other", "ret_veh", "ret_other", "heavy", "intl"];
      const PRIOR_TAKE: Record<string, number> = {
        gov_veh: govTake * 0.85,
        gov_other: govTake * 1.15,
        ret_veh: consTake * 1.2,
        ret_other: consTake * 1.2,
        heavy: cagTake,
        intl: cagTake,
      };
      const capOf = (b: SoldBucketName): number => {
        const cap = segments.find((s) => s.key === BUCKET_TO_GROUP[b])?.capture?.rate;
        return cap && cap > 0 ? cap : 0.5;
      };
      const priors: Record<string, number> = {};
      const bounds: Record<string, [number, number]> = {};
      for (const b of FIT_BUCKETS) {
        const theta0 = PRIOR_TAKE[b] / capOf(b);
        priors[b] = theta0;
        bounds[b] = [Math.max(0, theta0 * 0.4), Math.min(5, theta0 * 2.5)];
      }
      const GOV_BUCKETS: SoldBucketName[] = ["gov_veh", "gov_other"];
      const pick = (S: Record<string, number>, keys: SoldBucketName[]) => Object.fromEntries(keys.map((b) => [b, S[b] ?? 0]));
      const obs: FitObservation[] = [];
      for (const q of fitQuarters) {
        const keys = qKeysCovered(q);
        const S: Record<string, number> = {};
        for (const b of FIT_BUCKETS) S[b] = sumB(b, keys);
        // 1) consignment + fee revenue = total − Machinio − purchase revenue
        obs.push({
          weight: 2,
          target: mVal("revenue", q, "reported")! - mVal("machinio_revs", q, "reported")! - purchaseRevOf(q)!,
          loadings: S,
        });
        // 2) GovDeals segment revenue (essentially all consignment) ↔ gov buckets
        obs.push({
          weight: 1,
          target: mVal("govdeals_gmv", q, "reported")! * mVal("govdeals_take_rate", q, "reported")!,
          loadings: pick(S, GOV_BUCKETS),
        });
      }
      // λ=0.5: enough prior anchoring to stabilize the collinear directions (the
      // bucket mix barely moves quarter to quarter) without systematic bias.
      const fit = fitTakeRates(obs, priors, bounds, 0.5);
      // In-sample backtest on TOTAL revenue per fitted quarter (fit + add-backs).
      const backtest = fitQuarters.map((q) => {
        const keys = qKeysCovered(q);
        const predicted =
          FIT_BUCKETS.reduce((s, b) => s + fit.theta[b] * sumB(b, keys), 0) +
          purchaseRevOf(q)! +
          mVal("machinio_revs", q, "reported")!;
        const actual = mVal("revenue", q, "reported")!;
        return { q, actual, predicted, errPct: predicted / actual - 1 };
      });
      // Current-quarter mix-adjusted revenue: each bucket's QTD scaled by the
      // headline FQE ratio (mix held constant through quarter-end), × θ, plus the
      // purchase-revenue and Machinio add-backs (model forecasts, falling back to
      // the latest reported values).
      const nowKeys = quarterDayKeys(currentQuarter).filter((k) => k <= gLast);
      const scaleUp = viewNow && viewNow.qtd > 0 ? viewNow.primaryFqe / viewNow.qtd : null;
      const machinioAdd = mVal("machinio_revs", currentQuarter, "forecast") ?? latestReported("machinio_revs") ?? 0;
      const pgF = mVal("purchase_gmv", currentQuarter, "forecast");
      const ptF = mVal("purchase_take_rate", currentQuarter, "forecast") ?? latestReported("purchase_take_rate");
      const purchaseAdd = pgF != null && ptF != null ? pgF * ptF : purchaseRevOf(fitQuarters[fitQuarters.length - 1]) ?? 0;
      const coeffs = FIT_BUCKETS.map((b) => {
        const qtdGmv = sumB(b, nowKeys);
        const fqeGmv = scaleUp != null ? qtdGmv * scaleUp : null;
        return {
          bucket: b,
          label: BUCKET_LABEL[b],
          theta: fit.theta[b],
          approxTake: fit.theta[b] * capOf(b),
          qtdGmv,
          fqeGmv,
          revContribution: fqeGmv != null ? fit.theta[b] * fqeGmv : null,
        };
      });
      const mixRevenue =
        scaleUp != null ? coeffs.reduce((s, c) => s + (c.revContribution ?? 0), 0) + purchaseAdd + machinioAdd : null;
      const scaledFqeForMix = viewNow ? viewNow.primaryFqe / captureRate : null;
      takeRateModel = {
        available: true,
        nQuarters: fitQuarters.length,
        converged: fit.converged,
        coeffs,
        backtest,
        mixRevenue,
        mixTakeRate: mixRevenue != null && scaledFqeForMix != null && scaledFqeForMix > 0 ? mixRevenue / scaledFqeForMix : null,
        machinioAdd,
        purchaseAdd,
      };
    }
  }

  // --- B. earnings preview (pinned to the current quarter) ------------------------
  const nowQ = currentQuarter;
  const estNow = estimates.get(nowQ);
  const gLow = estNow?.guidance_low_usd ?? null;
  const gHigh = estNow?.guidance_high_usd ?? null;
  const gMid = gLow != null && gHigh != null ? (gLow + gHigh) / 2 : null;
  const scaledFqe = viewNow ? viewNow.primaryFqe / captureRate : null;
  const takeRateFc = mVal("total_take_rate", nowQ, "forecast");
  const takeRate = takeRateFc ?? latestReported("total_take_rate");
  const impliedRevenue = scaledFqe != null && takeRate != null ? scaledFqe * takeRate : null;
  const consensus = mVal("gmv_consensus", nowQ);

  const previewRows: QtdModelData["preview"]["rows"] = [];
  const pushPreview = (
    label: string,
    kind: "usd" | "eps" | "pct",
    low: number | null,
    high: number | null,
    model: number | null,
    ours: number | null,
  ) => {
    const mid = low != null && high != null ? (low + high) / 2 : null;
    previewRows.push({
      label,
      kind,
      guidanceLow: low,
      guidanceHigh: high,
      guidanceMid: mid,
      model,
      ours,
      vsMid: mid != null && mid > 0 && ours != null ? ours / mid - 1 : null,
    });
  };
  pushPreview("GMV", "usd", gLow, gHigh, estNow?.clearline_estimate_usd ?? null, scaledFqe);
  pushPreview(
    "Revenue",
    "usd",
    mVal("revenue_guidance_low", nowQ),
    mVal("revenue_guidance_high", nowQ),
    mVal("revenue", nowQ, "forecast"),
    impliedRevenue,
  );
  if (takeRateModel?.mixRevenue != null) {
    pushPreview(
      "Revenue (mix-adj)",
      "usd",
      mVal("revenue_guidance_low", nowQ),
      mVal("revenue_guidance_high", nowQ),
      null,
      takeRateModel.mixRevenue,
    );
  }
  pushPreview(
    "EBITDA",
    "usd",
    mVal("ebitda_guidance_low", nowQ),
    mVal("ebitda_guidance_high", nowQ),
    mVal("ebitda", nowQ, "forecast") ?? mVal("adj_ebitda", nowQ, "forecast"),
    null,
  );
  pushPreview("EPS", "eps", mVal("eps_guidance_low", nowQ), mVal("eps_guidance_high", nowQ), mVal("eps", nowQ, "forecast"), null);
  const gm = mVal("gross_margin", nowQ, "forecast");
  if (gm != null) pushPreview("Gross margin", "pct", null, null, gm, null);

  // Guidance-beat history (Beat vs Mid row, reported quarters only).
  let beat: QtdModelData["preview"]["beat"] = null;
  {
    const byQ = metrics.get("beat_vs_mid");
    if (byQ) {
      const vals = [...byQ.entries()]
        .filter(([, cell]) => cell.reported != null)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, cell]) => cell.reported!)
        .slice(-8);
      if (vals.length > 0) {
        beat = {
          avg: vals.reduce((s, v) => s + v, 0) / vals.length,
          wins: vals.filter((v) => v > 0).length,
          n: vals.length,
        };
      }
    }
  }

  // --- C. transactions & ASP -------------------------------------------------------
  const lotsQtd = sumG("all", qtdKeys, "lots");
  const lyLotsMatched = matched ? sumG("all", matched.ly, "lots") : 0;
  const lotsQtdMatched = matched ? sumG("all", matched.cur, "lots") : 0;
  const lotsYoy = matched && lyLotsMatched > 0 ? lotsQtdMatched / lyLotsMatched - 1 : null;
  const txnRates: number[] = [];
  for (const q of coveredQuarters) {
    const rep = mVal("completed_transactions", q, "reported");
    if (rep == null || rep <= 0) continue;
    const lots = sumG("all", qKeysCovered(q), "lots");
    if (lots > 0) txnRates.push(lots / rep);
  }
  const txnRecent = txnRates.slice(-3);
  const txnCapture = txnRecent.length
    ? { rate: txnRecent.reduce((s, x) => s + x, 0) / txnRecent.length, n: txnRecent.length }
    : null;

  let lotsFqe: number | null = null;
  let lotsMethod = "";
  if (dg > 0) {
    if (selectedComplete) {
      lotsFqe = lotsQtd;
      lotsMethod = "actual";
    } else if (matched && lyLotsMatched > 0 && lyFullUsable) {
      lotsFqe = (lotsQtdMatched / lyLotsMatched) * sumG("all", lyFullKeys, "lots");
      lotsMethod = "prior-yr shape";
    } else {
      lotsFqe = (lotsQtd / dg) * qKeys.length;
      lotsMethod = "run rate";
    }
  }
  const txnFqe = lotsFqe != null && txnCapture ? lotsFqe / txnCapture.rate : null;
  const modelTxn = mVal("completed_transactions", selected);
  const modelTxnIsForecast = mVal("completed_transactions", selected, "reported") == null;

  // ASP rows: last ≤5 covered quarters + the selected quarter's QTD.
  const scrapedAsp = (keys: string[]): number | null => {
    const gmv = sumG("all", keys, "gmv");
    const lots = sumG("all", keys, "lots");
    return lots > 0 ? gmv / lots : null;
  };
  const aspRows: QtdModelData["aspRows"] = [];
  for (const q of coveredQuarters.slice(-5)) {
    const cur = scrapedAsp(qKeysCovered(q));
    const lyQ = priorYearQuarter(q);
    const ly = coveredQuarters.includes(lyQ) ? scrapedAsp(qKeysCovered(lyQ)) : null;
    const rep = mVal("gmv_per_transaction", q, "reported");
    const repLy = mVal("gmv_per_transaction", lyQ, "reported");
    aspRows.push({
      q,
      isQtd: false,
      scraped: cur,
      scrapedYoy: cur != null && ly != null && ly > 0 ? cur / ly - 1 : null,
      rep,
      repE: false,
      repYoy: rep != null && repLy != null && repLy > 0 ? rep / repLy - 1 : null,
    });
  }
  if (dg > 0 && !selectedComplete) {
    const cur = scrapedAsp(qtdKeys);
    const ly = matched ? scrapedAsp(matched.ly) : null;
    const rep = mVal("gmv_per_transaction", selected);
    const repLy = mVal("gmv_per_transaction", priorYearQuarter(selected), "reported");
    aspRows.push({
      q: selected,
      isQtd: true,
      scraped: cur,
      scrapedYoy: cur != null && ly != null && ly > 0 ? cur / ly - 1 : null,
      rep,
      repE: modelTxnIsForecast,
      repYoy: rep != null && repLy != null && repLy > 0 ? rep / repLy - 1 : null,
    });
  }

  // Reported operating stats (last 4 reported quarters).
  const opsQuarters = (() => {
    const byQ = metrics.get("completed_transactions");
    if (!byQ) return [] as string[];
    return [...byQ.entries()]
      .filter(([, cell]) => cell.reported != null)
      .map(([q]) => q)
      .sort()
      .slice(-4);
  })();
  const ops = {
    quarters: opsQuarters,
    rows: OPS_METRICS.map(({ metric, label }) => ({
      metric,
      label,
      cells: opsQuarters.map((q) => {
        const value = mVal(metric, q, "reported");
        const ly = mVal(metric, priorYearQuarter(q), "reported");
        return { q, value, yoy: value != null && ly != null && ly > 0 ? value / ly - 1 : null };
      }),
    })),
  };

  // --- D. supply & demand ------------------------------------------------------------
  let listingRows: QtdModelData["listingRows"] = null;
  if (Array.isArray(listings)) {
    const byQ = new Map<string, { as: number; gd: number; n: number }>();
    for (const r of listings) {
      const q = etQuarterKey(r.date);
      const cell = byQ.get(q) ?? { as: 0, gd: 0, n: 0 };
      cell.as += r.allsurplus;
      cell.gd += r.govdeals;
      cell.n += 1;
      byQ.set(q, cell);
    }
    const avg = (q: string): { as: number; gd: number } | null => {
      const c = byQ.get(q);
      return c && c.n > 0 ? { as: c.as / c.n, gd: c.gd / c.n } : null;
    };
    // Site GMV per quarter from the forecast payload's per-site daily series.
    const siteGmv = (keys: string[]) => {
      let ad = 0, gd = 0, gi = 0;
      for (const k of keys) {
        const c = siteByDate.get(k);
        if (!c) continue;
        ad += c.ad; gd += c.gd; gi += c.gi;
      }
      return { ad, gd, gi };
    };
    const quarters = [...byQ.keys()].sort();
    const full = quarters.filter((q) => q !== currentQuarter && (byQ.get(q)?.n ?? 0) >= 60);
    listingRows = [];
    for (const q of full.slice(-6)) {
      const cur = avg(q)!;
      const ly = avg(priorYearQuarter(q));
      const keys = quarterDayKeys(q);
      // GMV/listing only when the store's site series covers the whole quarter.
      const covered = hasGroups && keys[0] >= gFirst && keys[keys.length - 1] <= gLast;
      const gmv = covered ? siteGmv(keys) : null;
      listingRows.push({
        q,
        isQtd: false,
        as: cur.as,
        asYoy: ly && ly.as > 0 ? cur.as / ly.as - 1 : null,
        gd: cur.gd,
        gdYoy: ly && ly.gd > 0 ? cur.gd / ly.gd - 1 : null,
        gmvPerGd: gmv && cur.gd > 0 ? gmv.gd / cur.gd : null,
        gmvPerAs: gmv && cur.as > 0 ? (gmv.ad + gmv.gi) / cur.as : null,
      });
    }
    const qtdAvg = avg(currentQuarter);
    if (qtdAvg) {
      const ly = avg(priorYearQuarter(currentQuarter));
      listingRows.push({
        q: currentQuarter,
        isQtd: true,
        as: qtdAvg.as,
        asYoy: ly && ly.as > 0 ? qtdAvg.as / ly.as - 1 : null,
        gd: qtdAvg.gd,
        gdYoy: ly && ly.gd > 0 ? qtdAvg.gd / ly.gd - 1 : null,
        gmvPerGd: null, // partial-quarter GMV ÷ avg listings isn't comparable to full quarters
        gmvPerAs: null,
      });
    }
  }

  const bidsQtd = sumG("all", qtdKeys, "bids");
  const lyBids = matched ? sumG("all", matched.ly, "bids") : 0;
  const bids: QtdModelData["bids"] = hasGroups
    ? {
        qtd: bidsQtd,
        perLot: lotsQtd > 0 ? bidsQtd / lotsQtd : null,
        perLotMatched: matched && lotsQtdMatched > 0 ? sumG("all", matched.cur, "bids") / lotsQtdMatched : null,
        lyPerLot: matched && lyLotsMatched > 0 ? lyBids / lyLotsMatched : null,
        yoy: matched && lyBids > 0 ? sumG("all", matched.cur, "bids") / lyBids - 1 : null,
      }
    : null;

  return {
    hasGroups,
    hasMetrics: metrics.size > 0,
    groupFirst: gFirst,
    groupLast: gLast,
    dg,
    totalDays: qKeys.length,
    matchedDays: matched ? matched.ly.length : null,
    segments,
    segmentHistory,
    preview: {
      rows: previewRows,
      takeRate,
      takeRateIsForecast: takeRateFc != null,
      consensus,
      consensusDelta: consensus != null && consensus > 0 && scaledFqe != null ? scaledFqe / consensus - 1 : null,
      scaledFqe,
      method: viewNow?.primaryMethod ?? null,
      guidanceMid: gMid,
      impliedBeat: scaledFqe != null && gMid != null && gMid > 0 ? scaledFqe / gMid - 1 : null,
      beat,
    },
    txns: {
      lotsQtd,
      lotsYoy,
      lyLotsMatched,
      capture: txnCapture,
      fqe: txnFqe,
      method: lotsMethod,
      modelTxn,
      modelTxnIsForecast,
      selectedComplete,
    },
    aspRows,
    ops,
    listingRows,
    bids,
    latestParticipants: latestReported("auction_participants"),
    takeRateModel,
  };
}

const fmtCount = (v: number) => Math.round(v).toLocaleString("en-US");
const fmtEps = (v: number) => `$${v.toFixed(2)}`;
const fmtPlainPct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;
const fmtPreview = (v: number | null, kind: "usd" | "eps" | "pct") =>
  v == null ? "—" : kind === "usd" ? fmtM(v) : kind === "eps" ? fmtEps(v) : fmtPlainPct(v);

function Section({ title, sub, defaultOpen = false, children }: { title: string; sub?: string; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details open={defaultOpen} className="rounded-lg border">
      <summary className="cursor-pointer select-none bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-700">
        {title}
        {sub && <span className="ml-1.5 font-normal text-gray-400">{sub}</span>}
      </summary>
      <div className="space-y-3 border-t p-3">{children}</div>
    </details>
  );
}

const Unavailable = ({ what }: { what: string }) => (
  <p className="text-xs text-gray-400">{what} unavailable — the durable store didn&rsquo;t answer for this request.</p>
);

const yoySpan = (v: number | null) =>
  v == null ? <span className="text-gray-300">—</span> : <span className={v >= 0 ? "text-green-600" : "text-red-600"}>{fmtPct(v)}</span>;

const qLabel = (q: string, isQtd: boolean) => (isQtd ? `QTD ${formatQuarterLabel(q, "cy")}` : formatQuarterLabel(q, "cy"));

export function QtdModelSections(props: QtdModelInput) {
  const { selected, currentQuarter, listings } = props;
  const m = useMemo(() => computeQtdModelData(props), [props]);

  const groupProvenance = m.hasGroups ? (
    <p className="text-[11px] text-gray-400">
      Group data through {m.groupLast} · day {m.dg} of {m.totalDays} for {formatQuarterLabel(selected)} (may lag the headline series by up to a day).
    </p>
  ) : null;

  return (
    <div className="space-y-3">
      {/* A. Segments */}
      <Section title="Segment GMV" sub="scraped gov / retail / intl vs reported GovDeals / RSCG / CAG" defaultOpen>
        {!m.hasGroups ? (
          <Unavailable what="Scraped segment split" />
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-3">
              {m.segments.map((seg) => (
                <StatCard
                  key={seg.key}
                  label={`${seg.name} QTD (${seg.sub})`}
                  value={
                    <>
                      {fmtM(seg.qtdGmv)} {yoySpan(seg.yoy)}
                    </>
                  }
                  sub={
                    seg.capture
                      ? `capture ≈ ${fmtPlainPct(seg.capture.rate, 0)} vs ${seg.vs} (${seg.capture.n} qtrs) · implied total ${fmtM(seg.impliedTotal!)}`
                      : `no capture rate yet vs ${seg.vs}`
                  }
                />
              ))}
            </div>
            <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-4">
              {m.segmentHistory.map(({ metric, title, rows }) => {
                if (rows.length === 0) return null;
                const cols: MCol[] = rows.map((r) => ({
                  key: `${r.quarter}-${r.basis}`,
                  top: formatQuarterLabel(r.quarter, "cy"),
                  sub: `(${formatQuarterLabel(r.quarter, "fq")}${r.basis === "model E" ? " · model E" : ""})`,
                  nominal: r.value,
                  yoy: r.yoy,
                  hl: r.basis === "model E",
                  total: true,
                }));
                return (
                  <div key={metric}>
                    <p className="mb-1 text-xs font-medium text-gray-500">{title}</p>
                    <MetricsTable groups={[{ name: title, cols }]} scale={1} scaled={false} />
                  </div>
                );
              })}
            </div>
            {!m.hasMetrics && <p className="text-xs text-gray-400">Model metrics unavailable — reported segment history hidden.</p>}
            {groupProvenance}
          </>
        )}
      </Section>

      {/* B. Earnings preview */}
      <Section title={`Earnings preview — ${formatQuarterLabel(currentQuarter)}`} sub="always the current quarter, total-company basis">
        {!m.hasMetrics && m.preview.rows.every((r) => r.guidanceLow == null && r.model == null) ? (
          <p className="text-xs text-gray-400">Model metrics unavailable — no guidance / model context to preview.</p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b-2 border-gray-300 text-left">
                    <th className="px-2.5 py-1 font-semibold text-gray-600">Metric</th>
                    <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Guidance</th>
                    <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Guide mid</th>
                    <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Clearline model</th>
                    <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Ours (implied)</th>
                    <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Ours vs mid</th>
                  </tr>
                </thead>
                <tbody>
                  {m.preview.rows.map((r) => (
                    <tr key={r.label} className="border-b border-gray-100">
                      <td className="px-2.5 py-1 font-medium text-gray-700">{r.label}</td>
                      <td className="px-2.5 py-1 text-right tabular-nums text-gray-700">
                        {r.guidanceLow != null && r.guidanceHigh != null
                          ? `${fmtPreview(r.guidanceLow, r.kind)}–${fmtPreview(r.guidanceHigh, r.kind)}`
                          : "—"}
                      </td>
                      <td className="px-2.5 py-1 text-right tabular-nums text-gray-500">{fmtPreview(r.guidanceMid, r.kind)}</td>
                      <td className="px-2.5 py-1 text-right tabular-nums text-gray-700">{fmtPreview(r.model, r.kind)}</td>
                      <td className="px-2.5 py-1 text-right tabular-nums font-semibold text-gray-900">{fmtPreview(r.ours, r.kind)}</td>
                      <td className="px-2.5 py-1 text-right tabular-nums">{yoySpan(r.vsMid)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-gray-400">
              Ours (GMV) = the scaled full-quarter estimate{m.preview.method ? ` (${m.preview.method})` : ""} at the page&rsquo;s capture rate.
              Implied revenue = scaled FQE × model take rate{" "}
              {m.preview.takeRate != null
                ? `${fmtPlainPct(m.preview.takeRate)} (${m.preview.takeRateIsForecast ? "model forecast" : "latest reported"})`
                : "—"}.
              {m.preview.consensus != null && m.preview.consensusDelta != null && (
                <>
                  {" "}
                  Street consensus GMV (CH): {fmtM(m.preview.consensus)} — ours {fmtPct(m.preview.consensusDelta)} vs consensus.
                </>
              )}
            </p>
            {m.takeRateModel?.available && (
              <div className="overflow-x-auto rounded-lg border">
                <p className="border-b bg-gray-50 px-3 py-1.5 text-[11px] font-semibold text-gray-600">
                  Take-rate model{" "}
                  <span className="font-normal text-gray-400">
                    (bucket coefficients fitted on {m.takeRateModel.nQuarters} reported quarter{m.takeRateModel.nQuarters === 1 ? "" : "s"} — θ =
                    revenue per scraped $, capture absorbed)
                  </span>
                </p>
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b-2 border-gray-300 text-left">
                      <th className="px-2.5 py-1 font-semibold text-gray-600">Bucket</th>
                      <th className="px-2.5 py-1 text-right font-semibold text-gray-600">FQE GMV (scraped)</th>
                      <th className="px-2.5 py-1 text-right font-semibold text-gray-600">θ</th>
                      <th className="px-2.5 py-1 text-right font-semibold text-gray-600">≈ take rate</th>
                      <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Revenue contribution</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.takeRateModel.coeffs.map((c) => (
                      <tr key={c.bucket} className="border-b border-gray-100">
                        <td className="px-2.5 py-1 font-medium text-gray-700">{c.label}</td>
                        <td className="px-2.5 py-1 text-right tabular-nums text-gray-700">{c.fqeGmv != null ? fmtM(c.fqeGmv) : "—"}</td>
                        <td className="px-2.5 py-1 text-right tabular-nums text-gray-900">{c.theta.toFixed(3)}</td>
                        <td className="px-2.5 py-1 text-right tabular-nums text-gray-500">{fmtPlainPct(c.approxTake)}</td>
                        <td className="px-2.5 py-1 text-right tabular-nums text-gray-700">
                          {c.revContribution != null ? fmtM(c.revContribution) : "—"}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-b border-gray-100 bg-gray-50/60">
                      <td className="px-2.5 py-1 font-medium text-gray-700">+ Purchase revenue (mostly unscraped GMV, incl. AllSurplus DTC)</td>
                      <td className="px-2.5 py-1 text-right text-gray-300">—</td>
                      <td className="px-2.5 py-1 text-right text-gray-300">—</td>
                      <td className="px-2.5 py-1 text-right text-gray-300">—</td>
                      <td className="px-2.5 py-1 text-right tabular-nums text-gray-700">{fmtM(m.takeRateModel.purchaseAdd)}</td>
                    </tr>
                    <tr className="border-b border-gray-100 bg-gray-50/60">
                      <td className="px-2.5 py-1 font-medium text-gray-700">+ Machinio (subscription, no GMV)</td>
                      <td className="px-2.5 py-1 text-right text-gray-300">—</td>
                      <td className="px-2.5 py-1 text-right text-gray-300">—</td>
                      <td className="px-2.5 py-1 text-right text-gray-300">—</td>
                      <td className="px-2.5 py-1 text-right tabular-nums text-gray-700">{fmtM(m.takeRateModel.machinioAdd)}</td>
                    </tr>
                    <tr className="bg-blue-50">
                      <td className="px-2.5 py-1 font-semibold text-gray-800">Revenue (mix-adj)</td>
                      <td className="px-2.5 py-1 text-right text-gray-300">—</td>
                      <td className="px-2.5 py-1 text-right text-gray-300">—</td>
                      <td className="px-2.5 py-1 text-right tabular-nums font-medium text-gray-700">
                        {m.takeRateModel.mixTakeRate != null ? fmtPlainPct(m.takeRateModel.mixTakeRate) : "—"}
                      </td>
                      <td className="px-2.5 py-1 text-right tabular-nums font-semibold text-gray-900">
                        {m.takeRateModel.mixRevenue != null ? fmtM(m.takeRateModel.mixRevenue) : "—"}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p className="px-3 py-1.5 text-[11px] text-gray-400">
                  In-sample backtest vs reported revenue:{" "}
                  {m.takeRateModel.backtest.map((b) => `${formatQuarterLabel(b.q, "cy")} ${fmtPct(b.errPct)}`).join(" · ")}.
                  {m.preview.rows.some((r) => r.label === "Revenue") &&
                    m.takeRateModel.mixRevenue != null &&
                    (() => {
                      const flat = m.preview.rows.find((r) => r.label === "Revenue")?.ours;
                      return flat != null && flat > 0 ? (
                        <> Mix-adj vs flat take rate: {fmtPct(m.takeRateModel.mixRevenue / flat - 1)}.</>
                      ) : null;
                    })()}
                  {!m.takeRateModel.converged && " (fit did not fully converge)"}
                </p>
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-3">
              {m.preview.beat && (
                <>
                  <StatCard
                    label={`Avg beat vs guidance mid (last ${m.preview.beat.n} qtrs)`}
                    value={yoySpan(m.preview.beat.avg)}
                    sub="reported GMV vs guidance midpoint"
                  />
                  <StatCard
                    label="Beat guidance mid"
                    value={`${m.preview.beat.wins} of ${m.preview.beat.n}`}
                    sub="quarters where reported GMV exceeded the midpoint"
                  />
                </>
              )}
              {m.preview.impliedBeat != null && (
                <StatCard
                  label="Our implied beat this quarter"
                  value={yoySpan(m.preview.impliedBeat)}
                  sub={`scaled FQE ${fmtM(m.preview.scaledFqe!)} vs guidance mid ${fmtM(m.preview.guidanceMid!)}`}
                />
              )}
            </div>
          </>
        )}
      </Section>

      {/* C. Transactions & ASP */}
      <Section title="Transactions & ASP" sub={`captured lots vs reported completed transactions — ${formatQuarterLabel(selected)}`}>
        {!m.hasGroups ? (
          <Unavailable what="Captured lot counts" />
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-3">
              <StatCard
                label="QTD lots captured"
                value={
                  <>
                    {fmtCount(m.txns.lotsQtd)} {yoySpan(m.txns.lotsYoy)}
                  </>
                }
                sub={
                  m.matchedDays != null
                    ? `vs LY same ${m.matchedDays} days: ${fmtCount(m.txns.lyLotsMatched)}`
                    : "prior-year lot data not covered"
                }
              />
              <StatCard
                label="Txn capture rate"
                value={m.txns.capture ? fmtPlainPct(m.txns.capture.rate, 1) : "—"}
                sub={
                  m.txns.capture
                    ? `captured lots ÷ reported completed txns (${m.txns.capture.n} qtrs)`
                    : "needs a reported, fully-covered quarter"
                }
              />
              <StatCard
                label={m.txns.selectedComplete ? "Full-quarter transactions (implied)" : `FQ transactions (implied, ${m.txns.method})`}
                value={m.txns.fqe != null ? fmtCount(m.txns.fqe) : "—"}
                sub={
                  m.txns.modelTxn != null && m.txns.fqe != null
                    ? `model${m.txns.modelTxnIsForecast ? " E" : ""}: ${fmtCount(m.txns.modelTxn)} — ours ${fmtPct(m.txns.fqe / m.txns.modelTxn - 1)}`
                    : "no model transaction figure for this quarter"
                }
              />
            </div>
            {m.aspRows.length > 0 && (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b-2 border-gray-300 text-left">
                      <th className="px-2.5 py-1 font-semibold text-gray-600">Quarter</th>
                      <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Scraped $/lot</th>
                      <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Y/Y</th>
                      <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Reported $/txn</th>
                      <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Y/Y</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.aspRows.map((r) => (
                      <tr key={`${r.q}-${r.isQtd}`} className={`border-b border-gray-100 ${r.isQtd ? "bg-blue-50" : ""}`}>
                        <td className="whitespace-nowrap px-2.5 py-1 font-medium text-gray-700">
                          {qLabel(r.q, r.isQtd)}
                          <span className="ml-1 text-[10px] font-normal text-gray-400">({formatQuarterLabel(r.q, "fq")})</span>
                        </td>
                        <td className="px-2.5 py-1 text-right tabular-nums font-semibold text-gray-900">
                          {r.scraped != null ? `$${fmtCount(r.scraped)}` : "—"}
                        </td>
                        <td className="px-2.5 py-1 text-right tabular-nums">{yoySpan(r.scrapedYoy)}</td>
                        <td className="px-2.5 py-1 text-right tabular-nums text-gray-700">
                          {r.rep != null ? `$${fmtCount(r.rep)}${r.repE ? " E" : ""}` : "—"}
                        </td>
                        <td className="px-2.5 py-1 text-right tabular-nums">{yoySpan(r.repYoy)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {m.ops.quarters.length > 0 && (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b-2 border-gray-300 text-left">
                      <th className="px-2.5 py-1 font-semibold text-gray-600">Reported operating stats</th>
                      {m.ops.quarters.map((q) => (
                        <th key={q} className="px-2.5 py-1 text-right font-semibold text-gray-600">
                          {formatQuarterLabel(q, "cy")}
                          <span className="ml-1 font-normal text-gray-400">({formatQuarterLabel(q, "fq")})</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {m.ops.rows.map((row) => (
                      <tr key={row.metric} className="border-b border-gray-100">
                        <td className="px-2.5 py-1 font-medium text-gray-700">{row.label}</td>
                        {row.cells.map((c) => (
                          <td key={c.q} className="px-2.5 py-1 text-right tabular-nums text-gray-900">
                            {c.value != null ? fmtCount(c.value) : "—"}
                            {c.value != null && c.yoy != null && (
                              <span className={`ml-1 text-[10px] ${c.yoy >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtPct(c.yoy)}</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {groupProvenance}
          </>
        )}
      </Section>

      {/* D. Supply & demand */}
      <Section title="Supply & demand" sub="active listings productivity + bid intensity">
        {m.listingRows == null && listings !== "error" && <p className="text-xs text-gray-400">Loading listings…</p>}
        {listings === "error" && <p className="text-xs text-gray-400">Listings data unavailable.</p>}
        {m.listingRows != null && m.listingRows.length > 0 && (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b-2 border-gray-300 text-left">
                  <th className="px-2.5 py-1 font-semibold text-gray-600">Quarter</th>
                  <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Avg AS listings</th>
                  <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Y/Y</th>
                  <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Avg GD listings</th>
                  <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Y/Y</th>
                  <th className="px-2.5 py-1 text-right font-semibold text-gray-600">GMV / GD listing</th>
                  <th className="px-2.5 py-1 text-right font-semibold text-gray-600">GMV / AS listing</th>
                </tr>
              </thead>
              <tbody>
                {m.listingRows.map((r) => (
                  <tr key={`${r.q}-${r.isQtd}`} className={`border-b border-gray-100 ${r.isQtd ? "bg-blue-50" : ""}`}>
                    <td className="whitespace-nowrap px-2.5 py-1 font-medium text-gray-700">
                      {qLabel(r.q, r.isQtd)}
                      <span className="ml-1 text-[10px] font-normal text-gray-400">({formatQuarterLabel(r.q, "fq")})</span>
                    </td>
                    <td className="px-2.5 py-1 text-right tabular-nums text-gray-900">{fmtCount(r.as)}</td>
                    <td className="px-2.5 py-1 text-right tabular-nums">{yoySpan(r.asYoy)}</td>
                    <td className="px-2.5 py-1 text-right tabular-nums text-gray-900">{fmtCount(r.gd)}</td>
                    <td className="px-2.5 py-1 text-right tabular-nums">{yoySpan(r.gdYoy)}</td>
                    <td className="px-2.5 py-1 text-right tabular-nums text-gray-700">
                      {r.gmvPerGd != null ? `$${(r.gmvPerGd / 1000).toFixed(1)}k` : "—"}
                    </td>
                    <td className="px-2.5 py-1 text-right tabular-nums text-gray-700">
                      {r.gmvPerAs != null ? `$${(r.gmvPerAs / 1000).toFixed(1)}k` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {m.listingRows != null && (
          <p className="text-[11px] text-gray-400">
            GMV / listing = the quarter&rsquo;s captured site GMV ÷ average listings (GD site ÷ GD listings; AD+GI ÷ AllSurplus).
            Blank where the store&rsquo;s daily series doesn&rsquo;t cover the whole quarter; QTD is blank because partial-quarter
            GMV over average listings isn&rsquo;t comparable to full quarters.
          </p>
        )}
        {m.bids ? (
          <div className="grid gap-3 md:grid-cols-3">
            <StatCard
              label="QTD bids per lot"
              value={m.bids.perLot != null ? m.bids.perLot.toFixed(1) : "—"}
              sub={
                m.bids.lyPerLot != null && m.bids.perLotMatched != null
                  ? `LY same window: ${m.bids.lyPerLot.toFixed(1)} (${fmtPct(m.bids.perLotMatched / m.bids.lyPerLot - 1)})`
                  : "LY window not covered"
              }
            />
            <StatCard
              label="QTD total bids"
              value={
                <>
                  {fmtCount(m.bids.qtd)} {yoySpan(m.bids.yoy)}
                </>
              }
              sub="bids on captured sold lots (demand-intensity proxy)"
            />
            <StatCard
              label="Reported auction participants (latest)"
              value={m.latestParticipants != null ? fmtCount(m.latestParticipants) : "—"}
              sub="company-reported quarterly figure, for scale"
            />
          </div>
        ) : (
          <Unavailable what="Bid intensity" />
        )}
      </Section>
    </div>
  );
}
