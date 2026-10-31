"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";
import type { InvaluablePayload } from "@/app/api/invaluable/route";
import { StatCard } from "@/components/qtd-shared";
import { fmtAge, fmtDollar, fmtNum, fmtPct } from "@/lib/format";
import {
  DISCLOSED,
  buildSeries,
  foldHouses,
  houseRows,
  latestClosed,
  type Grain,
  type SeriesRow,
} from "@/lib/invaluable-series";

type Range = "all" | "3y" | "2y";
/** One period of the by-house stack: period, open flag, then one value per house. */
type FoldRow = Record<string, number | string | boolean>;

// Chart palette: the dashboard's categorical slots in their fixed order (the same
// hues the Forecast tab uses), never cycled; houses past the 7th fold into Other.
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const OTHER = "#898781";
const BLUE = "#2a78d6";
const BLUE_LIGHT = "#86b6ef"; // same hue, lighter step: the loose extension of the strict figure
const ORANGE = "#eb6834";
const AQUA = "#1baf7a";
const INK = "#52514e";
const INK_MUTED = "#898781";
const GRID = "#e5e7eb";
const AXIS = "#d1d5db";
const OPEN_OPACITY = 0.45;
const TICK = { fontSize: 11, fill: "#6b7280" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const axisMoney = (v: number) =>
  Math.abs(v) >= 1e6 ? "$" + (v / 1e6).toFixed(Math.abs(v) >= 1e7 ? 0 : 1) + "M" : "$" + (v / 1e3).toFixed(0) + "k";
const axisPct = (v: number) => (v * 100).toFixed(0) + "%";
const axisYoy = (v: number) => (v > 0 ? "+" : "") + (v * 100).toFixed(0) + "%";
const signedPct = (v: number | null | undefined) => (v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%");
/** "2026Q1" -> "Q1 26", "2026-03" -> "Mar 26". */
const shortPeriod = (p: string) =>
  p.includes("Q") ? p.slice(4) + " " + p.slice(2, 4) : (MONTHS[Number(p.slice(5, 7)) - 1] ?? p.slice(5)) + " " + p.slice(2, 4);
const tone = (v: number | null | undefined) => (v == null ? "text-gray-300" : v >= 0 ? "text-green-700" : "text-red-700");

type TipKind = "money" | "pct" | "yoy";
const tipValue = (kind: TipKind, v: number) => (kind === "money" ? fmtDollar(v) : kind === "pct" ? fmtPct(v) : signedPct(v));

/** One tooltip for every chart: value first, series name second, open-period flag. */
function ChartTip({
  active,
  payload,
  label,
  kind,
  note,
  order,
}: Partial<TooltipContentProps<ValueType, NameType>> & { kind: TipKind; order?: string[]; note?: (row: Record<string, unknown>) => string | null }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as Record<string, unknown> | undefined;
  const rank = (k: unknown) => (order ? order.indexOf(String(k)) : 0);
  const lines = payload.filter((p) => typeof p.value === "number" && p.dataKey !== "disclosed").sort((a, b) => rank(a.dataKey) - rank(b.dataKey));
  const extra = row && note ? note(row) : null;
  return (
    <div className="rounded border bg-white px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-semibold text-gray-800">
        {String(label ?? row?.period ?? "")}
        {!!row?.open && <span className="ml-1 font-normal text-gray-400">open, incomplete</span>}
      </p>
      {lines.map((p) => (
        <p key={String(p.dataKey)} className="flex items-center gap-2 text-gray-700">
          <span className="inline-block h-0.5 w-3 shrink-0" style={{ background: p.color ?? INK }} />
          <span className="font-semibold tabular-nums">{tipValue(kind, Number(p.value))}</span>
          <span className="text-gray-500">{String(p.name)}</span>
        </p>
      ))}
      {extra && <p className="mt-1 text-gray-500">{extra}</p>}
    </div>
  );
}

/** Disclosed platform growth points on the Y/Y chart: a diamond with its own label. */
function DisclosedDot(props: { cx?: number; cy?: number; value?: number | null; payload?: { disclosedLabel?: string } }) {
  const { cx, cy, value, payload } = props;
  if (value == null || cx == null || cy == null) return <g />;
  const d = 6;
  return (
    <g>
      <polygon points={`${cx},${cy - d} ${cx + d},${cy} ${cx},${cy + d} ${cx - d},${cy}`} fill={INK} stroke="#fff" strokeWidth={2} />
      <text x={cx} y={cy - 11} textAnchor="middle" fontSize={10} fill={INK} stroke="#fff" strokeWidth={3} paintOrder="stroke">
        {payload?.disclosedLabel ?? ""}
      </text>
    </g>
  );
}

function ChartSection({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
      <p className="mb-2 text-xs text-gray-500">{sub}</p>
      {children}
    </section>
  );
}

function SharePanel({ name, rows, latest }: { name: string; rows: { period: string; share: number | null }[]; latest: number | null }) {
  return (
    <div className="rounded-lg border p-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate text-xs font-medium text-gray-700">{name}</p>
        <p className="text-xs tabular-nums text-gray-500">{latest == null ? "—" : fmtPct(latest)}</p>
      </div>
      <ResponsiveContainer width="100%" height={72}>
        <LineChart data={rows} margin={{ top: 8, right: 6, bottom: 2, left: 6 }}>
          <YAxis hide domain={[0, "auto"]} />
          <XAxis dataKey="period" hide />
          <Tooltip content={<ChartTip kind="pct" />} />
          <Line type="monotone" dataKey="share" name="Online share of hammer" stroke={BLUE} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Invaluable panel GMS proxy: a panel of auction houses' hosted catalogs, with each
 *  lot's online win inferred from the platform's top online bid. Online-won hammer is
 *  Invaluable's GMS definition; it enters LQDT's reported GMV from FY27 Q1. */
export function InvaluableDashboard() {
  const [data, setData] = useState<InvaluablePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grain, setGrain] = useState<Grain>("quarter");
  const [range, setRange] = useState<Range>("all");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/invaluable")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
        return d as InvaluablePayload;
      })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  const todayKey = useMemo(() => new Date().toISOString().slice(0, 10), []);
  // Every period of the grain (Y/Y needs the prior year even when it is not shown).
  const series = useMemo<SeriesRow[]>(() => (data ? buildSeries(data[grain], data.byHouse[grain], grain, todayKey) : []), [data, grain, todayKey]);
  const cutoff = range === "all" ? "" : String(Number(todayKey.slice(0, 4)) - (range === "3y" ? 3 : 2));
  const shown = useMemo(() => series.filter((r) => r.period >= cutoff), [series, cutoff]);
  // Line charts stop at the last closed period: a partial period's share is mix, not trend.
  const shareRows = useMemo(() => shown.map((r) => (r.open ? { ...r, share: null, shareLoose: null, shareTimed: null } : r)), [shown]);
  const latest = useMemo(() => latestClosed(series), [series]);
  // House order is fixed from the whole history, so a house keeps its colour across
  // grains and ranges; rows are then cut to the visible window.
  const fold = useMemo(() => (data ? foldHouses(data.byHouse[grain], series.map((r) => r.period), "online_usd", 7) : null), [data, grain, series]);
  const foldRows = useMemo(() => {
    if (!fold) return [];
    const open = new Set(series.filter((r) => r.open).map((r) => r.period));
    return fold.rows.filter((r) => String(r.period) >= cutoff).map((r): FoldRow => ({ ...r, open: open.has(String(r.period)) }));
  }, [fold, series, cutoff]);
  const houseOrder = useMemo(() => (data ? foldHouses(data.byHouse[grain], series.map((r) => r.period), "online_usd", 99).houses : []), [data, grain, series]);
  const sharePanels = useMemo(() => {
    if (!data) return [];
    const closed = shown.filter((r) => !r.open).map((r) => r.period);
    const panels = houseOrder.map((house) => {
      const byPeriod = new Map(data.byHouse[grain].filter((r) => r.house === house).map((r) => [r.period, r] as const));
      const rows = closed.map((period) => {
        const r = byPeriod.get(period);
        return { period, share: r && r.thv_usd > 0 ? r.online_usd / r.thv_usd : null };
      });
      const last = [...rows].reverse().find((r) => r.share != null);
      return { house, rows, latest: last?.share ?? null };
    });
    return panels;
  }, [data, grain, shown, houseOrder]);
  const yoyRows = useMemo(() => {
    const rows = shown.map((r) => {
      const disclosed = DISCLOSED.yoy.find((d) => d.grain === grain && d.period === r.period);
      return {
        period: r.period,
        open: r.open,
        n: r.lfl.n,
        nMedian: r.lfl.nMedian,
        online: r.lfl.onlineYoy,
        median: r.lfl.medianOnlineYoy,
        hammer: r.lfl.hammerYoy,
        disclosed: disclosed?.yoy ?? null,
        disclosedLabel: disclosed ? disclosed.label + " (disclosed)" : undefined,
      };
    });
    // Start where a Y/Y exists: the first year of history has no prior year.
    const first = rows.findIndex((r) => r.online != null || r.median != null || r.hammer != null);
    return first > 0 ? rows.slice(first) : rows;
  }, [shown, grain]);
  const latestHouses = useMemo(() => (data && latest ? houseRows(data.byHouse[grain], latest.period) : []), [data, grain, latest]);

  if (error) return <p className="mt-8 text-sm text-red-600">Invaluable panel unavailable: {error}</p>;
  if (!data) return <p className="mt-8 text-sm text-gray-500">Loading Invaluable panel…</p>;
  if (series.length === 0) return <p className="mt-8 text-sm text-gray-500">No panel data yet. Run the collector (scripts/invaluable-collect.mjs) for at least one house.</p>;

  const houseName = (key: string) => data.houseNames[key] ?? key;
  const housesWithSales = new Set(data.byHouse.quarter.map((r) => r.house)).size;
  const chip = (active: boolean) =>
    "px-2 py-0.5 text-xs rounded border transition-colors " +
    (active ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-600 border-gray-300 hover:border-gray-400");
  const periodWord = grain === "quarter" ? "quarter" : "month";
  const disclosedShareLabel = `Platform share of gavel ${fmtPct(DISCLOSED.shareOfGavel)} (Q1-26, disclosed)`;
  const lflNote = (row: Record<string, unknown>) => (Number(row.n) > 0 ? `${row.n} houses compared, same houses both years` : "no prior-year data for these houses");

  return (
    <div className="space-y-8">
      <p className="text-xs text-gray-500">
        {housesWithSales} houses · {fmtNum(data.meta.catalogs)} catalogs · {fmtNum(data.meta.lots)} lots · sales through {data.meta.collected_through ?? "—"} ·
        collected {fmtAge(data.meta.fetched_at)}. Hosted-catalog hammer in USD; a lot counts as online-won when the platform&rsquo;s top online bid equals the
        result, which is what Invaluable reports as GMS.
      </p>

      {/* Filter row: scopes every chart and table below it. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex gap-1">
          {(["quarter", "month"] as const).map((g) => (
            <button key={g} onClick={() => setGrain(g)} className={chip(grain === g)}>
              {g === "quarter" ? "Quarters" : "Months"}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {(["all", "3y", "2y"] as const).map((r) => (
            <button key={r} onClick={() => setRange(r)} className={chip(range === r)}>
              {r === "all" ? "All history" : r === "3y" ? "Last 3 years" : "Last 2 years"}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-400">Open {periodWord} drawn muted; Y/Y is like-for-like (same houses both years)</span>
      </div>

      {latest && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatCard
            label={`Online-won hammer, ${latest.period}`}
            value={fmtDollar(latest.online)}
            sub={`up to ${fmtDollar(latest.loose)} loose · ${latest.houses} houses`}
            strong
          />
          <StatCard
            label="Online share of hammer"
            value={fmtPct(latest.share)}
            sub={`loose ${fmtPct(latest.shareLoose)} · platform ${fmtPct(DISCLOSED.shareOfGavel)} (Q1-26)`}
          />
          <StatCard
            label="Online-won Y/Y, like-for-like"
            value={<span className={tone(latest.lfl.onlineYoy)}>{signedPct(latest.lfl.onlineYoy)}</span>}
            sub={`median house ${signedPct(latest.lfl.medianOnlineYoy)} · ${latest.lfl.n} houses`}
          />
          <StatCard
            label="Hammer Y/Y, like-for-like"
            value={<span className={tone(latest.lfl.hammerYoy)}>{signedPct(latest.lfl.hammerYoy)}</span>}
            sub={`${latest.lfl.n} houses · timed sales ${fmtPct(latest.shareTimed)} of hammer`}
          />
          <StatCard
            label="Sold lots in the period"
            value={fmtNum(latest.sold)}
            sub={`hammer ${fmtDollar(latest.thv)} across the panel`}
          />
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-2">
        <ChartSection
          title="Online-won hammer (GMS proxy)"
          sub="Strict: top online bid equals the result and at least one online bid. The lighter cap extends to the loose upper bound (equality alone)."
        >
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={shown} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="period" tick={TICK} tickFormatter={shortPeriod} axisLine={{ stroke: AXIS }} tickLine={false} minTickGap={16} />
              <YAxis tick={TICK} tickFormatter={axisMoney} axisLine={false} tickLine={false} width={52} />
              <Tooltip content={<ChartTip kind="money" order={["online", "looseExtra"]} note={(r) => `${r.houses} houses · ${fmtNum(Number(r.sold))} sold lots · hammer ${fmtDollar(Number(r.thv))}`} />} />
              <Legend wrapperStyle={{ fontSize: 11 }} iconSize={10} itemSorter={null} />
              <Bar dataKey="online" name="Online-won, strict" stackId="g" fill={BLUE} maxBarSize={24} isAnimationActive={false}>
                {shown.map((r) => (
                  <Cell key={r.period} fillOpacity={r.open ? OPEN_OPACITY : 1} />
                ))}
              </Bar>
              <Bar dataKey="looseExtra" name="to loose upper bound" stackId="g" fill={BLUE_LIGHT} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false}>
                {shown.map((r) => (
                  <Cell key={r.period} fillOpacity={r.open ? OPEN_OPACITY : 1} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartSection>

        <ChartSection
          title="Online share of hammer"
          sub="Online-won divided by all hammer. Regional houses run well below the platform-wide share, so levels are not comparable; the trend is."
        >
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={shareRows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="period" tick={TICK} tickFormatter={shortPeriod} axisLine={{ stroke: AXIS }} tickLine={false} minTickGap={16} />
              <YAxis tick={TICK} tickFormatter={axisPct} axisLine={false} tickLine={false} width={40} domain={[0, (max: number) => Math.max(max, DISCLOSED.shareOfGavel) * 1.1]} />
              <Tooltip content={<ChartTip kind="pct" order={["share", "shareLoose", "shareTimed"]} />} />
              <Legend wrapperStyle={{ fontSize: 11 }} iconType="plainline" iconSize={12} itemSorter={null} />
              <ReferenceLine y={DISCLOSED.shareOfGavel} stroke={INK_MUTED} strokeDasharray="4 2" label={{ value: disclosedShareLabel, position: "insideTopLeft", fontSize: 10, fill: INK }} />
              <Line type="monotone" dataKey="share" name="Online share, strict" stroke={BLUE} strokeWidth={2} dot={grain === "quarter" ? { r: 4, fill: BLUE, stroke: "#fff", strokeWidth: 2 } : false} activeDot={{ r: 5 }} isAnimationActive={false} />
              <Line type="monotone" dataKey="shareLoose" name="Online share, loose" stroke={BLUE_LIGHT} strokeWidth={2} dot={false} activeDot={{ r: 5 }} isAnimationActive={false} />
              <Line type="monotone" dataKey="shareTimed" name="Timed-sale share of hammer" stroke={INK_MUTED} strokeWidth={1.5} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartSection>
      </div>

      <ChartSection
        title="Like-for-like Y/Y"
        sub="Only houses with sales in both the period and its prior-year period, so a house joining the panel never reads as growth. The median house is the equal-weight view; diamonds are what Invaluable disclosed for the whole platform."
      >
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={yoyRows} margin={{ top: 16, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="period" tick={TICK} tickFormatter={shortPeriod} axisLine={{ stroke: AXIS }} tickLine={false} minTickGap={16} />
            <YAxis tick={TICK} tickFormatter={axisYoy} axisLine={false} tickLine={false} width={48} />
            <Tooltip content={<ChartTip kind="yoy" order={["online", "median", "hammer"]} note={lflNote} />} />
            <Legend wrapperStyle={{ fontSize: 11 }} iconType="plainline" iconSize={12} itemSorter={null} />
            <ReferenceLine y={0} stroke={AXIS} />
            <Line type="monotone" dataKey="online" name="Online-won Y/Y, dollar-weighted" stroke={BLUE} strokeWidth={2} dot={grain === "quarter" ? { r: 4, fill: BLUE, stroke: "#fff", strokeWidth: 2 } : false} activeDot={{ r: 5 }} isAnimationActive={false} connectNulls={false} />
            <Line type="monotone" dataKey="median" name="Online-won Y/Y, median house" stroke={ORANGE} strokeWidth={2} dot={grain === "quarter" ? { r: 4, fill: ORANGE, stroke: "#fff", strokeWidth: 2 } : false} activeDot={{ r: 5 }} isAnimationActive={false} connectNulls={false} />
            <Line type="monotone" dataKey="hammer" name="Hammer Y/Y" stroke={AQUA} strokeWidth={2} dot={grain === "quarter" ? { r: 4, fill: AQUA, stroke: "#fff", strokeWidth: 2 } : false} activeDot={{ r: 5 }} isAnimationActive={false} connectNulls={false} />
            <Line dataKey="disclosed" name="Invaluable disclosed GMS Y/Y (platform)" stroke="none" dot={<DisclosedDot />} activeDot={false} legendType="diamond" isAnimationActive={false} connectNulls={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartSection>

      {fold && (
        <ChartSection
          title="Online-won hammer by house"
          sub={`The ${Math.min(7, houseOrder.length)} largest houses by online-won hammer over the whole history; the rest fold into Other. Who carries the proxy, and how concentrated it is.`}
        >
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={foldRows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="period" tick={TICK} tickFormatter={shortPeriod} axisLine={{ stroke: AXIS }} tickLine={false} minTickGap={16} />
              <YAxis tick={TICK} tickFormatter={axisMoney} axisLine={false} tickLine={false} width={52} />
              <Tooltip content={<ChartTip kind="money" order={fold.houses} />} />
              <Legend wrapperStyle={{ fontSize: 11 }} iconSize={10} itemSorter={null} />
              {fold.houses.map((h, i) => (
                <Bar
                  key={h}
                  dataKey={h}
                  name={h === "Other" ? "Other houses" : houseName(h)}
                  stackId="h"
                  fill={h === "Other" ? OTHER : SERIES[i]}
                  stroke="#fff"
                  strokeWidth={1}
                  maxBarSize={24}
                  radius={i === fold.houses.length - 1 ? [4, 4, 0, 0] : undefined}
                  isAnimationActive={false}
                >
                  {foldRows.map((r) => (
                    <Cell key={String(r.period)} fillOpacity={r.open ? OPEN_OPACITY : 1} />
                  ))}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartSection>
      )}

      {sharePanels.length > 0 && (
        <ChartSection
          title="Online share by house"
          sub={`Closed ${periodWord}s only, each panel on its own scale with its latest share at the right. A low-share house ramping its online channel adds growth the platform (already at ${fmtPct(DISCLOSED.shareOfGavel)}) does not get, which is why the panel's Y/Y runs above Invaluable's.`}
        >
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4">
            {sharePanels.map((p) => (
              <SharePanel key={p.house} name={houseName(p.house)} rows={p.rows} latest={p.latest} />
            ))}
          </div>
        </ChartSection>
      )}

      <div className="grid gap-8 lg:grid-cols-[2fr_1fr]">
        <section>
          <h3 className="text-sm font-semibold text-gray-800">Panel by {periodWord}</h3>
          <p className="mb-2 text-xs text-gray-500">Every value in the charts above. Share = online-won ÷ hammer; loose = the same without the bid-count guard; LFL = houses compared.</p>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b bg-gray-50 text-gray-600">
                  <th className="px-2 py-1 text-left font-semibold">Period</th>
                  <th className="px-2 py-1 text-right font-semibold">Houses</th>
                  <th className="px-2 py-1 text-right font-semibold">Sold lots</th>
                  <th className="px-2 py-1 text-right font-semibold">Hammer</th>
                  <th className="px-2 py-1 text-right font-semibold">Online-won</th>
                  <th className="px-2 py-1 text-right font-semibold">Share</th>
                  <th className="px-2 py-1 text-right font-semibold">Loose</th>
                  <th className="px-2 py-1 text-right font-semibold">Timed</th>
                  <th className="px-2 py-1 text-right font-semibold">Hammer Y/Y</th>
                  <th className="px-2 py-1 text-right font-semibold">Online-won Y/Y</th>
                  <th className="px-2 py-1 text-right font-semibold">Median house</th>
                  <th className="px-2 py-1 text-right font-semibold">LFL</th>
                </tr>
              </thead>
              <tbody>
                {[...shown].reverse().map((r) => (
                  <tr key={r.period} className="border-b border-gray-100">
                    <td className="px-2 py-1 font-medium text-gray-700">
                      {r.period}
                      {r.open && <span className="ml-1 text-[10px] text-gray-400">open</span>}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">{r.houses}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{fmtNum(r.sold)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{fmtDollar(r.thv)}</td>
                    <td className="px-2 py-1 text-right tabular-nums font-semibold">{fmtDollar(r.online)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{fmtPct(r.share)}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-500">{fmtPct(r.shareLoose)}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-500">{fmtPct(r.shareTimed)}</td>
                    <td className={"px-2 py-1 text-right tabular-nums " + tone(r.lfl.hammerYoy)}>{signedPct(r.lfl.hammerYoy)}</td>
                    <td className={"px-2 py-1 text-right tabular-nums " + tone(r.lfl.onlineYoy)}>{signedPct(r.lfl.onlineYoy)}</td>
                    <td className={"px-2 py-1 text-right tabular-nums " + tone(r.lfl.medianOnlineYoy)}>{signedPct(r.lfl.medianOnlineYoy)}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-400">{r.lfl.n || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {latest && (
          <section>
            <h3 className="text-sm font-semibold text-gray-800">Houses, {latest.period}</h3>
            <p className="mb-2 text-xs text-gray-500">Each house against its own prior year.</p>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b bg-gray-50 text-gray-600">
                    <th className="px-2 py-1 text-left font-semibold">House</th>
                    <th className="px-2 py-1 text-right font-semibold">Hammer</th>
                    <th className="px-2 py-1 text-right font-semibold">Online-won</th>
                    <th className="px-2 py-1 text-right font-semibold">Share</th>
                    <th className="px-2 py-1 text-right font-semibold">Online Y/Y</th>
                  </tr>
                </thead>
                <tbody>
                  {latestHouses.map((h) => (
                    <tr key={h.house} className="border-b border-gray-100">
                      <td className="px-2 py-1 font-medium text-gray-700">
                        <span className="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: fold && fold.houses.includes(h.house) ? SERIES[fold.houses.indexOf(h.house)] : OTHER }} />
                        {houseName(h.house)}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtDollar(h.thv)}</td>
                      <td className="px-2 py-1 text-right tabular-nums font-semibold">{fmtDollar(h.online)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtPct(h.share)}</td>
                      <td className={"px-2 py-1 text-right tabular-nums " + tone(h.onlineYoy)}>{signedPct(h.onlineYoy)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>

      <section className="max-w-3xl text-xs text-gray-500">
        <h3 className="text-sm font-semibold text-gray-800">How to read this</h3>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>
            The proxy is a growth index, not a level. The panel is a dozen regional houses at {fmtPct(latest?.share)} online share against the platform&rsquo;s{" "}
            {fmtPct(DISCLOSED.shareOfGavel)}, and its share of the platform is unknown.
          </li>
          <li>
            Direction and momentum transfer; the growth rate overstates platform GMS while these houses keep ramping their online share (a low base rising 1&ndash;2 points a year is
            +25&ndash;40% on its own). Read the median house, not the dollar-weighted line, when one house swings.
          </li>
          <li>Strict is the published figure; loose is the ceiling if lots with no online bid at the opening price also went online. Timed sales are online by construction.</li>
          <li>Disclosed reference points: CY2025 GMS above $500M; Q1-26 GMS $125M, +17% Y/Y, 14.7% share of gavel; May-26 net GMS +20%. The FY27 Q1 release (Nov 19) is the first calibration target.</li>
        </ul>
      </section>
    </div>
  );
}
