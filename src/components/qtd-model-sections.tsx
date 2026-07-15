"use client";

// Model-driven QTD sections (below the headline chart/tables):
//   A. Segment GMV  — scraped gov/retail/intl split vs reported GovDeals/RSCG/CAG
//   B. Earnings preview — scaled FQE × model take rate vs guidance/consensus
//   C. Transactions & ASP — captured lots vs reported completed transactions
//   D. Supply & demand — active listings productivity + bid intensity
//
// Inputs: the forecast payload's `model_metrics` (long-format workbook export) and
// `sold_by_group_daily` (per-day gov/retail/intl gmv/lots/bids), both optional —
// each section degrades independently — plus /api/listings for Section D.
//
// The gov/retail/intl groups are honest scrape axes, NOT LQDT's segments: GD-site
// retail sellers mix RSCG and CAG, so each group carries its OWN capture rate vs
// the closest reported segment(s) and is never scaled by the headline rate.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { enumerateQuarterLabelsBetween, etQuarterKey, formatQuarterLabel } from "@/lib/time";
import { fmtM, fmtPct, MetricsTable, priorYearQuarter, quarterDayKeys, StatCard, type MCol } from "./qtd-shared";

type Group = "gov" | "retail" | "intl";
export type ModelMetricRow = { quarter: string; metric: string; value: number; kind: "reported" | "forecast" };
export type GroupDailyRow = { date: string; group: Group; gmv: number; lots: number; bids: number };

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

const fmtCount = (v: number) => Math.round(v).toLocaleString("en-US");
const fmtEps = (v: number) => `$${v.toFixed(2)}`;
const fmtPlainPct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;

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

export function QtdModelSections({
  metricsRows,
  groupDaily,
  selected,
  currentQuarter,
  estimates,
  siteByDate,
  viewNow,
  captureRate,
}: {
  metricsRows?: ModelMetricRow[];
  groupDaily?: GroupDailyRow[];
  selected: string;
  currentQuarter: string;
  estimates: Map<string, Estimate>;
  siteByDate: Map<string, { ad: number; gd: number; gi: number }>;
  viewNow: ViewNow;
  captureRate: number;
}) {
  // --- model metrics: metric → quarter → { reported?, forecast? } ------------
  const metrics = useMemo(() => {
    const m = new Map<string, Map<string, { reported?: number; forecast?: number }>>();
    for (const r of metricsRows ?? []) {
      let byQ = m.get(r.metric);
      if (!byQ) m.set(r.metric, (byQ = new Map()));
      let cell = byQ.get(r.quarter);
      if (!cell) byQ.set(r.quarter, (cell = {}));
      if (cell[r.kind] == null) cell[r.kind] = r.value; // reported never overwritten
    }
    return m;
  }, [metricsRows]);
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

  // --- group daily series -----------------------------------------------------
  const g = useMemo(() => {
    const map = new Map<Group, Map<string, { gmv: number; lots: number; bids: number }>>();
    let first = "";
    let last = "";
    for (const r of groupDaily ?? []) {
      let byDate = map.get(r.group);
      if (!byDate) map.set(r.group, (byDate = new Map()));
      byDate.set(r.date, { gmv: r.gmv, lots: r.lots, bids: r.bids });
      if (r.gmv > 0 || r.lots > 0) {
        if (!first || r.date < first) first = r.date;
        if (r.date > last) last = r.date;
      }
    }
    return { map, first, last };
  }, [groupDaily]);
  const hasGroups = g.first !== "";
  const sumG = (grp: Group | "all", keys: string[], field: "gmv" | "lots" | "bids") => {
    const list: Group[] = grp === "all" ? ["gov", "retail", "intl"] : [grp];
    let s = 0;
    for (const gg of list) {
      const byDate = g.map.get(gg);
      if (!byDate) continue;
      for (const k of keys) s += byDate.get(k)?.[field] ?? 0;
    }
    return s;
  };
  /** Keys of quarter `q` restricted to the group series' coverage. */
  const qKeysCovered = (q: string) => quarterDayKeys(q).filter((k) => k >= g.first && k <= g.last);
  /** Quarters (chronological) covered by the group series, tolerating ≤2 missing
   *  edge days (the store starts 2025-07-02; the headline blend starts 07-01). */
  const coveredQuarters = useMemo(() => {
    if (!hasGroups) return [] as string[];
    return enumerateQuarterLabelsBetween(etQuarterKey(g.first), etQuarterKey(g.last)).filter((q) => {
      const keys = quarterDayKeys(q);
      return keys.length > 0 && qKeysCovered(q).length >= keys.length - 2;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasGroups, g.first, g.last]);

  // Selected-quarter window on the group series (may lag the headline by ≤1 day).
  const qKeys = quarterDayKeys(selected);
  const dg = hasGroups ? qKeys.filter((k) => k <= g.last).length : 0;
  const qtdKeys = qKeys.slice(0, dg);
  const lyQKeys = quarterDayKeys(priorYearQuarter(selected));
  const selectedComplete = dg > 0 && dg >= qKeys.length;
  // Day-of-quarter–aligned Y/Y windows, restricted to day indexes whose LY date the
  // group series covers (skips the store's missing first day(s) on BOTH sides so
  // the comparison stays like-for-like). Null when <90% of the window matches.
  const matched = useMemo(() => {
    if (!hasGroups || dg === 0 || lyQKeys.length === 0) return null;
    const cur: string[] = [];
    const ly: string[] = [];
    const n = Math.min(dg, lyQKeys.length);
    for (let i = 0; i < n; i++) {
      if (lyQKeys[i] >= g.first && lyQKeys[i] <= g.last) {
        cur.push(qKeys[i]);
        ly.push(lyQKeys[i]);
      }
    }
    return cur.length > 0 && cur.length >= n * 0.9 ? { cur, ly } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasGroups, dg, selected, g.first, g.last]);
  // Full LY quarter (coverage-restricted) for the prior-yr-shape lots projection.
  const lyFullKeys = qKeysCovered(priorYearQuarter(selected));
  const lyFullUsable = lyQKeys.length > 0 && lyFullKeys.length >= lyQKeys.length - 2;

  // --- A. segment capture rates ------------------------------------------------
  const segCapture = (seg: (typeof SEGMENTS)[number]): { rate: number; n: number } | null => {
    const rates: number[] = [];
    for (const q of coveredQuarters) {
      const reps = seg.reportedMetrics.map((m) => mVal(m, q, "reported"));
      if (reps.some((r) => r == null || r <= 0)) continue;
      const scraped = sumG(seg.key, qKeysCovered(q), "gmv");
      if (scraped <= 0) continue;
      rates.push(scraped / reps.reduce<number>((s, r) => s + (r ?? 0), 0));
    }
    const recent = rates.slice(-3);
    if (recent.length === 0) return null;
    return { rate: recent.reduce((s, x) => s + x, 0) / recent.length, n: recent.length };
  };

  // Reported segment history tables (pinned to the latest data, like key metrics).
  const segmentHistory = (metric: string): MCol[] => {
    const byQ = metrics.get(metric);
    if (!byQ) return [];
    const reportedQs = [...byQ.entries()]
      .filter(([, cell]) => cell.reported != null)
      .map(([q]) => q)
      .sort();
    const cols: MCol[] = reportedQs.slice(-6).map((q) => {
      const prior = byQ.get(priorYearQuarter(q))?.reported ?? null;
      const v = byQ.get(q)!.reported!;
      return {
        key: q,
        top: formatQuarterLabel(q, "cy"),
        sub: `(${formatQuarterLabel(q, "fq")})`,
        nominal: v,
        yoy: prior != null && prior > 0 ? v / prior - 1 : null,
        total: true,
      };
    });
    const fc = byQ.get(currentQuarter)?.forecast;
    if (fc != null && !reportedQs.includes(currentQuarter)) {
      const prior = byQ.get(priorYearQuarter(currentQuarter))?.reported ?? null;
      cols.push({
        key: `${currentQuarter}-e`,
        top: formatQuarterLabel(currentQuarter, "cy"),
        sub: `(${formatQuarterLabel(currentQuarter, "fq")} · model E)`,
        nominal: fc,
        yoy: prior != null && prior > 0 ? fc / prior - 1 : null,
        hl: true,
        total: true,
      });
    }
    return cols;
  };

  // --- B. earnings preview (pinned to the current quarter) ----------------------
  const nowQ = currentQuarter;
  const estNow = estimates.get(nowQ);
  const gLow = estNow?.guidance_low_usd ?? null;
  const gHigh = estNow?.guidance_high_usd ?? null;
  const gMid = gLow != null && gHigh != null ? (gLow + gHigh) / 2 : null;
  const scaledFqeNow = viewNow ? viewNow.primaryFqe / captureRate : null;
  const takeRateFc = mVal("total_take_rate", nowQ, "forecast");
  const takeRateNow = takeRateFc ?? latestReported("total_take_rate");
  const impliedRevenue = scaledFqeNow != null && takeRateNow != null ? scaledFqeNow * takeRateNow : null;
  const gmvConsensus = mVal("gmv_consensus", nowQ);

  const guidanceRange = (metric: string, fmt: (v: number) => string): { text: string; mid: number } | null => {
    const low = mVal(`${metric}_low`, nowQ);
    const high = mVal(`${metric}_high`, nowQ);
    if (low == null || high == null) return null;
    return { text: `${fmt(low)}–${fmt(high)}`, mid: (low + high) / 2 };
  };
  const previewRows: { label: string; guidance: string; mid: string; model: string; ours: string; vsMid: number | null }[] = [];
  {
    const fmtRow = (
      label: string,
      guide: { text: string; mid: number } | null,
      model: number | null,
      ours: number | null,
      fmt: (v: number) => string,
    ) => {
      previewRows.push({
        label,
        guidance: guide?.text ?? "—",
        mid: guide ? fmt(guide.mid) : "—",
        model: model != null ? fmt(model) : "—",
        ours: ours != null ? fmt(ours) : "—",
        vsMid: guide && ours != null && guide.mid > 0 ? ours / guide.mid - 1 : null,
      });
    };
    fmtRow(
      "GMV",
      gLow != null && gHigh != null ? { text: `${fmtM(gLow)}–${fmtM(gHigh)}`, mid: gMid! } : null,
      estNow?.clearline_estimate_usd ?? null,
      scaledFqeNow,
      fmtM,
    );
    fmtRow("Revenue", guidanceRange("revenue_guidance", fmtM), mVal("revenue", nowQ, "forecast"), impliedRevenue, fmtM);
    fmtRow(
      "EBITDA",
      guidanceRange("ebitda_guidance", fmtM),
      mVal("ebitda", nowQ, "forecast") ?? mVal("adj_ebitda", nowQ, "forecast"),
      null,
      fmtM,
    );
    fmtRow("EPS", guidanceRange("eps_guidance", fmtEps), mVal("eps", nowQ, "forecast"), null, fmtEps);
    const gm = mVal("gross_margin", nowQ, "forecast");
    if (gm != null) previewRows.push({ label: "Gross margin", guidance: "—", mid: "—", model: fmtPlainPct(gm), ours: "—", vsMid: null });
  }

  // Guidance-beat history (Beat vs Mid row, reported quarters only).
  const beatHistory = useMemo(() => {
    const byQ = metrics.get("beat_vs_mid");
    if (!byQ) return null;
    const vals = [...byQ.entries()]
      .filter(([, cell]) => cell.reported != null)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, cell]) => cell.reported!)
      .slice(-8);
    if (vals.length === 0) return null;
    return {
      avg: vals.reduce((s, v) => s + v, 0) / vals.length,
      wins: vals.filter((v) => v > 0).length,
      n: vals.length,
    };
  }, [metrics]);

  // --- C. transactions & ASP ----------------------------------------------------
  const lotsQtd = sumG("all", qtdKeys, "lots");
  const lyLotsMatched = matched ? sumG("all", matched.ly, "lots") : 0;
  const lotsQtdMatched = matched ? sumG("all", matched.cur, "lots") : 0;
  const lotsYoy = matched && lyLotsMatched > 0 ? lotsQtdMatched / lyLotsMatched - 1 : null;
  const txnCapture = useMemo(() => {
    const rates: number[] = [];
    for (const q of coveredQuarters) {
      const rep = mVal("completed_transactions", q, "reported");
      if (rep == null || rep <= 0) continue;
      const lots = sumG("all", qKeysCovered(q), "lots");
      if (lots > 0) rates.push(lots / rep);
    }
    const recent = rates.slice(-3);
    if (recent.length === 0) return null;
    return { rate: recent.reduce((s, x) => s + x, 0) / recent.length, n: recent.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coveredQuarters, metrics, g.map]);

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

  // ASP table rows: last ≤5 fully-covered quarters + the selected quarter's QTD.
  const aspRows = useMemo(() => {
    const rows: { key: string; label: string; sub?: string; scraped: number | null; scrapedYoy: number | null; rep: number | null; repE: boolean; repYoy: number | null; hl?: boolean }[] = [];
    const scrapedAsp = (keys: string[]): number | null => {
      const gmv = sumG("all", keys, "gmv");
      const lots = sumG("all", keys, "lots");
      return lots > 0 ? gmv / lots : null;
    };
    for (const q of coveredQuarters.slice(-5)) {
      const cur = scrapedAsp(qKeysCovered(q));
      const lyQ = priorYearQuarter(q);
      const ly = coveredQuarters.includes(lyQ) ? scrapedAsp(qKeysCovered(lyQ)) : null;
      const rep = mVal("gmv_per_transaction", q, "reported");
      const repLy = mVal("gmv_per_transaction", lyQ, "reported");
      rows.push({
        key: q,
        label: formatQuarterLabel(q, "cy"),
        sub: `(${formatQuarterLabel(q, "fq")})`,
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
      rows.push({
        key: "qtd",
        label: `QTD ${formatQuarterLabel(selected, "cy")}`,
        sub: `(${formatQuarterLabel(selected, "fq")})`,
        scraped: cur,
        scrapedYoy: cur != null && ly != null && ly > 0 ? cur / ly - 1 : null,
        rep,
        repE: modelTxnIsForecast,
        repYoy: rep != null && repLy != null && repLy > 0 ? rep / repLy - 1 : null,
        hl: true,
      });
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coveredQuarters, metrics, g.map, selected, dg, selectedComplete, matched]);

  // Reported operating stats (last 4 reported quarters).
  const opsQuarters = useMemo(() => {
    const byQ = metrics.get("completed_transactions");
    if (!byQ) return [] as string[];
    return [...byQ.entries()]
      .filter(([, cell]) => cell.reported != null)
      .map(([q]) => q)
      .sort()
      .slice(-4);
  }, [metrics]);
  const OPS_METRICS: { metric: string; label: string }[] = [
    { metric: "completed_transactions", label: "Completed transactions" },
    { metric: "auction_participants", label: "Auction participants" },
    { metric: "registered_buyers", label: "Registered buyers" },
  ];

  // --- D. supply & demand --------------------------------------------------------
  const [listings, setListings] = useState<{ date: string; allsurplus: number; govdeals: number }[] | "error" | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/listings")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (!Array.isArray(d)) return setListings("error");
        // Newest-first with possibly several snapshots per day — keep the latest per date.
        const seen = new Set<string>();
        const rows: { date: string; allsurplus: number; govdeals: number }[] = [];
        for (const r of d) {
          const date = typeof r?.date === "string" ? r.date : null;
          if (!date || seen.has(date)) continue;
          seen.add(date);
          rows.push({ date, allsurplus: Number(r.allsurplus ?? 0), govdeals: Number(r.govdeals ?? 0) });
        }
        setListings(rows);
      })
      .catch(() => {
        if (!cancelled) setListings("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const listingRows = useMemo(() => {
    if (!Array.isArray(listings)) return null;
    const byQ = new Map<string, { as: number; gd: number; n: number }>();
    for (const r of listings) {
      const q = etQuarterKey(r.date);
      const cell = byQ.get(q) ?? { as: 0, gd: 0, n: 0 };
      cell.as += r.allsurplus;
      cell.gd += r.govdeals;
      cell.n += 1;
      byQ.set(q, cell);
    }
    const avg = (q: string): { as: number; gd: number; n: number } | null => {
      const c = byQ.get(q);
      return c && c.n > 0 ? { as: c.as / c.n, gd: c.gd / c.n, n: c.n } : null;
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
    const rows: { key: string; label: string; sub?: string; as: number; asYoy: number | null; gd: number; gdYoy: number | null; gmvPerGd: number | null; gmvPerAs: number | null; hl?: boolean }[] = [];
    for (const q of full.slice(-6)) {
      const cur = avg(q)!;
      const ly = avg(priorYearQuarter(q));
      const keys = quarterDayKeys(q);
      // GMV/listing only when the store's site series covers the whole quarter.
      const covered = hasGroups && keys[0] >= g.first && keys[keys.length - 1] <= g.last;
      const gmv = covered ? siteGmv(keys) : null;
      rows.push({
        key: q,
        label: formatQuarterLabel(q, "cy"),
        sub: `(${formatQuarterLabel(q, "fq")})`,
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
      rows.push({
        key: "qtd",
        label: `QTD ${formatQuarterLabel(currentQuarter, "cy")}`,
        sub: `(${formatQuarterLabel(currentQuarter, "fq")})`,
        as: qtdAvg.as,
        asYoy: ly && ly.as > 0 ? qtdAvg.as / ly.as - 1 : null,
        gd: qtdAvg.gd,
        gdYoy: ly && ly.gd > 0 ? qtdAvg.gd / ly.gd - 1 : null,
        gmvPerGd: null, // partial-quarter GMV ÷ avg listings isn't comparable to full quarters
        gmvPerAs: null,
        hl: true,
      });
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listings, currentQuarter, siteByDate, hasGroups, g.first, g.last]);

  const bidsQtd = sumG("all", qtdKeys, "bids");
  const bidsPerLot = lotsQtd > 0 ? bidsQtd / lotsQtd : null;
  const lyBids = matched ? sumG("all", matched.ly, "bids") : 0;
  const lyBidsPerLot = matched && lyLotsMatched > 0 ? lyBids / lyLotsMatched : null;
  const bidsPerLotMatched = matched && lotsQtdMatched > 0 ? sumG("all", matched.cur, "bids") / lotsQtdMatched : null;
  const bidsYoy = matched && lyBids > 0 ? sumG("all", matched.cur, "bids") / lyBids - 1 : null;

  const groupProvenance = hasGroups ? (
    <p className="text-[11px] text-gray-400">
      Group data through {g.last} · day {dg} of {qKeys.length} for {formatQuarterLabel(selected)} (may lag the headline series by up to a day).
    </p>
  ) : null;

  return (
    <div className="space-y-3">
      {/* A. Segments */}
      <Section title="Segment GMV" sub="scraped gov / retail / intl vs reported GovDeals / RSCG / CAG" defaultOpen>
        {!hasGroups ? (
          <Unavailable what="Scraped segment split" />
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-3">
              {SEGMENTS.map((seg) => {
                const qtdG = sumG(seg.key, qtdKeys, "gmv");
                const lyG = matched ? sumG(seg.key, matched.ly, "gmv") : 0;
                const yoy = matched && lyG > 0 ? sumG(seg.key, matched.cur, "gmv") / lyG - 1 : null;
                const cap = segCapture(seg);
                return (
                  <StatCard
                    key={seg.key}
                    label={`${seg.name} QTD (${seg.sub})`}
                    value={
                      <>
                        {fmtM(qtdG)} {yoySpan(yoy)}
                      </>
                    }
                    sub={
                      cap
                        ? `capture ≈ ${fmtPlainPct(cap.rate, 0)} vs ${seg.vs} (${cap.n} qtrs) · implied total ${fmtM(qtdG / cap.rate)}`
                        : `no capture rate yet vs ${seg.vs}`
                    }
                  />
                );
              })}
            </div>
            <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-4">
              {(
                [
                  { metric: "govdeals_gmv", title: "GovDeals GMV (reported)" },
                  { metric: "rscg_gmv", title: "RSCG GMV (reported)" },
                  { metric: "cag_gmv", title: "CAG GMV (reported)" },
                  { metric: "machinio_revs", title: "Machinio revenue (reported)" },
                ] as const
              ).map(({ metric, title }) => {
                const cols = segmentHistory(metric);
                if (cols.length === 0) return null;
                return (
                  <div key={metric}>
                    <p className="mb-1 text-xs font-medium text-gray-500">{title}</p>
                    <MetricsTable groups={[{ name: title, cols }]} scale={1} scaled={false} />
                  </div>
                );
              })}
            </div>
            {metrics.size === 0 && <p className="text-xs text-gray-400">Model metrics unavailable — reported segment history hidden.</p>}
            {groupProvenance}
          </>
        )}
      </Section>

      {/* B. Earnings preview */}
      <Section title={`Earnings preview — ${formatQuarterLabel(nowQ)}`} sub="always the current quarter, total-company basis">
        {metrics.size === 0 && !estNow ? (
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
                  {previewRows.map((r) => (
                    <tr key={r.label} className="border-b border-gray-100">
                      <td className="px-2.5 py-1 font-medium text-gray-700">{r.label}</td>
                      <td className="px-2.5 py-1 text-right tabular-nums text-gray-700">{r.guidance}</td>
                      <td className="px-2.5 py-1 text-right tabular-nums text-gray-500">{r.mid}</td>
                      <td className="px-2.5 py-1 text-right tabular-nums text-gray-700">{r.model}</td>
                      <td className="px-2.5 py-1 text-right tabular-nums font-semibold text-gray-900">{r.ours}</td>
                      <td className="px-2.5 py-1 text-right tabular-nums">{yoySpan(r.vsMid)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-gray-400">
              Ours (GMV) = the scaled full-quarter estimate{viewNow ? ` (${viewNow.primaryMethod})` : ""} at the page&rsquo;s capture rate.
              Implied revenue = scaled FQE × model take rate{" "}
              {takeRateNow != null ? `${fmtPlainPct(takeRateNow)} (${takeRateFc != null ? "model forecast" : "latest reported"})` : "—"}.
              {gmvConsensus != null && scaledFqeNow != null && (
                <>
                  {" "}
                  Street consensus GMV (CH): {fmtM(gmvConsensus)} — ours {fmtPct(scaledFqeNow / gmvConsensus - 1)} vs consensus.
                </>
              )}
            </p>
            <div className="grid gap-3 md:grid-cols-3">
              {beatHistory && (
                <>
                  <StatCard
                    label={`Avg beat vs guidance mid (last ${beatHistory.n} qtrs)`}
                    value={yoySpan(beatHistory.avg)}
                    sub="reported GMV vs guidance midpoint"
                  />
                  <StatCard
                    label="Beat guidance mid"
                    value={`${beatHistory.wins} of ${beatHistory.n}`}
                    sub="quarters where reported GMV exceeded the midpoint"
                  />
                </>
              )}
              {scaledFqeNow != null && gMid != null && (
                <StatCard
                  label="Our implied beat this quarter"
                  value={yoySpan(scaledFqeNow / gMid - 1)}
                  sub={`scaled FQE ${fmtM(scaledFqeNow)} vs guidance mid ${fmtM(gMid)}`}
                />
              )}
            </div>
          </>
        )}
      </Section>

      {/* C. Transactions & ASP */}
      <Section title="Transactions & ASP" sub={`captured lots vs reported completed transactions — ${formatQuarterLabel(selected)}`}>
        {!hasGroups ? (
          <Unavailable what="Captured lot counts" />
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-3">
              <StatCard
                label="QTD lots captured"
                value={
                  <>
                    {fmtCount(lotsQtd)} {yoySpan(lotsYoy)}
                  </>
                }
                sub={matched ? `vs LY same ${matched.ly.length} days: ${fmtCount(lyLotsMatched)}` : "prior-year lot data not covered"}
              />
              <StatCard
                label="Txn capture rate"
                value={txnCapture ? fmtPlainPct(txnCapture.rate, 1) : "—"}
                sub={txnCapture ? `captured lots ÷ reported completed txns (${txnCapture.n} qtrs)` : "needs a reported, fully-covered quarter"}
              />
              <StatCard
                label={selectedComplete ? "Full-quarter transactions (implied)" : `FQ transactions (implied, ${lotsMethod})`}
                value={txnFqe != null ? fmtCount(txnFqe) : "—"}
                sub={
                  modelTxn != null && txnFqe != null
                    ? `model${modelTxnIsForecast ? " E" : ""}: ${fmtCount(modelTxn)} — ours ${fmtPct(txnFqe / modelTxn - 1)}`
                    : "no model transaction figure for this quarter"
                }
              />
            </div>
            {aspRows.length > 0 && (
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
                    {aspRows.map((r) => (
                      <tr key={r.key} className={`border-b border-gray-100 ${r.hl ? "bg-blue-50" : ""}`}>
                        <td className="whitespace-nowrap px-2.5 py-1 font-medium text-gray-700">
                          {r.label}
                          {r.sub && <span className="ml-1 text-[10px] font-normal text-gray-400">{r.sub}</span>}
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
            {opsQuarters.length > 0 && (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b-2 border-gray-300 text-left">
                      <th className="px-2.5 py-1 font-semibold text-gray-600">Reported operating stats</th>
                      {opsQuarters.map((q) => (
                        <th key={q} className="px-2.5 py-1 text-right font-semibold text-gray-600">
                          {formatQuarterLabel(q, "cy")}
                          <span className="ml-1 font-normal text-gray-400">({formatQuarterLabel(q, "fq")})</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {OPS_METRICS.map(({ metric, label }) => (
                      <tr key={metric} className="border-b border-gray-100">
                        <td className="px-2.5 py-1 font-medium text-gray-700">{label}</td>
                        {opsQuarters.map((q) => {
                          const v = mVal(metric, q, "reported");
                          const ly = mVal(metric, priorYearQuarter(q), "reported");
                          return (
                            <td key={q} className="px-2.5 py-1 text-right tabular-nums text-gray-900">
                              {v != null ? fmtCount(v) : "—"}
                              {v != null && ly != null && ly > 0 && (
                                <span className={`ml-1 text-[10px] ${v / ly - 1 >= 0 ? "text-green-600" : "text-red-600"}`}>
                                  {fmtPct(v / ly - 1)}
                                </span>
                              )}
                            </td>
                          );
                        })}
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
        {listingRows == null && listings !== "error" && <p className="text-xs text-gray-400">Loading listings…</p>}
        {listings === "error" && <p className="text-xs text-gray-400">Listings data unavailable.</p>}
        {listingRows != null && listingRows.length > 0 && (
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
                {listingRows.map((r) => (
                  <tr key={r.key} className={`border-b border-gray-100 ${r.hl ? "bg-blue-50" : ""}`}>
                    <td className="whitespace-nowrap px-2.5 py-1 font-medium text-gray-700">
                      {r.label}
                      {r.sub && <span className="ml-1 text-[10px] font-normal text-gray-400">{r.sub}</span>}
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
        {listingRows != null && (
          <p className="text-[11px] text-gray-400">
            GMV / listing = the quarter&rsquo;s captured site GMV ÷ average listings (GD site ÷ GD listings; AD+GI ÷ AllSurplus).
            Blank where the store&rsquo;s daily series doesn&rsquo;t cover the whole quarter; QTD is blank because partial-quarter
            GMV over average listings isn&rsquo;t comparable to full quarters.
          </p>
        )}
        {hasGroups ? (
          <div className="grid gap-3 md:grid-cols-3">
            <StatCard
              label="QTD bids per lot"
              value={bidsPerLot != null ? bidsPerLot.toFixed(1) : "—"}
              sub={lyBidsPerLot != null && bidsPerLotMatched != null ? `LY same window: ${lyBidsPerLot.toFixed(1)} (${fmtPct(bidsPerLotMatched / lyBidsPerLot - 1)})` : "LY window not covered"}
            />
            <StatCard
              label="QTD total bids"
              value={
                <>
                  {fmtCount(bidsQtd)} {yoySpan(bidsYoy)}
                </>
              }
              sub="bids on captured sold lots (demand-intensity proxy)"
            />
            <StatCard
              label="Reported auction participants (latest)"
              value={latestReported("auction_participants") != null ? fmtCount(latestReported("auction_participants")!) : "—"}
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
