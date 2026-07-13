"use client";

// Cumulative QTD Progress (Yipit/Bloomberg-style): cumulative daily scraped GMV
// through the latest available day, day-aligned against LAST YEAR's same fiscal
// quarter, with a capture-rate scaling to estimated total-company GMV and — once
// scaled — comparisons vs company guidance and the Clearline model estimate.
//
// All math is client-side on the /api/forecast?quarter=ALL payload (full daily
// history + current-quarter open-auction projection + reported/estimate series).

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  type TooltipContentProps,
} from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";
import { enumerateQuarterLabelsBetween, etQuarterKey, formatQuarterLabel, parseQuarterLabel } from "@/lib/time";

type DailyPoint = { date: string; realized_gmv_usd: number; projected_gmv_usd: number };

type QtdData = {
  daily: DailyPoint[];
  earliest_data_date: string;
  reported_gmv_by_quarter?: { quarter: string; reported_gmv_usd: number }[];
  model_estimates_by_quarter?: {
    quarter: string;
    guidance_low_usd: number | null;
    guidance_high_usd: number | null;
    clearline_estimate_usd: number | null;
  }[];
};

type ProjectionKey = "shape" | "auctions" | "runrate";

const PROJECTION_LABEL: Record<ProjectionKey, string> = {
  shape: "Prior-yr shape",
  auctions: "Open auctions",
  runrate: "Run rate",
};

const FALLBACK_CAPTURE = 0.535;

const fmtM = (v: number) => `$${(v / 1e6).toFixed(1)}M`;
const fmtPct = (v: number, digits = 1) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;

/** YYYY-MM-DD keys of every day in the calendar quarter `label` (chronological). */
function quarterDayKeys(label: string): string[] {
  const q = parseQuarterLabel(label);
  if (!q) return [];
  const keys: string[] = [];
  const cursor = new Date(q.start);
  while (cursor < q.end) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

const priorYearQuarter = (label: string) => `${Number(label.slice(0, 4)) - 1}${label.slice(4)}`;

const addDaysKey = (key: string, n: number) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const monthShift = (ym: string, delta: number) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
};
const lastDayOfMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym: string) => `${MONTHS_ABBR[Number(ym.slice(5, 7)) - 1]}-${ym.slice(2, 4)}`;
const shortDate = (key: string) => `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`;

function cumulate(dayKeys: string[], byDate: Map<string, number>): number[] {
  let run = 0;
  return dayKeys.map((k) => {
    run += byDate.get(k) ?? 0;
    return run;
  });
}

type ChartRow = {
  day: number;
  date: string;
  Current: number | null;
  "Last year": number | null;
  "Prior-yr shape": number | null;
  "Open auctions": number | null;
  "Run rate": number | null;
  "Cumulative Y/Y": number | null;
  _dailyCur: number | null;
  _dailyLy: number | null;
};

function StatCard({ label, value, sub, strong }: { label: string; value: ReactNode; sub?: ReactNode; strong?: boolean }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-gray-500 mb-0.5">{label}</p>
      <p className={`tabular-nums ${strong ? "text-xl font-bold text-gray-900" : "text-lg font-semibold text-gray-800"}`}>{value}</p>
      {sub && <div className="mt-0.5 text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

/** One column of the Yipit-style key-metrics tables. `nominal` is captured-basis
 *  unless `total` (guidance/Clearline/reported — total-company $, never scaled).
 *  `lyReported`: LY reported total, enabling a scaled-vs-reported Y/Y fallback. */
type MCol = {
  key: string;
  top: string;
  sub?: string;
  nominal: number;
  yoy: number | null;
  lyReported?: number | null;
  hl?: boolean;
  total?: boolean;
};

function MetricsTable({
  groups,
  scale,
  scaled,
}: {
  groups: { name: string; cols: MCol[] }[];
  scale: number;
  scaled: boolean;
}) {
  const shown = groups.filter((g) => g.cols.length > 0);
  if (shown.length === 0) return null;
  const cell = "px-2.5 py-1 text-right tabular-nums whitespace-nowrap";
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-gray-200 text-left">
            <th className="px-2.5 py-1 text-gray-400 font-medium">(USDmm)</th>
            {shown.map((g) => (
              <th key={g.name} colSpan={g.cols.length} className="border-l px-2.5 py-1 font-semibold text-gray-600">
                {g.name}
              </th>
            ))}
          </tr>
          <tr className="border-b-2 border-gray-300">
            <th />
            {shown.flatMap((g) =>
              g.cols.map((c, i) => (
                <th key={c.key} className={`${cell} font-semibold text-gray-700 ${i === 0 ? "border-l" : ""} ${c.hl ? "bg-blue-50" : ""}`}>
                  {c.top}
                  {c.sub && <span className="block text-[10px] font-normal text-gray-400">{c.sub}</span>}
                </th>
              )),
            )}
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-gray-100">
            <td className="px-2.5 py-1 text-gray-500">Nominal</td>
            {shown.flatMap((g) =>
              g.cols.map((c, i) => (
                <td key={c.key} className={`${cell} font-semibold text-gray-900 ${i === 0 ? "border-l" : ""} ${c.hl ? "bg-blue-50" : ""}`}>
                  {((c.total ? c.nominal : c.nominal * scale) / 1e6).toFixed(1)}
                </td>
              )),
            )}
          </tr>
          <tr>
            <td className="px-2.5 py-1 text-gray-500">Y/Y Growth</td>
            {shown.flatMap((g) =>
              g.cols.map((c, i) => {
                // Captured-vs-captured Y/Y when LY daily data exists; in scaled mode
                // fall back to scaled-vs-LY-REPORTED (marked *).
                const direct = c.yoy;
                const derived =
                  direct == null && scaled && !c.total && c.lyReported ? (c.nominal * scale) / c.lyReported - 1 : null;
                const v = direct ?? derived;
                return (
                  <td key={c.key} className={`${cell} ${i === 0 ? "border-l" : ""} ${c.hl ? "bg-blue-50" : ""}`}>
                    {v == null ? (
                      <span className="text-gray-300">—</span>
                    ) : (
                      <span className={v >= 0 ? "text-green-600" : "text-red-600"}>
                        {fmtPct(v)}
                        {derived != null && <span className="text-gray-400">*</span>}
                      </span>
                    )}
                  </td>
                );
              }),
            )}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function QtdTooltip({ active, payload }: TooltipContentProps<ValueType, NameType>) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as ChartRow | undefined;
  if (!row) return null;
  const lines = payload.filter((p) => p.value != null && !String(p.dataKey).startsWith("_"));
  return (
    <div className="rounded border bg-white px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-semibold text-gray-800">
        Day {row.day} · {row.date}
      </p>
      {lines.map((p) => (
        <p key={String(p.dataKey)} style={{ color: p.color }}>
          {String(p.name)}: {p.dataKey === "Cumulative Y/Y" ? fmtPct(Number(p.value) / 100) : fmtM(Number(p.value))}
        </p>
      ))}
      {row._dailyCur != null && <p className="mt-1 text-gray-500">Day GMV: {fmtM(row._dailyCur)}</p>}
      {row._dailyLy != null && <p className="text-gray-400">LY day GMV: {fmtM(row._dailyLy)}</p>}
    </div>
  );
}

export function QtdProgress() {
  const [state, setState] = useState<{ data: QtdData | null; error: string | null }>({ data: null, error: null });
  const [quarter, setQuarter] = useState<string | null>(null); // null until data arrives (defaults to current)
  const [metric, setMetric] = useState<"dollars" | "yoy">("dollars");
  const [scaled, setScaled] = useState(false);
  const [captureInput, setCaptureInput] = useState(""); // "" = auto
  const [projections, setProjections] = useState<Set<ProjectionKey>>(new Set(["shape", "auctions", "runrate"]));

  useEffect(() => {
    let cancelled = false;
    fetch("/api/forecast?quarter=ALL&takeRate=1")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        return d as QtdData;
      })
      .then((d) => {
        if (!cancelled) setState({ data: d, error: null });
      })
      .catch((e) => {
        if (!cancelled) setState({ data: null, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const todayKey = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const currentQuarter = etQuarterKey(todayKey);

  const model = useMemo(() => {
    const data = state.data;
    if (!data) return null;

    const realizedByDate = new Map<string, number>();
    const projectedByDate = new Map<string, number>();
    let lastDataDate = "";
    for (const d of data.daily) {
      realizedByDate.set(d.date, d.realized_gmv_usd);
      projectedByDate.set(d.date, d.projected_gmv_usd);
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

    return { realizedByDate, projectedByDate, lastDataDate, earliest, quarters, reported, estimates, autoCapture, captureQuarters: recent };
  }, [state.data, todayKey, currentQuarter]);

  const selected = quarter ?? currentQuarter;

  const view = useMemo(() => {
    if (!model) return null;
    const { realizedByDate, projectedByDate, lastDataDate } = model;

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

    // Projections (captured units). Anchor every path at day d so the dashed
    // lines extend the solid QTD line.
    const shapeAvailable = !complete && lyCum != null && lyAt(d - 1) > 0;
    const remainingProjected = dayKeys.slice(d).map((k) => projectedByDate.get(k) ?? 0);
    const auctionsAvailable = !complete && remainingProjected.some((v) => v > 0);
    const shapeAt = (i: number) => qtd + (lyAt(i) - lyAt(d - 1)) * (qtd / lyAt(d - 1));
    let auctionRun = qtd;
    const auctionPath: number[] = dayKeys.map((_, i) => {
      if (i < d) return qtd;
      auctionRun += remainingProjected[i - d] ?? 0;
      return auctionRun;
    });
    const runRateAt = (i: number) => (qtd / d) * (i + 1);

    const fqe = {
      shape: shapeAvailable ? shapeAt(D - 1) : null,
      auctions: auctionsAvailable ? auctionPath[D - 1] : null,
      runrate: !complete ? runRateAt(D - 1) : null,
      actual: complete ? qtd : null,
    };
    // Primary FQE: prior-yr shape, else run-rate. Never the open-auction path —
    // it only covers the scheduled-auction horizon (~2 weeks), not the full quarter.
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
      curCum, qtd, lyCum, lyAt, lyQtd, yoy, lyAvailable,
      shapeAvailable, auctionsAvailable, shapeAt, auctionPath, runRateAt,
      fqe, primaryFqe, primaryMethod, wow,
      reported: model.reported.get(selected) ?? null,
      estimate: model.estimates.get(selected) ?? null,
    };
  }, [model, selected]);

  if (state.error) return <p className="text-sm text-red-600">QTD data unavailable: {state.error}</p>;
  if (!model || !view) return <p className="py-10 text-center text-sm text-gray-500">Loading QTD progress…</p>;

  const captureOverride = Number(captureInput);
  const captureRate =
    captureInput.trim() !== "" && Number.isFinite(captureOverride) && captureOverride > 0 && captureOverride <= 100
      ? captureOverride / 100
      : model.autoCapture;
  const scale = scaled ? 1 / captureRate : 1;

  const { dayKeys, D, d } = view;
  const rows: ChartRow[] = dayKeys.map((date, i) => {
    const inData = i < d;
    const lyVal = view.lyCum ? view.lyAt(i) : null;
    const anchor = i === d - 1; // projections start at the last data day
    return {
      day: i + 1,
      date,
      Current: inData ? view.curCum[i] * scale : null,
      "Last year": lyVal != null ? lyVal * scale : null,
      "Prior-yr shape":
        view.shapeAvailable && projections.has("shape") && (anchor || i >= d) ? view.shapeAt(i) * scale : null,
      "Open auctions":
        view.auctionsAvailable && projections.has("auctions") && (anchor || i >= d) ? view.auctionPath[i] * scale : null,
      "Run rate": !view.complete && projections.has("runrate") && (anchor || i >= d) ? view.runRateAt(i) * scale : null,
      "Cumulative Y/Y":
        metric === "yoy" && inData && view.lyCum && view.lyAt(i) > 0 ? (view.curCum[i] / view.lyAt(i) - 1) * 100 : null,
      _dailyCur: inData ? (view.curCum[i] - (i > 0 ? view.curCum[i - 1] : 0)) : null,
      _dailyLy: view.lyCum && i < (view.lyCum.length ?? 0) ? view.lyCum[i] - (i > 0 ? view.lyCum[i - 1] : 0) : null,
    };
  });

  const est = view.estimate;
  const guidanceLow = est?.guidance_low_usd ?? null;
  const guidanceHigh = est?.guidance_high_usd ?? null;
  const guidanceMid = guidanceLow && guidanceHigh ? (guidanceLow + guidanceHigh) / 2 : null;
  const clearline = est?.clearline_estimate_usd ?? null;
  const scaledFqe = view.primaryFqe * (1 / captureRate); // FQE in total-company terms
  const tickEvery = Math.max(1, Math.ceil(D / 13));

  const chip = (active: boolean, extra = "") =>
    `px-2 py-0.5 text-xs rounded border transition-colors ${
      active ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-600 border-gray-300 hover:border-gray-400"
    } ${extra}`;

  const quarterOptions = model.quarters;
  const lastCompleted = quarterOptions.find((q) => q !== currentQuarter);

  // --- Yipit-style key metrics (always pinned to the LATEST data, independent of
  // the chart's quarter selector) -------------------------------------------------
  const realized = model.realizedByDate;
  const last = model.lastDataDate;
  const sumRange = (from: string, to: string) => {
    let s = 0;
    for (let k = from; k <= to; k = addDaysKey(k, 1)) s += realized.get(k) ?? 0;
    return s;
  };
  const coveredFrom = (from: string) => from >= model.earliest;
  const yoyOf = (cur: number, lyFrom: string, lyTo: string) => {
    if (!coveredFrom(lyFrom)) return null;
    const lySum = sumRange(lyFrom, lyTo);
    return lySum > 0 ? cur / lySum - 1 : null;
  };

  // Months: last two complete months + MTD (LY month aligned to same day-of-month).
  const mtdYm = last.slice(0, 7);
  const lastDom = Number(last.slice(8, 10));
  const monthCols: MCol[] = [];
  for (const delta of [-2, -1]) {
    const ym = monthShift(mtdYm, delta);
    const start = `${ym}-01`;
    if (!coveredFrom(start)) continue;
    const end = `${ym}-${String(lastDayOfMonth(ym)).padStart(2, "0")}`;
    const lyYm = `${Number(ym.slice(0, 4)) - 1}${ym.slice(4)}`;
    const nominal = sumRange(start, end);
    monthCols.push({
      key: ym,
      top: monthLabel(ym),
      nominal,
      yoy: yoyOf(nominal, `${lyYm}-01`, `${lyYm}-${String(lastDayOfMonth(lyYm)).padStart(2, "0")}`),
    });
  }
  {
    const lyYm = `${Number(mtdYm.slice(0, 4)) - 1}${mtdYm.slice(4)}`;
    const nominal = sumRange(`${mtdYm}-01`, last);
    monthCols.push({
      key: "mtd",
      top: `MTD ${shortDate(last)}`,
      nominal,
      yoy: yoyOf(nominal, `${lyYm}-01`, `${lyYm}-${String(Math.min(lastDom, lastDayOfMonth(lyYm))).padStart(2, "0")}`),
      hl: true,
    });
  }

  // Quarters: last completed + QTD (LY aligned by day-of-quarter, like the chart).
  const nowQ = etQuarterKey(last);
  const nowQKeys = quarterDayKeys(nowQ);
  const dNow = nowQKeys.filter((k) => k <= last).length;
  const prevQ = etQuarterKey(addDaysKey(nowQKeys[0], -1));
  const quarterCols: MCol[] = [];
  {
    const pKeys = quarterDayKeys(prevQ);
    if (pKeys.length && coveredFrom(pKeys[0])) {
      const nominal = sumRange(pKeys[0], pKeys[pKeys.length - 1]);
      const lyKeys = quarterDayKeys(priorYearQuarter(prevQ));
      quarterCols.push({
        key: prevQ,
        top: formatQuarterLabel(prevQ, "cy"),
        sub: `(${formatQuarterLabel(prevQ, "fq")})`,
        nominal,
        yoy: lyKeys.length ? yoyOf(nominal, lyKeys[0], lyKeys[lyKeys.length - 1]) : null,
        lyReported: model.reported.get(priorYearQuarter(prevQ)) ?? null,
      });
    }
    const nominal = sumRange(nowQKeys[0], last);
    const lyKeys = quarterDayKeys(priorYearQuarter(nowQ)).slice(0, dNow);
    quarterCols.push({
      key: "qtd",
      top: `QTD ${shortDate(last)}`,
      sub: `(${formatQuarterLabel(nowQ, "fq")})`,
      nominal,
      yoy: lyKeys.length ? yoyOf(nominal, lyKeys[0], lyKeys[lyKeys.length - 1]) : null,
      hl: true,
    });
  }

  // Model group (total-company $ — comparable in scaled mode only, like the chart).
  const modelCols: MCol[] = [];
  if (scaled) {
    for (const q of [prevQ, nowQ]) {
      const e = model.estimates.get(q);
      const lyRep = model.reported.get(priorYearQuarter(q));
      const mid = e?.guidance_low_usd && e?.guidance_high_usd ? (e.guidance_low_usd + e.guidance_high_usd) / 2 : null;
      if (mid) {
        modelCols.push({
          key: `g-${q}`, top: "Guide mid", sub: `(${formatQuarterLabel(q, "fq")})`, nominal: mid,
          yoy: lyRep ? mid / lyRep - 1 : null, total: true,
        });
      }
      if (e?.clearline_estimate_usd) {
        modelCols.push({
          key: `cl-${q}`, top: "Clearline", sub: `(${formatQuarterLabel(q, "fq")})`, nominal: e.clearline_estimate_usd,
          yoy: lyRep ? e.clearline_estimate_usd / lyRep - 1 : null, total: true,
        });
      }
    }
  }

  // Trailing 7 days, one column per week-ending; Y/Y is 52-week (weekday-aligned).
  const t7dCols: MCol[] = [];
  for (const off of [28, 21, 14, 7, 0]) {
    const end = addDaysKey(last, -off);
    const start = addDaysKey(end, -6);
    if (!coveredFrom(start)) continue;
    const nominal = sumRange(start, end);
    t7dCols.push({
      key: `t7d-${end}`, top: shortDate(end), nominal,
      yoy: yoyOf(nominal, addDaysKey(start, -364), addDaysKey(end, -364)),
      hl: off === 0,
    });
  }
  const t7dYoyNow = t7dCols[t7dCols.length - 1]?.yoy ?? null;
  const t7dYoyPrev = t7dCols[t7dCols.length - 2]?.yoy ?? null;
  const t7dWowPp = t7dYoyNow != null && t7dYoyPrev != null ? (t7dYoyNow - t7dYoyPrev) * 100 : null;

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-gray-600 flex items-center gap-2">
          Quarter
          <select
            value={selected}
            onChange={(e) => setQuarter(e.target.value)}
            className="border rounded px-2 py-0.5 text-sm text-gray-900"
          >
            {quarterOptions.map((q) => (
              <option key={q} value={q}>
                {formatQuarterLabel(q)}
                {q === currentQuarter ? " (QTD)" : q === lastCompleted ? " (last completed)" : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-1">
          <button onClick={() => setQuarter(currentQuarter)} className={chip(selected === currentQuarter)}>
            Current QTD
          </button>
          {lastCompleted && (
            <button onClick={() => setQuarter(lastCompleted)} className={chip(selected === lastCompleted)}>
              Last completed
            </button>
          )}
        </div>
        <div className="flex gap-1">
          {(["dollars", "yoy"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMetric(m)}
              disabled={m === "yoy" && !view.lyAvailable}
              className={chip(metric === m, m === "yoy" && !view.lyAvailable ? "opacity-40 cursor-not-allowed" : "")}
              title={m === "yoy" && !view.lyAvailable ? "Prior-year daily data begins Jul 2025" : undefined}
            >
              {m === "dollars" ? "$ QTD" : "Y/Y %"}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {([false, true] as const).map((s) => (
            <button key={String(s)} onClick={() => setScaled(s)} className={chip(scaled === s)}>
              {s ? "Scaled to total" : "As captured"}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-xs text-gray-500">
          Capture rate
          <input
            type="number"
            step="0.1"
            min="1"
            max="100"
            value={captureInput}
            onChange={(e) => setCaptureInput(e.target.value)}
            placeholder={(model.autoCapture * 100).toFixed(1)}
            className="w-16 rounded border px-1.5 py-0.5 text-xs text-gray-900"
          />
          %
          <span className="text-gray-400">
            (auto {(model.autoCapture * 100).toFixed(1)}% from {model.captureQuarters.length} reported qtrs)
          </span>
        </label>
      </div>

      {/* Provenance line — data-through / days-into-period / period dates */}
      <p className="text-xs text-gray-500">
        <strong className="text-gray-700">Data through {view.dataThrough}</strong> · Day {view.d} of {view.D} · Period{" "}
        {view.startKey} → {view.endKey}
        {scaled && <> · scaled @ {(captureRate * 100).toFixed(1)}%</>}
        {!view.lyAvailable && <> · prior-year overlay unavailable (daily data begins {model.earliest})</>}
      </p>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard
          label={`QTD GMV (${scaled ? "scaled to total" : "captured"})`}
          value={fmtM(view.qtd * scale)}
          sub={scaled ? `captured: ${fmtM(view.qtd)}` : `scaled: ${fmtM(view.qtd / captureRate)}`}
          strong
        />
        <StatCard
          label="QTD Y/Y"
          value={view.yoy != null ? <span className={view.yoy >= 0 ? "text-green-600" : "text-red-600"}>{fmtPct(view.yoy)}</span> : "—"}
          sub={
            view.lyQtd != null
              ? `vs LY same ${view.d} days: ${fmtM(view.lyQtd * scale)} · LY full qtr: ${fmtM((view.lyCum?.[view.lyCum.length - 1] ?? 0) * scale)}`
              : "prior-year daily data begins Jul 2025"
          }
        />
        <StatCard
          label={view.complete ? "Full quarter (actual, scaled)" : `FQ estimate (${view.primaryMethod}, scaled)`}
          value={fmtM(scaledFqe)}
          sub={
            <>
              {guidanceLow && guidanceHigh && (
                <span className={guidanceMid ? (scaledFqe >= guidanceMid ? "text-green-600" : "text-red-600") : ""}>
                  vs guidance {fmtM(guidanceLow)}–{fmtM(guidanceHigh)}: {guidanceMid ? fmtPct(scaledFqe / guidanceMid - 1) : ""} vs mid
                </span>
              )}
              {guidanceLow && clearline && <br />}
              {clearline && (
                <span>
                  vs Clearline {fmtM(clearline)}: {fmtPct(scaledFqe / clearline - 1)}
                </span>
              )}
              {!guidanceLow && !clearline && "no guidance / model estimate for this quarter"}
            </>
          }
          strong
        />
        <StatCard
          label="T7D Y/Y"
          value={
            t7dYoyNow == null ? (
              "—"
            ) : (
              <span className={t7dYoyNow >= 0 ? "text-green-600" : "text-red-600"}>{fmtPct(t7dYoyNow)}</span>
            )
          }
          sub={
            t7dWowPp == null
              ? "trailing 7 days vs 52 weeks ago"
              : `${t7dWowPp >= 0 ? "↗" : "↘"} ${Math.abs(t7dWowPp).toFixed(1)} pp WoW`
          }
        />
        <StatCard
          label="Last 7 days"
          value={
            view.wow == null ? (
              "—"
            ) : Math.abs(view.wow) < 0.01 ? (
              <span className="text-gray-600">→ unchanged</span>
            ) : view.wow > 0 ? (
              <span className="text-green-600">▲ {fmtPct(view.wow)}</span>
            ) : (
              <span className="text-red-600">▼ {fmtPct(view.wow)}</span>
            )
          }
          sub="change in the full-quarter estimate vs one week ago"
        />
      </div>

      {/* Key metrics tables (Yipit-style) — pinned to the latest data */}
      <div className="grid gap-3 xl:grid-cols-[3fr_2fr]">
        <div>
          <p className="mb-1 text-xs font-semibold text-gray-600">
            Key metrics <span className="font-normal text-gray-400">({scaled ? `scaled @ ${(captureRate * 100).toFixed(1)}%` : "as captured"})</span>
          </p>
          <MetricsTable
            groups={[
              { name: "Months", cols: monthCols },
              { name: "Quarters", cols: quarterCols },
              { name: "Model (total co.)", cols: modelCols },
            ]}
            scale={scale}
            scaled={scaled}
          />
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold text-gray-600">
            T7D <span className="font-normal text-gray-400">(trailing 7 days, week ending)</span>
          </p>
          <MetricsTable groups={[{ name: "Trailing 7 days", cols: t7dCols }]} scale={scale} scaled={scaled} />
        </div>
      </div>
      <p className="text-xs text-gray-400 -mt-1">
        Y/Y shows &ldquo;—&rdquo; where prior-year daily data doesn&rsquo;t exist yet (begins {model.earliest}).
        T7D Y/Y compares to 52 weeks ago (weekday-aligned). *Scaled QTD/quarter vs LY <em>reported</em> total.
        {!scaled && " Switch to Scaled to total to compare against guidance / the Clearline model."}
      </p>

      {/* Projection toggles */}
      {!view.complete && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
          Projections:
          {(Object.keys(PROJECTION_LABEL) as ProjectionKey[]).map((k) => {
            const available = k === "shape" ? view.shapeAvailable : k === "auctions" ? view.auctionsAvailable : true;
            return (
              <button
                key={k}
                disabled={!available}
                onClick={() =>
                  setProjections((prev) => {
                    const next = new Set(prev);
                    if (next.has(k)) next.delete(k);
                    else next.add(k);
                    return next;
                  })
                }
                className={chip(projections.has(k) && available, available ? "" : "opacity-40 cursor-not-allowed")}
                title={
                  k === "shape" && !view.shapeAvailable
                    ? "Needs prior-year daily data"
                    : k === "auctions" && !view.auctionsAvailable
                      ? "No scheduled open-auction projection for this quarter"
                      : undefined
                }
              >
                {PROJECTION_LABEL[k]}
              </button>
            );
          })}
        </div>
      )}

      {/* Chart */}
      <ResponsiveContainer width="100%" height={380}>
        <ComposedChart data={rows} margin={{ top: 10, right: 16, bottom: 5, left: 20 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="day"
            tick={{ fontSize: 10 }}
            interval={tickEvery - 1}
            tickFormatter={(day: number) => dayKeys[day - 1]?.slice(5) ?? String(day)}
          />
          <YAxis
            tickFormatter={(v: number) =>
              metric === "yoy" ? `${v.toFixed(0)}%` : v >= 1_000_000 ? (v / 1_000_000).toFixed(0) + "M" : (v / 1000).toFixed(0) + "k"
            }
            tick={{ fontSize: 11 }}
            domain={metric === "yoy" ? ["auto", "auto"] : [0, "auto"]}
          />
          <Tooltip content={QtdTooltip} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {metric === "dollars" ? (
            <>
              <Line type="monotone" dataKey="Current" stroke="#2563eb" strokeWidth={2.5} dot={false} connectNulls={false} />
              {view.lyAvailable && (
                <Line type="monotone" dataKey="Last year" stroke="#9ca3af" strokeWidth={1.5} dot={false} />
              )}
              {view.shapeAvailable && projections.has("shape") && (
                <Line type="monotone" dataKey="Prior-yr shape" stroke="#7c3aed" strokeWidth={1.5} strokeDasharray="6 3" dot={false} connectNulls />
              )}
              {view.auctionsAvailable && projections.has("auctions") && (
                <Line type="monotone" dataKey="Open auctions" stroke="#0e8fa8" strokeWidth={1.5} strokeDasharray="6 3" dot={false} connectNulls />
              )}
              {!view.complete && projections.has("runrate") && (
                <Line type="monotone" dataKey="Run rate" stroke="#6b7280" strokeWidth={1} strokeDasharray="3 3" dot={false} connectNulls />
              )}
              {scaled && guidanceLow != null && (
                <ReferenceLine y={guidanceLow} stroke="#15803d" strokeDasharray="4 2" label={{ value: `Guidance low ${fmtM(guidanceLow)}`, position: "insideBottomLeft", fontSize: 10, fill: "#15803d" }} />
              )}
              {scaled && guidanceHigh != null && (
                <ReferenceLine y={guidanceHigh} stroke="#15803d" strokeDasharray="4 2" label={{ value: `Guidance high ${fmtM(guidanceHigh)}`, position: "insideTopLeft", fontSize: 10, fill: "#15803d" }} />
              )}
              {scaled && clearline != null && (
                <ReferenceLine y={clearline} stroke="#d97706" strokeDasharray="5 3" label={{ value: `Clearline ${fmtM(clearline)}`, position: "insideTopRight", fontSize: 10, fill: "#d97706" }} />
              )}
              {scaled && view.reported != null && (
                <ReferenceLine y={view.reported} stroke="#dc2626" label={{ value: `Reported actual ${fmtM(view.reported)}`, position: "insideRight", fontSize: 10, fill: "#dc2626" }} />
              )}
            </>
          ) : (
            <>
              <ReferenceLine y={0} stroke="#9ca3af" />
              <Line type="monotone" dataKey="Cumulative Y/Y" stroke="#2563eb" strokeWidth={2.5} dot={false} />
            </>
          )}
        </ComposedChart>
      </ResponsiveContainer>

      <p className="text-xs text-gray-400">
        Cumulative scraped GMV, day-aligned to {formatQuarterLabel(selected)}. &ldquo;Last year&rdquo; is the same fiscal
        quarter one year earlier (full quarter shown for the landing point). Projections are dashed from the last data day:
        prior-yr shape applies last year&rsquo;s rest-of-quarter distribution at the current Y/Y pace; open auctions uses the
        scheduled-auction model (covers only the scheduled horizon, ~2 weeks — not a full-quarter estimate); run rate
        extrapolates the QTD daily average. Guidance / Clearline / reported lines are
        total-company figures and appear in <em>Scaled to total</em> mode only. Quarters labeled CQ (calendar) / (FQ = LQDT
        fiscal, FY ends Sep 30).
      </p>
    </div>
  );
}
