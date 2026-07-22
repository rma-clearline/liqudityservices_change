// Pure model-driven QTD compute — extracted from components/qtd-model-sections.tsx
// so it runs in Node (the cron report email) as the single source of truth. No
// React/DOM. The section component imports computeQtdModelData + the types back
// for rendering; the report email imports the same function.

import { fitTakeRates, type FitObservation } from "@/lib/take-rate-fit";
import { enumerateQuarterLabelsBetween, etQuarterKey } from "@/lib/time";
import { priorYearQuarter, quarterDayKeys } from "@/lib/qtd-shared";

export type Group = "gov" | "retail" | "intl";
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
