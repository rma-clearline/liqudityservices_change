"use client";

// Cumulative QTD Progress (Yipit/Bloomberg-style): cumulative daily scraped GMV
// through the latest available day, day-aligned against LAST YEAR's same fiscal
// quarter, with a capture-rate scaling to estimated total-company GMV and — once
// scaled — comparisons vs company guidance and the Clearline model estimate.
//
// All math is client-side on the /api/forecast?quarter=ALL payload (full daily
// history + reported/estimate series).

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  type TooltipContentProps,
} from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";
import { downloadCsv } from "@/lib/format";
import { etQuarterKey, formatQuarterLabel, lqdtFiscalQuarter } from "@/lib/time";
import {
  buildModel,
  buildQuarterView,
  PROJECTION_LABEL,
  type ProjectionKey,
  type QtdData as QtdComputeData,
  type QtdModel,
} from "@/lib/qtd-compute";
import {
  computeQtdModelData,
  QtdModelSections,
  type BucketDailyRow,
  type ListingsDay,
  type ModelMetricRow,
} from "./qtd-model-sections";
import {
  addDaysKey,
  fmtM,
  fmtPct,
  MetricsTable,
  priorYearQuarter,
  quarterDayKeys,
  StatCard,
  type MCol,
} from "./qtd-shared";

// The forecast ALL payload, with the model-sections extras this component also renders.
type QtdData = QtdComputeData & {
  model_metrics?: ModelMetricRow[];
  sold_by_bucket_daily?: BucketDailyRow[];
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

type ChartRow = {
  day: number;
  date: string;
  Current: number | null;
  "Last year": number | null;
  "Prior-yr shape": number | null;
  "Run rate": number | null;
  "Cumulative Y/Y": number | null;
  "Guidance mid (implied FQ Y/Y)": number | null;
  "Clearline (implied FQ Y/Y)": number | null;
  /** True when the row's projection values are Y/Y percentages, not dollars. */
  _yoyMode: boolean;
  _dailyCur: number | null;
  _dailyLy: number | null;
};

// Definitions & methodology for every number on the page — rendered at the bottom
// so analysts can audit exactly how each figure is derived.
const DEFINITIONS: { group: string; items: { term: string; def: string }[] }[] = [
  {
    group: "Headline figures",
    items: [
      {
        term: "QTD GMV (captured)",
        def: "Sum of scraped daily sold GMV (per-lot hammer prices from the durable auction store, deduped, USD via daily FX) from the fiscal quarter's first day through the data-through date.",
      },
      {
        term: "Scaled to total",
        def: "Captured GMV ÷ capture rate — an estimate of LQDT's total-company GMV. All projections, deltas, and the model columns follow this basis when the toggle is on.",
      },
      {
        term: "Capture rate",
        def: "How much of LQDT's total reported GMV the scrape captures. Auto = average of (captured full-quarter GMV ÷ LQDT reported GMV) over the last 3 reported quarters; the input overrides it.",
      },
      {
        term: "QTD Y/Y",
        def: "Cumulative captured QTD ÷ last year's same fiscal quarter aligned by day-of-quarter (day 13 vs day 13), minus 1. Calendar dates differ; day alignment keeps the comparison at the same depth into the quarter. In Scaled mode, when LY reported GMV exists, the base switches to LY reported GMV prorated to the same day (reported × LY captured-through-day ÷ LY captured full quarter) — marked *.",
      },
      {
        term: "Data through / Day N of M",
        def: "Latest Eastern-time day with captured sold data, and how many of the fiscal period's days that covers. Intraday capture runs ~5pm and ~11pm ET, so 'today' fills in same-evening.",
      },
      {
        term: "T7D Y/Y",
        def: "Trailing-7-day captured GMV vs the same 7 days 52 weeks ago (a 364-day shift, which preserves the weekday mix — auction closings cluster by weekday). The window ends at the last COMPLETE ET day; the current (still-filling) day is excluded so intraday snapshots don't swing.",
      },
      {
        term: "Last 7 days (FQE change)",
        def: "The full-quarter estimate recomputed with the last 7 days of data excluded, compared to the current estimate — shows whether the past week's activity pushed the quarter's trajectory up or down (±1% = unchanged).",
      },
    ],
  },
  {
    group: "Projections (dashed lines from the last data day)",
    items: [
      {
        term: "Prior-yr shape (primary)",
        def: "QTD ÷ (LY cumulative through the same day ÷ LY full quarter). Applies last year's rest-of-quarter daily distribution at the current Y/Y pace — the Yipit-style RoQ method; handles seasonality/lumpiness. Needs LY daily data.",
      },
      {
        term: "Run rate",
        def: "QTD daily average × days in the quarter. Crude (ignores seasonality) but always available; the fallback when prior-year data doesn't exist.",
      },
      {
        term: "Projections in Y/Y % mode",
        def: "Run rate is drawn as implied cumulative Y/Y (projected cumulative ÷ LY cumulative at the same day − 1). Prior-yr shape is NOT drawn in this mode: its implied cumulative Y/Y is algebraically the current QTD Y/Y (the LY-cumulative cancels), so the line would restate the solid one dressed as a forecast. Instead the Y/Y view draws the external calls as implied full-quarter Y/Y vs LY REPORTED GMV — Guidance midpoint (green) and the Clearline estimate (amber), from the last data day to quarter end, omitted when within 0.05pp of the current Y/Y (a line that restates another line is noise). Both sides of those ratios are total-company, so they are capture-rate-free in either display mode.",
      },
    ],
  },
  {
    group: "Benchmarks (total-company $, shown in Scaled mode)",
    items: [
      {
        term: "Guidance low / high",
        def: "Company GMV guidance for the quarter, from the model workbook's 'Total GMV Guidance' row (stated in $M) — or an analyst override entered via the ✎ Estimates button (which wins for that quarter). 'vs mid' compares the scaled FQ estimate to the midpoint.",
      },
      {
        term: "Clearline estimate",
        def: "The Clearline model's own Total GMV forecast for the quarter (the model's forecast columns, $000 → USD). Refreshed via the extract + push scripts after each model update, or overridden per quarter via ✎ Estimates (manual overrides are attributed and revertible).",
      },
      {
        term: "Reported actual",
        def: "LQDT's reported total-company GMV once the quarter is reported (sum of all reported segments, from the model). Appears as a chart line for backtesting the scaled estimate.",
      },
    ],
  },
  {
    group: "Tables",
    items: [
      {
        term: "Months / MTD",
        def: "Calendar-month captured sums; MTD runs through the data-through day and its Y/Y compares to the same day-of-month range last year.",
      },
      {
        term: "Quarters / QTD",
        def: "Last completed fiscal quarter (full) and the current QTD; Y/Y aligned by day-of-quarter. A * marks Y/Y computed as scaled value vs LY REPORTED total (used when captured prior-year data doesn't exist yet).",
      },
      {
        term: "Model (total co.) columns",
        def: "Guidance midpoint and Clearline estimate with their implied Y/Y vs LY reported GMV — same basis as the scaled numbers, never scaled themselves.",
      },
      {
        term: "T7D table",
        def: "Trailing-7-day captured GMV for each of the last five week-ending dates; Y/Y per the 364-day rule above.",
      },
      {
        term: "CQ / FQ labels",
        def: "CQ = calendar quarter; FQ = LQDT fiscal quarter (fiscal year ends Sep 30, so CY Q3 = FQ4 and CY Q4 = FQ1 of the next fiscal year).",
      },
    ],
  },
  {
    group: "Segment & model sections",
    items: [
      {
        term: "Segment groups (gov / retail / intl)",
        def: "Honest scrape axes, NOT LQDT's reporting segments: intl = the GI marketplace; gov = government sellers on AD/GD; retail = the remainder. GD-site retail sellers mix RSCG and CAG, so a clean scraped GovDeals/RSCG/CAG split is not possible.",
      },
      {
        term: "Segment capture rate",
        def: "Scraped full-quarter group GMV ÷ the closest reported segment(s) — gov↔GovDeals, retail↔RSCG+CAG, intl↔CAG — averaged over the last 3 fully-covered reported quarters. Each group scales by its OWN capture, never the headline rate.",
      },
      {
        term: "Implied revenue",
        def: "Scaled full-quarter GMV estimate × the model's total take rate for the quarter (falling back to the latest reported take rate) — comparable to company revenue guidance.",
      },
      {
        term: "Guidance / model columns (E)",
        def: "Reported values come from the model workbook's integer actual columns; values marked E are the Clearline model's own forecasts. Revenue/EBITDA/EPS guidance ranges are the company's, parsed from the model's guidance rows.",
      },
      {
        term: "Txn capture rate",
        def: "Captured sold lots ÷ LQDT's reported completed transactions, averaged over the last 3 fully-covered reported quarters. Scales captured lot counts to estimated total-company transactions.",
      },
      {
        term: "Scraped $/lot vs reported $/txn",
        def: "Captured GMV ÷ captured lots per quarter, alongside the company's reported GMV per completed transaction — a mix-shift indicator (is GMV moving on volume or price?). Levels differ because the scrape skews toward higher-value marketplaces.",
      },
      {
        term: "Avg active listings",
        def: "Mean of the daily active-listing scrape (AllSurplus / GovDeals) over the quarter. GMV per avg listing divides the same quarter's captured site GMV by that average — the supply-productivity ratio the model forecasts with.",
      },
      {
        term: "Bids per lot",
        def: "Total bids on captured sold lots ÷ lots with a positive price, QTD vs the same days last year — a demand-intensity proxy for the company's reported auction participants.",
      },
      {
        term: "Revenue (mix-adj) / take-rate model",
        def: "Revenue decomposes into three parts. (1) Consignment + fee revenue: scraped GMV splits into fee-regime buckets (gov vehicles & equipment, gov other, retail vehicles, retail other, retail heavy, GI) whose coefficients θ (revenue per scraped $, capture absorbed) are fitted on the reported quarters against consignment+fee revenue (total − Machinio − purchase) and GovDeals segment revenue, with priors from the workbook's take rates and box bounds. (2) Purchase revenue: purchase_gmv × purchase_take_rate (≈104% — LQDT recognizes the full sale price), added back explicitly because most purchase GMV (liquidation.com, AllSurplus DTC) isn't scraped or isn't consignment. (3) Machinio subscription revenue. Mix-adj revenue = Σ θ × bucket FQE GMV + purchase + Machinio.",
      },
      {
        term: "Take-rate model caveats",
        def: "Only a few reported quarters overlap full scrape coverage, and the mix is stable, so coefficients are prior-anchored (ridge) — they sharpen every quarter as reports land. The backtest is in-sample. ≈take rate = θ × the bucket's group capture rate, an approximation since capture varies by bucket. AllSurplus DTC has no fitted coefficient — it is purchase-model, covered by the purchase add-back.",
      },
    ],
  },
];

function DefinitionsBox() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`flex w-full items-center justify-between gap-2 bg-gray-50 px-3 py-2 text-left text-xs font-semibold text-gray-700 hover:bg-gray-100 ${open ? "border-b" : ""}`}
      >
        <span>Definitions &amp; methodology — how each number is derived</span>
        <span className="font-normal text-gray-400">{open ? "▾ Hide" : "▸ Show"}</span>
      </button>
      {open && (
      <table className="w-full border-collapse text-xs">
        <tbody>
          {DEFINITIONS.map((g) => (
            <Fragment key={g.group}>
              <tr className="border-b bg-gray-50/60">
                <td colSpan={2} className="px-3 py-1 font-semibold uppercase tracking-wide text-[10px] text-gray-500">
                  {g.group}
                </td>
              </tr>
              {g.items.map((it) => (
                <tr key={it.term} className="border-b border-gray-100 align-top">
                  <td className="w-48 px-3 py-1.5 font-medium text-gray-700 whitespace-nowrap">{it.term}</td>
                  <td className="px-3 py-1.5 text-gray-500">{it.def}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
      )}
    </div>
  );
}

type TapeQ = {
  q: string;
  fyBand: string; // fiscal-year band header, e.g. "FY26"
  fqLabel: string; // fiscal quarter, e.g. "FQ4"
  cqLabel: string; // calendar-quarter hint, e.g. "CQ3 '26"
  endDate: string;
  live: boolean;
  reportedActual: boolean;
  gmv: number | null;
  gmvYoy: number | null;
  qtdYoy: number | null;
  guideMid: number | null;
  consensus: number | null;
  clearline: number | null;
};

/** Horizontal quarter tape (ODP-style): quarters are COLUMNS under a year band,
 *  metrics are ROWS with a sticky left label column; oldest→newest left→right, auto-
 *  scrolled to the newest (right) edge. The live/unreported quarter is the rightmost
 *  column and reads top→bottom as a bridge: our GMV/estimate → growth → guidance /
 *  Street consensus / Clearline. Blue = reported actual, purple = ours/live, red = CL. */
function QuarterTape({ cols }: { cols: TapeQ[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Scroll to the newest (right) edge when the column set first appears or changes
  // size — keyed on length, NOT the array identity (rebuilt every parent render), so
  // unrelated re-renders (toggles, capture-rate typing) don't yank a user who
  // scrolled left back to the right. useLayoutEffect applies it before paint (no flash).
  useLayoutEffect(() => {
    const elx = scrollRef.current;
    if (elx) elx.scrollLeft = elx.scrollWidth;
  }, [cols.length]);
  if (cols.length === 0) return null;
  const money = (v: number | null) => (v == null ? "—" : `$${(v / 1e6).toFixed(1)}`);
  const pct = (v: number | null): ReactNode =>
    v == null ? (
      <span className="text-gray-300">—</span>
    ) : (
      <span className={v >= 0 ? "text-green-600" : "text-red-600"}>{fmtPct(v)}</span>
    );
  const bands: { label: string; span: number }[] = [];
  for (const c of cols) {
    const b = bands[bands.length - 1];
    if (b && b.label === c.fyBand) b.span++;
    else bands.push({ label: c.fyBand, span: 1 });
  }
  const rows: { label: string; strong?: boolean; render: (c: TapeQ) => ReactNode }[] = [
    { label: "Period end", render: (c) => <span className="text-gray-500">{shortDate(c.endDate)}/{c.endDate.slice(2, 4)}</span> },
    {
      label: "GMV ($M)",
      strong: true,
      render: (c) => (
        <span className={c.reportedActual ? "text-blue-700" : c.live ? "text-purple-700" : "text-gray-900"}>
          {money(c.gmv)}
          {c.live ? "°" : ""}
        </span>
      ),
    },
    { label: "GMV Y/Y", render: (c) => pct(c.gmvYoy) },
    { label: "QTD pace Y/Y", render: (c) => (c.qtdYoy == null ? <span className="text-gray-300">—</span> : pct(c.qtdYoy)) },
    { label: "Guidance mid", render: (c) => <span className="text-gray-700">{money(c.guideMid)}</span> },
    { label: "Consensus (CH)", render: (c) => <span className="text-gray-700">{money(c.consensus)}</span> },
    {
      label: "Clearline",
      render: (c) => (
        <span className={c.clearline != null ? "text-red-600" : "text-gray-300"}>
          {money(c.clearline)}
          {c.clearline != null ? "e" : ""}
        </span>
      ),
    },
  ];
  return (
    <div ref={scrollRef} className="overflow-x-auto rounded-lg border">
      <table className="border-collapse text-xs">
        <thead>
          <tr className="border-b text-left">
            <th className="sticky left-0 z-10 bg-white px-2.5 py-1" />
            {bands.map((b, i) => (
              <th key={i} colSpan={b.span} className={`px-2.5 py-1 text-center font-semibold text-gray-400 ${i > 0 ? "border-l" : ""}`}>
                {b.label}
              </th>
            ))}
          </tr>
          <tr className="border-b-2 border-gray-300 text-left">
            <th className="sticky left-0 z-10 bg-white px-2.5 py-1 font-semibold text-gray-600">Fiscal period</th>
            {cols.map((c) => (
              <th
                key={c.q}
                className={`whitespace-nowrap px-2.5 py-1 text-right font-semibold ${c.live ? "text-purple-700" : "text-gray-600"}`}
                style={{ minWidth: 74 }}
              >
                <div>
                  {c.fqLabel}
                  {c.live ? " · QTD°" : ""}
                </div>
                <div className="text-[10px] font-normal text-gray-400">{c.cqLabel}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-gray-100">
              <th className="sticky left-0 z-10 whitespace-nowrap bg-white px-2.5 py-1 text-left font-medium text-gray-600">{r.label}</th>
              {cols.map((c) => (
                <td key={c.q} className={`px-2.5 py-1 text-right tabular-nums ${r.strong ? "font-semibold" : ""} ${c.live ? "bg-purple-50/40" : ""}`}>
                  {r.render(c)}
                </td>
              ))}
            </tr>
          ))}
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
          {String(p.name)}:{" "}
          {p.dataKey === "Cumulative Y/Y" || row._yoyMode ? fmtPct(Number(p.value) / 100) : fmtM(Number(p.value))}
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
  const [projections, setProjections] = useState<Set<ProjectionKey>>(new Set(["shape", "runrate"]));
  // Guidance / Clearline edit panel ("" = blank field; values entered in $M).
  const [editOpen, setEditOpen] = useState(false);
  const [editLow, setEditLow] = useState("");
  const [editHigh, setEditHigh] = useState("");
  const [editCl, setEditCl] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0); // bump to refetch after a save
  // Daily active-listing counts (latest snapshot per date) for the supply section.
  const [listings, setListings] = useState<ListingsDay[] | "error" | null>(null);

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
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/listings")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (!Array.isArray(d)) return setListings("error");
        // Newest-first with possibly several snapshots per day — keep the latest per date.
        const seen = new Set<string>();
        const rows: ListingsDay[] = [];
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

  const todayKey = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const currentQuarter = etQuarterKey(todayKey);

  const model = useMemo<QtdModel | null>(
    () => (state.data ? buildModel(state.data, todayKey, currentQuarter) : null),
    [state.data, todayKey, currentQuarter],
  );

  const selected = quarter ?? currentQuarter;

  const view = useMemo(() => (model ? buildQuarterView(model, selected) : null), [model, selected]);
  // Current-quarter view for the earnings-preview section, which stays pinned to
  // "now" regardless of the chart's quarter selector.
  const viewNow = useMemo(() => (model ? buildQuarterView(model, currentQuarter) : null), [model, currentQuarter]);

  if (state.error) return <p className="text-sm text-red-600">QTD data unavailable: {state.error}</p>;
  if (!model || !view) return <p className="py-10 text-center text-sm text-gray-500">Loading QTD progress…</p>;

  const captureOverride = Number(captureInput);
  const captureRate =
    captureInput.trim() !== "" && Number.isFinite(captureOverride) && captureOverride > 0 && captureOverride <= 100
      ? captureOverride / 100
      : model.autoCapture;
  const scale = scaled ? 1 / captureRate : 1;

  // Reported-anchored Y/Y (Scaled mode only): scaled QTD vs LY REPORTED GMV
  // prorated to the same day by LY's captured shape. Hoisted to consts so TS
  // narrowing survives the rows-map closure. When the anchor is unavailable
  // (As-captured mode, or no LY reported), everything falls back to the
  // captured-vs-captured behavior exactly.
  const lyRepAt = view.lyReportedAt;
  const reportedAnchor = scaled && lyRepAt != null && lyRepAt(view.d - 1) > 0;
  const lyRepQtd = reportedAnchor && lyRepAt ? lyRepAt(view.d - 1) : null;
  const yoyDisplay = lyRepQtd != null ? (view.qtd * scale) / lyRepQtd - 1 : view.yoy;

  const { dayKeys, D, d } = view;
  const yoyMode = metric === "yoy";

  const est = view.estimate;
  const guidanceLow = est?.guidance_low_usd ?? null;
  const guidanceHigh = est?.guidance_high_usd ?? null;
  const guidanceMid = guidanceLow && guidanceHigh ? (guidanceLow + guidanceHigh) / 2 : null;
  const clearline = est?.clearline_estimate_usd ?? null;

  // Implied full-quarter Y/Y of the external calls, vs LY REPORTED only (never vs a
  // scaled/captured base — both sides are total-company, so the ratio is basis-free).
  // These give the Y/Y view its benchmarks: where guidance and the Clearline model
  // say the quarter LANDS, against where the QTD pace is running. Drawn only when
  // the line adds information (differs from the current Y/Y — the mosaic addsInfo
  // guard); a line that restates another line is noise.
  const curYoyPct = yoyDisplay != null ? yoyDisplay * 100 : null;
  const impliedFqYoy = (estUsd: number | null): number | null => {
    if (!estUsd || view.lyReported == null || view.lyReported <= 0 || view.complete) return null;
    const pct = (estUsd / view.lyReported - 1) * 100;
    return curYoyPct != null && Math.abs(pct - curYoyPct) < 0.05 ? null : pct;
  };
  const guidanceYoy = impliedFqYoy(guidanceMid);
  const clearlineYoy = impliedFqYoy(clearline);

  const rows: ChartRow[] = dayKeys.map((date, i) => {
    const inData = i < d;
    const lyVal = view.lyCum ? view.lyAt(i) : null;
    const anchor = i === d - 1; // projections start at the last data day
    // Implied cumulative Y/Y for a cumulative $ value at day i. Captured mode:
    // raw ÷ LY captured − 1 (capture scale cancels in the ratio). Scaled mode
    // with LY reported available: (raw × scale) ÷ LY-reported-prorated-to-day
    // − 1 — the same reported anchor as the QTD Y/Y card, so the chart's last
    // in-data point always equals the card.
    const impliedYoy = (raw: number): number | null => {
      if (reportedAnchor && lyRepAt) {
        const dn = lyRepAt(i);
        return dn > 0 ? ((raw * scale) / dn - 1) * 100 : null;
      }
      return lyVal != null && lyVal > 0 ? (raw / lyVal - 1) * 100 : null;
    };
    // In $ mode a projection plots its (scaled) cumulative path; in Y/Y mode
    // the implied cumulative Y/Y above.
    const proj = (raw: number | null): number | null =>
      raw == null ? null : !yoyMode ? raw * scale : impliedYoy(raw);
    return {
      day: i + 1,
      date,
      Current: inData ? view.curCum[i] * scale : null,
      // In Scaled mode with the reported anchor, LY plots the reported total
      // distributed by LY's captured shape — so its endpoint lands exactly on
      // the "Reported actual" reference line instead of captured × capture-rate.
      "Last year": reportedAnchor && lyRepAt ? lyRepAt(i) : lyVal != null ? lyVal * scale : null,
      // Prior-yr shape is a $-mode line only. In Y/Y mode its implied cumulative Y/Y
      // is ALGEBRAICALLY the current QTD Y/Y (shape(i)/lyCum(i) cancels to a constant) —
      // a dashed line that looks like a forecast while restating the solid one. Mosaic's
      // ODP explorer measured this (identical for all 457 prior-shape series) and dropped
      // it from the Y/Y view; we follow.
      "Prior-yr shape": yoyMode ? null : proj(view.shapeAvailable && projections.has("shape") && (anchor || i >= d) ? view.shapeAt(i) : null),
      "Run rate": proj(!view.complete && projections.has("runrate") && (anchor || i >= d) ? view.runRateAt(i) : null),
      "Cumulative Y/Y": yoyMode && inData ? impliedYoy(view.curCum[i]) : null,
      // External calls as implied FQ Y/Y, drawn from the last data day to quarter end.
      "Guidance mid (implied FQ Y/Y)": yoyMode && guidanceYoy != null && i >= d - 1 ? guidanceYoy : null,
      "Clearline (implied FQ Y/Y)": yoyMode && clearlineYoy != null && i >= d - 1 ? clearlineYoy : null,
      _yoyMode: yoyMode,
      _dailyCur: inData ? (view.curCum[i] - (i > 0 ? view.curCum[i - 1] : 0)) : null,
      _dailyLy: view.lyCum && i < (view.lyCum.length ?? 0) ? view.lyCum[i] - (i > 0 ? view.lyCum[i - 1] : 0) : null,
    };
  });

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
  const addYearsKey = (key: string, n: number) => {
    const [y, m, dd] = key.split("-").map(Number);
    return new Date(Date.UTC(y + n, m - 1, dd)).toISOString().slice(0, 10);
  };
  // Cumulative quarter-to-date Y/Y as of `end` (day-of-quarter aligned to the prior
  // year, like the chart). Resets at each fiscal-quarter boundary. null if uncovered.
  const qtdYoyAsOf = (end: string): number | null => {
    const q = etQuarterKey(end);
    const qk = quarterDayKeys(q);
    if (!qk.length) return null;
    const elapsed = qk.filter((k) => k <= end).length;
    if (elapsed <= 0 || !coveredFrom(qk[0])) return null;
    const cur = sumRange(qk[0], end);
    const lyqk = quarterDayKeys(priorYearQuarter(q));
    if (lyqk.length < elapsed) return null;
    return yoyOf(cur, lyqk[0], lyqk[elapsed - 1]);
  };
  // Annualized growth (CAGR) of `nominal` over [start,end] vs the same window N
  // years earlier. null until the data reaches back that far ("as available").
  const cagrOf = (nominal: number, start: string, end: string, years: number): number | null => {
    const from = addYearsKey(start, -years);
    if (!coveredFrom(from)) return null;
    // Match the base window's LENGTH to [start,end] rather than shifting BOTH endpoints
    // by a literal calendar year — otherwise a leap day (Feb 29) inside one window but
    // not the other adds/drops a day and skews the ratio.
    const spanDays = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000);
    const base = sumRange(from, addDaysKey(from, spanDays));
    return base > 0 ? Math.pow(nominal / base, 1 / years) - 1 : null;
  };

  // Months: rolling year of complete months + MTD (LY month aligned to same day-of-month).
  const mtdYm = last.slice(0, 7);
  const lastDom = Number(last.slice(8, 10));
  const monthCols: MCol[] = [];
  for (let delta = -12; delta <= -1; delta++) {
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
      qtdYoy: qtdYoyAsOf(end),
      cagr: [cagrOf(nominal, start, end, 2), cagrOf(nominal, start, end, 3), cagrOf(nominal, start, end, 4)],
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
      qtdYoy: qtdYoyAsOf(last),
      cagr: [cagrOf(nominal, `${mtdYm}-01`, last, 2), cagrOf(nominal, `${mtdYm}-01`, last, 3), cagrOf(nominal, `${mtdYm}-01`, last, 4)],
      hl: true,
    });
  }

  // Quarters: every fully-covered quarter (last 8) + QTD, LY aligned by
  // day-of-quarter (like the chart). Historical quarters without captured LY data
  // still get the scaled-vs-LY-REPORTED Y/Y fallback via lyReported.
  const nowQ = etQuarterKey(last);
  const nowQKeys = quarterDayKeys(nowQ);
  const dNow = nowQKeys.filter((k) => k <= last).length;
  const prevQ = etQuarterKey(addDaysKey(nowQKeys[0], -1));
  const quarterCols: MCol[] = [];
  const completedQs = [...model.quarters].reverse().filter((q) => q !== nowQ).slice(-8); // chronological
  for (const q of completedQs) {
    const pKeys = quarterDayKeys(q);
    if (!pKeys.length || !coveredFrom(pKeys[0]) || pKeys[pKeys.length - 1] > last) continue;
    const nominal = sumRange(pKeys[0], pKeys[pKeys.length - 1]);
    const lyKeys = quarterDayKeys(priorYearQuarter(q));
    quarterCols.push({
      key: q,
      top: formatQuarterLabel(q, "cy"),
      sub: `(${formatQuarterLabel(q, "fq")})`,
      nominal,
      yoy: lyKeys.length ? yoyOf(nominal, lyKeys[0], lyKeys[lyKeys.length - 1]) : null,
      lyReported: model.reported.get(priorYearQuarter(q)) ?? null,
    });
  }
  {
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

  // Trailing 7 days, one row per week-ending; Y/Y is 52-week (weekday-aligned).
  // End at the last COMPLETE ET day — "today" is only partially captured until its
  // auctions close, so including it compares a partial day to a full LY day and
  // makes the small 7-day base swing several points intraday. (MTD/QTD above keep
  // `last` — a partial day is negligible there and freshness is the point.)
  const t7dEnd = last < todayKey ? last : addDaysKey(todayKey, -1);
  const t7dCols: MCol[] = [];
  for (const off of [49, 42, 35, 28, 21, 14, 7, 0]) {
    const end = addDaysKey(t7dEnd, -off);
    const start = addDaysKey(end, -6);
    if (!coveredFrom(start)) continue;
    const nominal = sumRange(start, end);
    t7dCols.push({
      key: `t7d-${end}`, top: shortDate(end), nominal,
      yoy: yoyOf(nominal, addDaysKey(start, -364), addDaysKey(end, -364)),
      qtdYoy: qtdYoyAsOf(end),
      cagr: [cagrOf(nominal, start, end, 2), cagrOf(nominal, start, end, 3), cagrOf(nominal, start, end, 4)],
      hl: off === 0,
    });
  }
  const t7dYoyNow = t7dCols[t7dCols.length - 1]?.yoy ?? null;

  // Horizontal quarter "tape" (ODP-style): quarters as COLUMNS, the live/unreported
  // quarter on the right, folding in guidance / Street consensus / Clearline. Total-
  // company basis — reported totals for completed quarters, scaled FQE for the live
  // one — so it's comparable to guidance/consensus/CL regardless of the $/scaled toggle.
  const metricVal = (metric: string, q: string): number | null => {
    const r = (state.data?.model_metrics ?? []).find((x) => x.metric === metric && x.quarter === q);
    return r && Number.isFinite(Number(r.value)) ? Number(r.value) : null;
  };
  // Live-column FQE pinned to nowQ (the quarter of the LATEST data, which can lag
  // currentQuarter) — never fall back to the selected quarter. nowQ always has >=1
  // data day, so this view is non-null in practice; the null branch is defensive.
  const viewNowQ = buildQuarterView(model, nowQ);
  const scaledFqeNow = viewNowQ ? viewNowQ.primaryFqe / captureRate : null;
  const tapeCols: TapeQ[] = [];
  for (const q of completedQs) {
    const pKeys = quarterDayKeys(q);
    if (!pKeys.length) continue;
    const rep = model.reported.get(q) ?? null;
    // Skip a not-yet-real quarter: unreported AND not fully elapsed (end past our
    // last data day). Reported past quarters stay even if they predate capture;
    // the live/partial quarter is rendered separately as the rightmost column.
    if (rep == null && pKeys[pKeys.length - 1] > last) continue;
    // Total-company basis regardless of the $/scaled toggle: reported total when
    // available, else the captured sum grossed up by the capture rate (like the live
    // column's scaledFqeNow) — NOT `* scale`, which would leave it captured-basis in
    // the default As-captured view and understate it next to the total-company columns.
    const gmv = rep ?? sumRange(pKeys[0], pKeys[pKeys.length - 1]) / captureRate;
    const lyRep = model.reported.get(priorYearQuarter(q)) ?? null;
    const e = model.estimates.get(q);
    const { fy, fq } = lqdtFiscalQuarter(Number(q.slice(0, 4)), Number(q.slice(5)));
    tapeCols.push({
      q,
      fyBand: `FY${String(fy).slice(-2)}`,
      fqLabel: `FQ${fq}`,
      cqLabel: `CQ${q.slice(5)} '${q.slice(2, 4)}`,
      endDate: pKeys[pKeys.length - 1], live: false, reportedActual: rep != null,
      gmv, gmvYoy: rep != null && lyRep ? rep / lyRep - 1 : quarterCols.find((c) => c.key === q)?.yoy ?? null,
      qtdYoy: null,
      guideMid: e?.guidance_low_usd && e?.guidance_high_usd ? (e.guidance_low_usd + e.guidance_high_usd) / 2 : null,
      consensus: metricVal("gmv_consensus", q),
      clearline: e?.clearline_estimate_usd ?? null,
    });
  }
  {
    const e = model.estimates.get(nowQ);
    const lyRep = model.reported.get(priorYearQuarter(nowQ)) ?? null;
    const { fy, fq } = lqdtFiscalQuarter(Number(nowQ.slice(0, 4)), Number(nowQ.slice(5)));
    tapeCols.push({
      q: nowQ,
      fyBand: `FY${String(fy).slice(-2)}`,
      fqLabel: `FQ${fq}`,
      cqLabel: `CQ${nowQ.slice(5)} '${nowQ.slice(2, 4)}`,
      endDate: nowQKeys[nowQKeys.length - 1], live: true, reportedActual: false,
      gmv: scaledFqeNow, gmvYoy: lyRep && scaledFqeNow != null ? scaledFqeNow / lyRep - 1 : null,
      qtdYoy: qtdYoyAsOf(last),
      guideMid: e?.guidance_low_usd && e?.guidance_high_usd ? (e.guidance_low_usd + e.guidance_high_usd) / 2 : null,
      consensus: metricVal("gmv_consensus", nowQ),
      clearline: e?.clearline_estimate_usd ?? null,
    });
  }

  // One-click Excel-friendly export: labeled blocks (summary, key metrics, daily
  // progression, then the model sections — segments, earnings preview, transactions
  // & ASP, supply & demand). Dollars are raw integers and Y/Y are "%" strings so
  // Excel parses both natively for pasting into the model.
  const exportCsv = () => {
    const esc = (v: unknown) => {
      const t = v == null ? "" : String(v);
      return /[",\n\r]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t;
    };
    const rowOf = (...cells: unknown[]) => cells.map(esc).join(",");
    const pctS = (v: number | null | undefined) => (v == null ? "" : `${(v * 100).toFixed(1)}%`);
    const lines: string[] = [];

    lines.push(rowOf("LQDT QTD progress export"));
    lines.push(rowOf("Generated (ET)", todayKey));
    lines.push(rowOf("Quarter", `${selected} / ${formatQuarterLabel(selected, "fq")}`));
    lines.push(rowOf("Period", view.startKey, view.endKey));
    lines.push(rowOf("Data through", view.dataThrough, `day ${view.d} of ${view.D}`));
    lines.push(rowOf("Capture rate", `${(captureRate * 100).toFixed(1)}%`, captureInput.trim() ? "manual override" : "auto (last 3 reported qtrs)"));
    lines.push(rowOf("QTD GMV captured (USD)", Math.round(view.qtd)));
    lines.push(rowOf("QTD GMV scaled (USD)", Math.round(view.qtd / captureRate)));
    lines.push(rowOf("QTD Y/Y (captured vs captured)", pctS(view.yoy)));
    // Export is toggle-independent: include the reported-anchored basis too.
    const lyRepQtdExport = view.lyReportedAt ? view.lyReportedAt(view.d - 1) : 0;
    if (lyRepQtdExport > 0) {
      lines.push(
        rowOf("QTD Y/Y (scaled vs LY reported, prorated)", pctS(view.qtd / captureRate / lyRepQtdExport - 1)),
      );
    }
    lines.push(rowOf(view.complete ? "Full quarter actual, scaled (USD)" : `FQ estimate (${view.primaryMethod}), scaled (USD)`, Math.round(scaledFqe)));
    if (guidanceLow != null && guidanceHigh != null) {
      lines.push(rowOf("Guidance low/high (USD)", Math.round(guidanceLow), Math.round(guidanceHigh), guidanceMid ? `${pctS(scaledFqe / guidanceMid - 1)} vs mid` : ""));
    }
    if (clearline != null) lines.push(rowOf("Clearline estimate (USD)", Math.round(clearline), `${pctS(scaledFqe / clearline - 1)} vs CL`));
    if (view.reported != null) lines.push(rowOf("Reported actual (USD)", view.reported));
    lines.push("");

    lines.push(rowOf("Key metrics"));
    lines.push(rowOf("group", "period", "value_usd", "basis", "yoy"));
    for (const c of monthCols) lines.push(rowOf("month", c.top, Math.round(c.nominal), "captured", pctS(c.yoy)));
    for (const c of quarterCols) lines.push(rowOf("quarter", `${c.top} ${c.sub ?? ""}`.trim(), Math.round(c.nominal), "captured", pctS(c.yoy)));
    for (const c of modelCols) lines.push(rowOf("model", `${c.top} ${c.sub ?? ""}`.trim(), Math.round(c.nominal), "total company", pctS(c.yoy)));
    for (const c of t7dCols) lines.push(rowOf("t7d week ending", c.top, Math.round(c.nominal), "captured", pctS(c.yoy)));
    lines.push("");

    lines.push(rowOf(`Daily progression ${selected} / ${formatQuarterLabel(selected, "fq")} (captured USD)`));
    lines.push(rowOf("day", "date", "daily_gmv_usd", "cum_gmv_usd", "ly_date", "ly_daily_gmv_usd", "ly_cum_gmv_usd", "cum_yoy", "proj_prior_shape_cum_usd", "proj_run_rate_cum_usd"));
    const lyDayKeys = quarterDayKeys(priorYearQuarter(selected));
    for (let i = 0; i < view.D; i++) {
      const inData = i < view.d;
      const lyInRange = view.lyCum != null && i < view.lyCum.length;
      const lyDaily = lyInRange ? view.lyCum![i] - (i > 0 ? view.lyCum![i - 1] : 0) : null;
      lines.push(
        rowOf(
          i + 1,
          view.dayKeys[i],
          inData ? Math.round(view.curCum[i] - (i > 0 ? view.curCum[i - 1] : 0)) : "",
          inData ? Math.round(view.curCum[i]) : "",
          lyDayKeys[i] ?? "",
          lyDaily != null ? Math.round(lyDaily) : "",
          view.lyCum ? Math.round(view.lyAt(i)) : "",
          inData && view.lyCum && view.lyAt(i) > 0 ? pctS(view.curCum[i] / view.lyAt(i) - 1) : "",
          view.shapeAvailable && i >= view.d - 1 ? Math.round(view.shapeAt(i)) : "",
          !view.complete && i >= view.d - 1 ? Math.round(view.runRateAt(i)) : "",
        ),
      );
    }

    // --- model-section blocks: exactly the numbers the sections render ---------
    const sections = computeQtdModelData({
      metricsRows: state.data?.model_metrics,
      bucketDaily: state.data?.sold_by_bucket_daily,
      selected,
      currentQuarter,
      estimates: model.estimates,
      siteByDate: model.siteByDate,
      viewNow,
      captureRate,
      listings,
    });
    const fq = (q: string) => formatQuarterLabel(q, "fq");

    if (sections.hasGroups) {
      lines.push("");
      lines.push(rowOf(`Segment QTD ${selected} / ${fq(selected)} (captured USD; gov/retail/intl are scrape axes, not LQDT segments)`));
      lines.push(rowOf("group", "vs_reported_segment", "qtd_gmv_usd", "yoy", "capture_rate", "implied_total_usd"));
      for (const s of sections.segments) {
        lines.push(
          rowOf(
            s.key,
            s.vs,
            Math.round(s.qtdGmv),
            pctS(s.yoy),
            s.capture ? `${(s.capture.rate * 100).toFixed(1)}%` : "",
            s.impliedTotal != null ? Math.round(s.impliedTotal) : "",
          ),
        );
      }
    }

    if (sections.segmentHistory.some((h) => h.rows.length > 0)) {
      lines.push("");
      lines.push(rowOf("Reported segment history (total-company USD; model E = Clearline forecast)"));
      lines.push(rowOf("metric", "quarter", "fiscal", "basis", "value_usd", "yoy"));
      for (const h of sections.segmentHistory) {
        for (const r of h.rows) lines.push(rowOf(h.metric, r.quarter, fq(r.quarter), r.basis, Math.round(r.value), pctS(r.yoy)));
      }
    }

    {
      const p = sections.preview;
      const hasPreview = p.rows.some((r) => r.guidanceLow != null || r.model != null || r.ours != null);
      if (hasPreview) {
        lines.push("");
        lines.push(rowOf(`Earnings preview ${currentQuarter} / ${fq(currentQuarter)} (total company)`));
        lines.push(rowOf("metric", "guidance_low", "guidance_high", "guidance_mid", "clearline_model", "ours_implied", "ours_vs_mid"));
        const num = (v: number | null, kind: "usd" | "eps" | "pct") =>
          v == null ? "" : kind === "usd" ? Math.round(v) : kind === "eps" ? v.toFixed(2) : `${(v * 100).toFixed(1)}%`;
        for (const r of p.rows) {
          lines.push(
            rowOf(
              r.label,
              num(r.guidanceLow, r.kind),
              num(r.guidanceHigh, r.kind),
              num(r.guidanceMid, r.kind),
              num(r.model, r.kind),
              num(r.ours, r.kind),
              pctS(r.vsMid),
            ),
          );
        }
        if (p.takeRate != null)
          lines.push(rowOf("Take rate used", `${(p.takeRate * 100).toFixed(1)}%`, p.takeRateIsForecast ? "model forecast" : "latest reported"));
        if (p.consensus != null)
          lines.push(rowOf("Street consensus GMV (CH)", Math.round(p.consensus), p.consensusDelta != null ? `${pctS(p.consensusDelta)} ours vs consensus` : ""));
        if (p.beat) lines.push(rowOf(`Avg beat vs guidance mid (last ${p.beat.n} qtrs)`, pctS(p.beat.avg), `beat ${p.beat.wins} of ${p.beat.n}`));
        if (p.impliedBeat != null) lines.push(rowOf("Our implied beat this quarter", pctS(p.impliedBeat)));
      }
    }

    if (sections.takeRateModel?.available) {
      const t = sections.takeRateModel;
      lines.push("");
      lines.push(rowOf(`Take-rate model (fitted on ${t.nQuarters} reported quarters; theta = revenue per scraped $, capture absorbed)`));
      lines.push(rowOf("bucket", "theta", "approx_take_rate", "qtd_gmv_usd", "fqe_gmv_usd", "rev_contribution_usd"));
      for (const c of t.coeffs) {
        lines.push(
          rowOf(
            c.bucket,
            c.theta.toFixed(4),
            `${(c.approxTake * 100).toFixed(1)}%`,
            Math.round(c.qtdGmv),
            c.fqeGmv != null ? Math.round(c.fqeGmv) : "",
            c.revContribution != null ? Math.round(c.revContribution) : "",
          ),
        );
      }
      lines.push(rowOf("purchase_revenue_added_usd", Math.round(t.purchaseAdd), "purchase-model revenue, mostly unscraped GMV"));
      lines.push(rowOf("machinio_revenue_added_usd", Math.round(t.machinioAdd)));
      if (t.mixRevenue != null) lines.push(rowOf("mix_adjusted_revenue_usd", Math.round(t.mixRevenue), t.mixTakeRate != null ? `${(t.mixTakeRate * 100).toFixed(1)}% implied take rate` : ""));
      lines.push(rowOf("backtest (in-sample)", "quarter", "actual_revenue_usd", "predicted_revenue_usd", "error"));
      for (const b of t.backtest) lines.push(rowOf("", b.q, Math.round(b.actual), Math.round(b.predicted), pctS(b.errPct)));
    }

    if (sections.hasGroups) {
      const t = sections.txns;
      lines.push("");
      lines.push(rowOf(`Transactions & ASP ${selected} / ${fq(selected)}`));
      lines.push(rowOf("QTD lots captured", Math.round(t.lotsQtd), pctS(t.lotsYoy)));
      if (t.capture) lines.push(rowOf("Txn capture rate", `${(t.capture.rate * 100).toFixed(1)}%`, `${t.capture.n} reported qtrs`));
      if (t.fqe != null)
        lines.push(
          rowOf(
            `FQ transactions implied (${t.method})`,
            Math.round(t.fqe),
            t.modelTxn != null ? `model${t.modelTxnIsForecast ? " E" : ""} ${Math.round(t.modelTxn)}` : "",
            t.modelTxn ? `${pctS(t.fqe / t.modelTxn - 1)} vs model` : "",
          ),
        );
      if (sections.aspRows.length > 0) {
        lines.push(rowOf("quarter", "fiscal", "period", "scraped_usd_per_lot", "scraped_yoy", "reported_usd_per_txn", "reported_basis", "reported_yoy"));
        for (const r of sections.aspRows) {
          lines.push(
            rowOf(
              r.q,
              fq(r.q),
              r.isQtd ? "QTD" : "full",
              r.scraped != null ? Math.round(r.scraped) : "",
              pctS(r.scrapedYoy),
              r.rep != null ? Math.round(r.rep) : "",
              r.rep != null ? (r.repE ? "model E" : "reported") : "",
              pctS(r.repYoy),
            ),
          );
        }
      }
      if (sections.ops.quarters.length > 0) {
        lines.push(rowOf("Reported operating stats"));
        lines.push(rowOf("metric", "quarter", "fiscal", "value", "yoy"));
        for (const row of sections.ops.rows) {
          for (const c of row.cells) {
            if (c.value != null) lines.push(rowOf(row.metric, c.q, fq(c.q), Math.round(c.value), pctS(c.yoy)));
          }
        }
      }
    }

    if ((sections.listingRows != null && sections.listingRows.length > 0) || sections.bids) {
      lines.push("");
      lines.push(rowOf("Supply & demand"));
      if (sections.listingRows?.length) {
        lines.push(
          rowOf("quarter", "fiscal", "period", "avg_allsurplus_listings", "as_yoy", "avg_govdeals_listings", "gd_yoy", "gmv_per_gd_listing_usd", "gmv_per_as_listing_usd"),
        );
        for (const r of sections.listingRows) {
          lines.push(
            rowOf(
              r.q,
              fq(r.q),
              r.isQtd ? "QTD" : "full",
              Math.round(r.as),
              pctS(r.asYoy),
              Math.round(r.gd),
              pctS(r.gdYoy),
              r.gmvPerGd != null ? Math.round(r.gmvPerGd) : "",
              r.gmvPerAs != null ? Math.round(r.gmvPerAs) : "",
            ),
          );
        }
      }
      if (sections.bids) {
        lines.push(rowOf("QTD total bids", Math.round(sections.bids.qtd), pctS(sections.bids.yoy)));
        lines.push(
          rowOf(
            "QTD bids per lot",
            sections.bids.perLot != null ? sections.bids.perLot.toFixed(1) : "",
            sections.bids.lyPerLot != null ? `LY same window ${sections.bids.lyPerLot.toFixed(1)}` : "",
          ),
        );
      }
    }

    downloadCsv(`lqdt-qtd-${selected}-through-${view.dataThrough}.csv`, lines.join("\n") + "\n");
  };

  // --- guidance / Clearline edit panel -------------------------------------
  const openEditor = () => {
    const e = view.estimate;
    setEditLow(e?.guidance_low_usd ? String(e.guidance_low_usd / 1e6) : "");
    setEditHigh(e?.guidance_high_usd ? String(e.guidance_high_usd / 1e6) : "");
    setEditCl(e?.clearline_estimate_usd ? String(Math.round((e.clearline_estimate_usd / 1e6) * 10) / 10) : "");
    setEditErr(null);
    setEditOpen(true);
  };

  const saveEstimates = async (clear: boolean) => {
    setEditBusy(true);
    setEditErr(null);
    try {
      const toUsd = (s: string) => {
        if (s.trim() === "") return null;
        const n = Number(s);
        if (!Number.isFinite(n) || n <= 0) throw new Error("Values must be positive numbers, in $M (e.g. 454.6).");
        return Math.round(n * 1e6);
      };
      const payload = clear
        ? { quarter: selected, clear: true }
        : {
            quarter: selected,
            guidance_low_usd: toUsd(editLow),
            guidance_high_usd: toUsd(editHigh),
            clearline_estimate_usd: toUsd(editCl),
          };
      const r = await fetch("/api/model-estimates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setEditOpen(false);
      setReload((n) => n + 1); // refetch so the chart/tables pick up the new values
    } catch (e) {
      setEditErr(e instanceof Error ? e.message : String(e));
    } finally {
      setEditBusy(false);
    }
  };

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
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => (editOpen ? setEditOpen(false) : openEditor())}
            className="rounded border border-gray-300 bg-white px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50"
            title="Enter or update company guidance and the Clearline estimate for the selected quarter"
          >
            ✎ Estimates
          </button>
          <button
            onClick={exportCsv}
            className="rounded border border-gray-300 bg-white px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50"
            title="Download summary, key metrics, and the daily progression as an Excel-friendly CSV"
          >
            Export to Excel (CSV)
          </button>
        </div>
      </div>

      {/* Guidance / Clearline editor — overrides the model-file values per quarter */}
      {editOpen && (
        <div className="space-y-2 rounded-lg border bg-gray-50 p-3">
          <p className="text-xs font-semibold text-gray-700">
            Guidance / Clearline estimate for {formatQuarterLabel(selected)}{" "}
            <span className="font-normal text-gray-400">(values in $M, total company)</span>
          </p>
          <div className="flex flex-wrap items-end gap-3">
            {(
              [
                { label: "Guidance low", value: editLow, set: setEditLow, ph: "e.g. 425" },
                { label: "Guidance high", value: editHigh, set: setEditHigh, ph: "e.g. 465" },
                { label: "Clearline estimate", value: editCl, set: setEditCl, ph: "e.g. 454.6" },
              ] as const
            ).map((f) => (
              <label key={f.label} className="text-xs text-gray-600">
                {f.label}
                <input
                  type="number"
                  min="1"
                  step="0.1"
                  value={f.value}
                  onChange={(e) => f.set(e.target.value)}
                  placeholder={f.ph}
                  className="mt-0.5 block w-28 rounded border px-2 py-1 text-sm text-gray-900"
                />
              </label>
            ))}
            <button
              onClick={() => saveEstimates(false)}
              disabled={editBusy}
              className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {editBusy ? "Saving…" : "Save"}
            </button>
            {view.estimate?.source === "manual" && (
              <button
                onClick={() => saveEstimates(true)}
                disabled={editBusy}
                className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                title="Remove the manual override and restore this quarter's model-workbook values"
              >
                Revert to model
              </button>
            )}
            <button
              onClick={() => setEditOpen(false)}
              disabled={editBusy}
              className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
          {editErr && <p className="text-xs text-red-600">{editErr}</p>}
          <p className="text-[11px] text-gray-400">
            Current source:{" "}
            {view.estimate
              ? view.estimate.source === "manual"
                ? `manual override${view.estimate.updated_by ? ` — ${view.estimate.updated_by}` : ""}${view.estimate.updated_at ? `, ${view.estimate.updated_at.slice(0, 10)}` : ""}`
                : "model workbook export"
              : "none yet"}
            . Saving overrides the model values for this quarter (shared with all analysts, live immediately);
            blank fields clear that value. Guidance needs both low and high.
          </p>
        </div>
      )}

      {/* Provenance line — data-through / days-into-period / period dates */}
      <p className="text-xs text-gray-500">
        <strong className="text-gray-700">Data through {view.dataThrough}</strong> · Day {view.d} of {view.D} · Period{" "}
        {view.startKey} → {view.endKey}
        {scaled && <> · scaled @ {(captureRate * 100).toFixed(1)}%</>}
        {!view.lyAvailable && <> · prior-year overlay unavailable (daily data begins {model.earliest})</>}
        {state.data?.model_vintage && (
          <>
            {" · CL model "}
            {state.data.model_vintage.workbook.replace(/^LQDT Nums /i, "").replace(/\.xlsm$/i, "")} (
            {state.data.model_vintage.as_of})
            {state.data.model_vintage.stale && (
              <span className="font-medium text-amber-600"> — stale, refresh the model export</span>
            )}
          </>
        )}
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
          value={
            yoyDisplay != null ? (
              <span className={yoyDisplay >= 0 ? "text-green-600" : "text-red-600"}>
                {fmtPct(yoyDisplay)}
                {reportedAnchor && <span className="text-gray-400">*</span>}
              </span>
            ) : (
              "—"
            )
          }
          sub={
            reportedAnchor && lyRepQtd != null
              ? `vs LY same ${view.d} days: ${fmtM(lyRepQtd)} · LY full qtr: ${fmtM(view.lyReported ?? 0)} (reported)`
              : view.lyQtd != null
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
                  {state.data?.model_vintage?.stale && <span className="text-amber-600"> (model stale)</span>}
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
          sub="trailing 7 days vs 52 weeks ago"
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

      {/* Projection toggles */}
      {!view.complete && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
          Projections:
          {(Object.keys(PROJECTION_LABEL) as ProjectionKey[]).map((k) => {
            const available = k === "shape" ? view.shapeAvailable : true;
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
                title={k === "shape" && !view.shapeAvailable ? "Needs prior-year daily data" : undefined}
              >
                {PROJECTION_LABEL[k]}
              </button>
            );
          })}
        </div>
      )}

      {/* Chart */}
      <ResponsiveContainer width="100%" height={metric === "dollars" && scaled ? 460 : 380}>
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
              {!view.complete && projections.has("runrate") && (
                <Line type="monotone" dataKey="Run rate" stroke="#6b7280" strokeWidth={1} strokeDasharray="3 3" dot={false} connectNulls />
              )}
              {/* Benchmark labels hug the right edge, tight to their own line/band:
                  Guidance at the band's top-right edge, Clearline just BELOW its
                  line, Reported just ABOVE its line — opposing nudges keep them
                  apart even though Clearline typically sits inside the band. */}
              {scaled && guidanceLow != null && guidanceHigh != null && (
                <ReferenceArea
                  y1={guidanceLow}
                  y2={guidanceHigh}
                  fill="#15803d"
                  fillOpacity={0.07}
                  stroke="#15803d"
                  strokeOpacity={0.4}
                  strokeDasharray="4 2"
                  label={{ value: `Guidance ${fmtM(guidanceLow)}–${fmtM(guidanceHigh)}`, position: "insideTopRight", fontSize: 10, fill: "#15803d", dy: -2 }}
                />
              )}
              {scaled && clearline != null && (
                <ReferenceLine
                  y={clearline}
                  stroke="#d97706"
                  strokeDasharray="5 3"
                  label={{ value: `Clearline ${fmtM(clearline)}`, position: "insideRight", fontSize: 10, fill: "#d97706", dy: 10 }}
                />
              )}
              {scaled && view.reported != null && (
                <ReferenceLine
                  y={view.reported}
                  stroke="#dc2626"
                  label={{ value: `Reported actual ${fmtM(view.reported)}`, position: "insideRight", fontSize: 10, fill: "#dc2626", dy: -7 }}
                />
              )}
            </>
          ) : (
            <>
              <ReferenceLine y={0} stroke="#9ca3af" />
              <Line type="monotone" dataKey="Cumulative Y/Y" stroke="#2563eb" strokeWidth={2.5} dot={false} />
              {/* No prior-yr-shape line here: its implied cumulative Y/Y equals the current
                  QTD Y/Y by construction, so it would restate the solid line dressed as a
                  forecast (the mosaic ODP explorer's measured conclusion; see the rows map).
                  Instead the Y/Y view gets the benchmarks that ARE informative: where the
                  external calls land the quarter, vs where the QTD pace is running. */}
              {!view.complete && projections.has("runrate") && (
                <Line type="monotone" dataKey="Run rate" stroke="#6b7280" strokeWidth={1} strokeDasharray="3 3" dot={false} connectNulls />
              )}
              {guidanceYoy != null && (
                <Line type="monotone" dataKey="Guidance mid (implied FQ Y/Y)" stroke="#15803d" strokeWidth={1.5} strokeDasharray="4 2" dot={false} connectNulls />
              )}
              {clearlineYoy != null && (
                <Line type="monotone" dataKey="Clearline (implied FQ Y/Y)" stroke="#d97706" strokeWidth={1.5} strokeDasharray="5 3" dot={false} connectNulls />
              )}
            </>
          )}
        </ComposedChart>
      </ResponsiveContainer>

      {/* Key metrics — Months & T7D vertical trend tables, then the horizontal quarter
          tape below (all pinned to the latest data, independent of the chart selector).
          Grouped in its own space-y so the header can't overlap the tables below it. */}
      <div className="space-y-3">
        <p className="text-xs font-semibold text-gray-600">
          Key metrics{" "}
          <span className="font-normal text-gray-400">
            · QTD as of {last} ({scaled ? `scaled @ ${(captureRate * 100).toFixed(1)}%` : "as captured"})
          </span>
        </p>
        <div className="grid items-start gap-3 md:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-medium text-gray-500">Months</p>
            <MetricsTable groups={[{ name: "Months", cols: monthCols }]} scale={scale} scaled={scaled} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-gray-500">T7D (trailing 7 days, week ending)</p>
            <MetricsTable groups={[{ name: "Trailing 7 days", cols: t7dCols }]} scale={scale} scaled={scaled} />
          </div>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-gray-500">
            Quarters{" "}
            <span className="text-gray-400">
              — fiscal periods across, newest at right; the live quarter (°) folds in guidance / consensus / Clearline
            </span>
          </p>
          <QuarterTape cols={tapeCols} />
        </div>
        <p className="text-xs text-gray-400">
          &ldquo;QTD Y/Y as of&rdquo; = the cumulative quarter-to-date read as it stood at each period-end (resets each fiscal
          quarter); 2Y/3Y/4Y are annualized and appear as history reaches back that far. Tape is total-company basis —
          blue = reported actual, purple = our live estimate (°), red = Clearline (e); &ldquo;—&rdquo; where prior-year data
          doesn&rsquo;t exist yet (begins {model.earliest}).
        </p>
      </div>

      {/* Model-driven sections: segments, earnings preview, transactions, supply/demand */}
      <QtdModelSections
        metricsRows={state.data?.model_metrics}
        bucketDaily={state.data?.sold_by_bucket_daily}
        selected={selected}
        currentQuarter={currentQuarter}
        estimates={model.estimates}
        siteByDate={model.siteByDate}
        viewNow={viewNow}
        captureRate={captureRate}
        listings={listings}
      />

      <DefinitionsBox />
    </div>
  );
}
