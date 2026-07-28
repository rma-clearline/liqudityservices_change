"use client";

import { useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import type { ListingRow } from "@/lib/supabase";
import { lqdtFiscalQuarter } from "@/lib/time";

type ChartRow = {
  label: string;
  AllSurplus: number | null;
  GovDeals: number | null;
  "AS YoY %": number | null;
  "GD YoY %": number | null;
};

function buildChartData(filtered: ListingRow[], allData: ListingRow[]): ChartRow[] {
  const byDate = new Map<string, ListingRow>();
  for (const row of allData) {
    if (!byDate.has(row.date)) byDate.set(row.date, row);
  }

  function yearAgoDate(d: string): string {
    const dt = new Date(d + "T00:00:00");
    dt.setFullYear(dt.getFullYear() - 1);
    return dt.toISOString().slice(0, 10);
  }

  function findNearby(target: string): ListingRow | null {
    const exact = byDate.get(target);
    if (exact) return exact;
    for (let offset = 1; offset <= 7; offset++) {
      const d = new Date(target + "T00:00:00");
      d.setDate(d.getDate() - offset);
      const key = d.toISOString().slice(0, 10);
      const found = byDate.get(key);
      if (found) return found;
      const d2 = new Date(target + "T00:00:00");
      d2.setDate(d2.getDate() + offset);
      const key2 = d2.toISOString().slice(0, 10);
      const found2 = byDate.get(key2);
      if (found2) return found2;
    }
    return null;
  }

  const chronological = [...filtered].reverse();
  return chronological.map((row) => {
    const ya = yearAgoDate(row.date);
    const prev = findNearby(ya);

    let asYoY: number | null = null;
    let gdYoY: number | null = null;

    if (prev && row.allsurplus != null && prev.allsurplus != null && prev.allsurplus > 0) {
      asYoY = Math.round(((row.allsurplus - prev.allsurplus) / prev.allsurplus) * 1000) / 10;
    }
    if (prev && row.govdeals != null && prev.govdeals != null && prev.govdeals > 0) {
      gdYoY = Math.round(((row.govdeals - prev.govdeals) / prev.govdeals) * 1000) / 10;
    }

    return {
      label: row.date,
      AllSurplus: row.allsurplus,
      GovDeals: row.govdeals,
      "AS YoY %": asYoY,
      "GD YoY %": gdYoY,
    };
  });
}

const toMs = (d: string) => Date.parse(d + "T00:00:00Z");

/** Calendar quarter-end date (YYYY-MM-DD) for a year + quarter (1..4). */
function quarterEndOf(year: number, q: number): string {
  const m = q * 3; // 3, 6, 9, 12
  const lastDay = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return `${year}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

/** "2025-03-31" → "3/31/25" for compact x-axis ticks. */
function fmtTickDate(v: string): string {
  const [y, m, d] = v.split("-");
  return `${Number(m)}/${Number(d)}/${y.slice(2)}`;
}

/** Second-row x-axis tick: the quarter label centered under each quarter, showing
 *  BOTH the calendar quarter (top) and LQDT's fiscal quarter (below, muted), since
 *  the FY ends 9/30 so they differ. Recharts injects x/y/payload; `labels` maps a
 *  data label → its { cq, fq } text. */
function QuarterTick(props: { x?: number; y?: number; payload?: { value?: string }; labels?: Map<string, { cq: string; fq: string }> }) {
  const { x = 0, y = 0, payload, labels } = props;
  const t = labels?.get(payload?.value ?? "");
  if (!t) return null;
  return (
    <text x={x} y={y + 11} textAnchor="middle">
      <tspan x={x} fontSize={11} fontWeight={600} fill="#374151">{t.cq}</tspan>
      <tspan x={x} dy={12} fontSize={9} fill="#9ca3af">{t.fq}</tspan>
    </text>
  );
}

export function ListingsChart({ data, allData }: { data: ListingRow[]; allData: ListingRow[] }) {
  const chartData = useMemo(() => buildChartData(data, allData), [data, allData]);

  // X-axis ticks: date ticks at every quarter-end (+ the range endpoints) on the
  // primary axis, and a second row of centered quarter labels ("Q1 '25"). Explicit
  // ticks — no `preserveStartEnd` — so switching ranges can't leave uneven/cramped
  // labels on the right edge.
  const { primaryTicks, quarterEndTicks, quarterMidLabels, quarterLabelMap } = useMemo(() => {
    const labels = chartData.map((r) => r.label);
    if (labels.length === 0) {
      return {
        primaryTicks: [] as string[],
        quarterEndTicks: [] as string[],
        quarterMidLabels: [] as string[],
        quarterLabelMap: new Map<string, { cq: string; fq: string }>(),
      };
    }
    const first = labels[0];
    const last = labels[labels.length - 1];
    const nearest = (target: string) => {
      const t = toMs(target);
      let best = first;
      let bd = Infinity;
      for (const l of labels) {
        const diff = Math.abs(toMs(l) - t);
        if (diff < bd) {
          bd = diff;
          best = l;
        }
      }
      return best;
    };
    const qEnds: string[] = [];
    const midLabels: string[] = [];
    const labelMap = new Map<string, { cq: string; fq: string }>();
    let y = Number(first.slice(0, 4));
    let q = Math.floor((Number(first.slice(5, 7)) - 1) / 3) + 1;
    for (let guard = 0; guard < 80; guard++) {
      const qStart = `${y}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`;
      if (qStart > last) break;
      const qEnd = quarterEndOf(y, q);
      if (qEnd >= first && qEnd <= last) {
        const t = nearest(qEnd);
        if (!qEnds.includes(t)) qEnds.push(t);
      }
      // Quarter label at the data point nearest the quarter midpoint, clamped to
      // the visible range so edge quarters still get a (shifted) label.
      let mid = `${y}-${String((q - 1) * 3 + 2).padStart(2, "0")}-15`;
      if (mid < first) mid = first;
      if (mid > last) mid = last;
      const ml = nearest(mid);
      if (!labelMap.has(ml)) {
        const { fy, fq } = lqdtFiscalQuarter(y, q);
        labelMap.set(ml, { cq: `CQ${q} '${String(y).slice(2)}`, fq: `FQ${fq} '${String(fy).slice(2)}` });
        midLabels.push(ml);
      }
      q++;
      if (q > 4) {
        q = 1;
        y++;
      }
    }
    const primary = Array.from(new Set([first, ...qEnds, last])).sort((a, b) => toMs(a) - toMs(b));
    return { primaryTicks: primary, quarterEndTicks: qEnds, quarterMidLabels: midLabels, quarterLabelMap: labelMap };
  }, [chartData]);

  if (chartData.length === 0) {
    return <p className="text-gray-500 text-center py-8">No data yet.</p>;
  }

  const hasYoY = chartData.some((r) => r["AS YoY %"] != null || r["GD YoY %"] != null);

  return (
    <ResponsiveContainer width="100%" height={600}>
      <LineChart data={chartData} margin={{ top: 5, right: hasYoY ? 60 : 20, bottom: 5, left: 20 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        {/* Primary axis: dates at quarter ends (+ range endpoints). */}
        <XAxis dataKey="label" ticks={primaryTicks} interval={0} tickFormatter={fmtTickDate} tick={{ fontSize: 11 }} height={22} />
        {/* Second axis row: quarter labels centered in each quarter. */}
        <XAxis
          dataKey="label"
          xAxisId="quarter"
          ticks={quarterMidLabels}
          interval={0}
          tickLine={false}
          axisLine={false}
          height={34}
          tick={<QuarterTick labels={quarterLabelMap} />}
        />
        <YAxis
          yAxisId="left"
          tickFormatter={(v: number) => (v / 1000).toFixed(0) + "k"}
          tick={{ fontSize: 12 }}
        />
        {hasYoY && (
          <YAxis
            yAxisId="right"
            orientation="right"
            tickFormatter={(v: number) => v + "%"}
            tick={{ fontSize: 12 }}
          />
        )}
        {/* Quarter-boundary gridlines — light-grey dotted verticals at each quarter
            cutoff. Bound to yAxisId="left" and placed AFTER the axes: the chart has no
            default id-0 y-axis, so an unbound ReferenceLine silently fails to render. */}
        {quarterEndTicks.map((t) => (
          <ReferenceLine key={t} x={t} yAxisId="left" stroke="#cbd5e1" strokeDasharray="4 3" strokeWidth={1} />
        ))}
        <Tooltip
          formatter={(v, name) =>
            typeof v === "number"
              ? (String(name).includes("YoY") ? v + "%" : v.toLocaleString())
              : v
          }
        />
        <Legend />
        <Line yAxisId="left" type="monotone" dataKey="AllSurplus" stroke="#2563eb" strokeWidth={2} dot={false} connectNulls />
        <Line yAxisId="left" type="monotone" dataKey="GovDeals" stroke="#16a34a" strokeWidth={2} dot={false} connectNulls />
        {hasYoY && (
          <>
            <Line yAxisId="right" type="monotone" dataKey="AS YoY %" stroke="#93c5fd" strokeWidth={1.5} strokeDasharray="4 2" dot={false} connectNulls />
            <Line yAxisId="right" type="monotone" dataKey="GD YoY %" stroke="#86efac" strokeWidth={1.5} strokeDasharray="4 2" dot={false} connectNulls />
          </>
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}
