"use client";

import { useState } from "react";
import { downloadCsv, toCsv } from "@/lib/format";
import { formatQuarterLabel } from "@/lib/time";

const SITES = [
  { v: "all", l: "All sites" },
  { v: "AD", l: "AllSurplus" },
  { v: "GD", l: "GovDeals" },
  { v: "GI", l: "Industrial (GI)" },
];
const TYPES = [
  { v: "all", l: "All types" },
  { v: "government", l: "Government (any level)" },
  { v: "retail", l: "Retail / commercial" },
  { v: "federal", l: "— Federal only" },
  { v: "state", l: "— State only" },
  { v: "local", l: "— Local only" },
];
const MARKETS = [
  { v: "all", l: "All markets" },
  { v: "domestic", l: "Domestic (US)" },
  { v: "international", l: "International" },
];
const PERIODS = [
  { v: "day", l: "Day" },
  { v: "week", l: "Week" },
  { v: "month", l: "Month" },
  { v: "quarter", l: "Quarter" },
];

const MAX_SUBRANGES = 40; // guard: at most ~3 years of months per export

const PIVOT_COLUMNS = [
  { key: "period" as const, label: "Period" },
  { key: "site" as const, label: "Site" },
  { key: "type" as const, label: "Type" },
  { key: "market" as const, label: "Market" },
  { key: "gmv_usd" as const, label: "GMV (USD)" },
  { key: "lots" as const, label: "Lots" },
];
type PivotRow = { period: string; site: string; type: string; market: string; gmv_usd: number; lots: number };

/**
 * Calendar-month sub-ranges overlapping [from, to], each clamped. We split by
 * MONTH (not quarter) so every request stays well under the serverless timeout
 * even for a dense month — a quarter could exceed it and 504.
 */
function monthSubRanges(from: string, to: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  for (let guard = 0; guard < 480; guard++) {
    const mm = String(m).padStart(2, "0");
    const monthStart = `${y}-${mm}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month = last day of m
    const monthEnd = `${y}-${mm}-${String(lastDay).padStart(2, "0")}`;
    const subFrom = from > monthStart ? from : monthStart;
    const subTo = to < monthEnd ? to : monthEnd;
    if (subFrom <= subTo) out.push({ from: subFrom, to: subTo });
    if (monthEnd >= to) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** Parse a pivot CSV (safe columns: no embedded commas) into rows. */
function parsePivotCsv(csv: string): PivotRow[] {
  const rows: PivotRow[] = [];
  for (const line of csv.split("\n").slice(1)) {
    if (!line.trim()) continue;
    const [period, site, type, market, gmv, lots] = line.split(",");
    rows.push({
      period,
      site,
      type,
      market,
      gmv_usd: parseFloat(gmv) || 0,
      lots: parseInt(lots, 10) || 0,
    });
  }
  return rows;
}

/**
 * Analyst-facing filter panel that drives /api/export/gmv. Two actions:
 *  • Raw transactions — one row per sold lot (Excel-ready detail).
 *  • Pivot summary — GMV + lot count by period × site × type × market.
 * Wide ranges are split into per-month requests (each complete) and assembled,
 * so the export doesn't lose data. Date inputs are clamped to the data range.
 */
export function GmvExportModal({
  defaultFrom,
  defaultTo,
  minDate,
  maxDate,
  onClose,
}: {
  defaultFrom: string;
  defaultTo: string;
  minDate: string;
  maxDate: string;
  onClose: () => void;
}) {
  const clampDate = (v: string) => (!v ? v : v < minDate ? minDate : v > maxDate ? maxDate : v);

  const [from, setFrom] = useState(clampDate(defaultFrom));
  const [to, setTo] = useState(clampDate(defaultTo));
  const [site, setSite] = useState("all");
  const [type, setType] = useState("all");
  const [market, setMarket] = useState("all");
  const [category, setCategory] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [minUsd, setMinUsd] = useState("");
  const [maxUsd, setMaxUsd] = useState("");
  const [period, setPeriod] = useState("month");
  const [busy, setBusy] = useState<null | "raw" | "pivot">(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runExport = async (mode: "raw" | "pivot") => {
    setError(null);
    setNotice(null);
    setProgress(null);

    const f = clampDate(from);
    const t = clampDate(to);
    if (!f || !t || f > t) {
      setError("Pick a valid date range (start on or before end, within the data range).");
      return;
    }
    const subRanges = monthSubRanges(f, t);
    if (subRanges.length === 0) {
      setError("No valid months in the selected range.");
      return;
    }
    if (subRanges.length > MAX_SUBRANGES) {
      setError(`Range spans ${subRanges.length} months (max ${MAX_SUBRANGES}). Narrow the dates.`);
      return;
    }

    setBusy(mode);
    try {
      const rawParts: string[] = []; // raw mode: per-month CSV text (date-disjoint)
      const pivotMap = new Map<string, PivotRow>(); // pivot mode: merged by period×site×type×market
      let matched = 0;
      let truncated = false;

      for (let i = 0; i < subRanges.length; i++) {
        const sr = subRanges[i];
        if (subRanges.length > 1) setProgress(`Fetching ${sr.from.slice(0, 7)} — ${i + 1} of ${subRanges.length}…`);
        const params = new URLSearchParams({ mode, from: sr.from, to: sr.to, site, type, market });
        if (category.trim()) params.set("category", category.trim());
        if (stateFilter.trim()) params.set("state", stateFilter.trim());
        if (minUsd.trim()) params.set("minUsd", minUsd.trim());
        if (maxUsd.trim()) params.set("maxUsd", maxUsd.trim());
        if (mode === "pivot") params.set("period", period);

        const res = await fetch(`/api/export/gmv?${params.toString()}`);
        if (!res.ok) {
          let msg = `Export failed for ${sr.from.slice(0, 7)} (${res.status})`;
          try {
            const j = await res.json();
            if (j?.error) msg = j.error;
          } catch {
            /* non-JSON error body */
          }
          throw new Error(msg);
        }
        matched += Number(res.headers.get("X-Export-Matched") ?? 0);
        if (res.headers.get("X-Export-Truncated") === "true") truncated = true;

        const csv = await res.text();
        if (mode === "raw") {
          // Rows are date-disjoint across months → keep header from the first only.
          rawParts.push(rawParts.length === 0 ? csv : csv.split("\n").slice(1).join("\n"));
        } else {
          // A period (quarter/week) can straddle month boundaries, so merge by key.
          for (const r of parsePivotCsv(csv)) {
            const key = `${r.period}|${r.site}|${r.type}|${r.market}`;
            const cur = pivotMap.get(key);
            if (cur) {
              cur.gmv_usd += r.gmv_usd;
              cur.lots += r.lots;
            } else {
              pivotMap.set(key, { ...r });
            }
          }
        }
      }

      let outCsv: string;
      if (mode === "raw") {
        outCsv = rawParts.join("");
      } else {
        const rows = [...pivotMap.values()]
          .map((r) => ({ ...r, gmv_usd: Math.round(r.gmv_usd * 100) / 100 }))
          .sort(
            (a, b) =>
              a.period.localeCompare(b.period) ||
              a.site.localeCompare(b.site) ||
              a.type.localeCompare(b.type) ||
              a.market.localeCompare(b.market),
          )
          // Sort on the raw calendar key (chronological), then relabel quarter
          // periods to LQDT fiscal only (e.g. "2026Q3" -> "26FQ4"). Day/week/month
          // keys pass through unchanged.
          .map((r) => ({ ...r, period: formatQuarterLabel(r.period, "fq") }));
        outCsv = toCsv(rows, PIVOT_COLUMNS);
      }

      downloadCsv(`lqdt-gmv-${mode}-${f}_to_${t}.csv`, outCsv);
      setProgress(null);
      const span = `${subRanges.length} month${subRanges.length === 1 ? "" : "s"}`;
      setNotice(
        matched === 0
          ? "No lots matched. Widen the date range or relax filters."
          : truncated
            ? `Exported ${matched.toLocaleString()} lots across ${span}. Some chunks hit the safety cap — coverage may be slightly partial for an unusually dense month.`
            : `Exported ${matched.toLocaleString()} lots — complete coverage across ${span}.`,
      );
    } catch (e) {
      setProgress(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const field = "border rounded px-2 py-1 text-sm text-gray-900 w-full";
  const labelCls = "text-xs font-medium text-gray-600 mb-1 block";

  return (
    // No backdrop click-to-close: clicking outside must NOT dismiss the panel or
    // interrupt a running export. Close only via the ✕ button.
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="mt-10 w-full max-w-2xl rounded-lg bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold">Export GMV data</h3>
            <p className="mt-0.5 text-xs text-gray-500">
              Per-lot sold data for Excel. Filter, then export raw transactions or a pivot summary. &ldquo;Type&rdquo; is by
              seller identity (government = federal/state/local agencies; retail = commercial). Wide ranges are fetched
              per-month and combined.
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>
            <label className={labelCls}>From</label>
            <input
              type="date"
              value={from}
              min={minDate}
              max={maxDate}
              onChange={(e) => setFrom(clampDate(e.target.value))}
              className={field}
            />
          </div>
          <div>
            <label className={labelCls}>To</label>
            <input
              type="date"
              value={to}
              min={minDate}
              max={maxDate}
              onChange={(e) => setTo(clampDate(e.target.value))}
              className={field}
            />
          </div>
          <div>
            <label className={labelCls}>Site</label>
            <select value={site} onChange={(e) => setSite(e.target.value)} className={field}>
              {SITES.map((o) => (
                <option key={o.v} value={o.v}>{o.l}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Type (retail vs government)</label>
            <select value={type} onChange={(e) => setType(e.target.value)} className={field}>
              {TYPES.map((o) => (
                <option key={o.v} value={o.v}>{o.l}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Market</label>
            <select value={market} onChange={(e) => setMarket(e.target.value)} className={field}>
              {MARKETS.map((o) => (
                <option key={o.v} value={o.v}>{o.l}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Category contains</label>
            <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Vehicles" className={field} />
          </div>
          <div>
            <label className={labelCls}>State</label>
            <input value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} placeholder="e.g. CA" className={field} />
          </div>
          <div>
            <label className={labelCls}>Min $ (USD)</label>
            <input type="number" min="0" value={minUsd} onChange={(e) => setMinUsd(e.target.value)} className={field} />
          </div>
          <div>
            <label className={labelCls}>Max $ (USD)</label>
            <input type="number" min="0" value={maxUsd} onChange={(e) => setMaxUsd(e.target.value)} className={field} />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-4">
          <button
            onClick={() => runExport("raw")}
            disabled={busy !== null}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy === "raw" ? "Exporting…" : "Export raw transactions"}
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={() => runExport("pivot")}
              disabled={busy !== null}
              className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy === "pivot" ? "Exporting…" : "Export pivot summary"}
            </button>
            <label className="text-xs text-gray-500">
              by
              <select value={period} onChange={(e) => setPeriod(e.target.value)} className="ml-1 rounded border px-1 py-0.5 text-xs">
                {PERIODS.map((o) => (
                  <option key={o.v} value={o.v}>{o.l}</option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {progress && <p className="mt-3 rounded bg-blue-50 p-2 text-xs text-blue-700">{progress}</p>}
        {notice && <p className="mt-3 rounded bg-gray-50 p-2 text-xs text-gray-600">{notice}</p>}
        {error && <p className="mt-3 rounded bg-red-50 p-2 text-xs text-red-600">Error: {error}</p>}
        <p className="mt-3 text-[11px] leading-relaxed text-gray-400">
          Source: Maestro sold archive (realized hammer, USD via daily FX). Each month is fetched completely (every page),
          so totals reconcile with the GMV chart. Pivot columns: Period · Site · Type · Market · GMV · Lots
          (quarter periods are labeled as LQDT fiscal quarters, e.g. 26FQ4 — FY ends Sep 30).
        </p>
      </div>
    </div>
  );
}
