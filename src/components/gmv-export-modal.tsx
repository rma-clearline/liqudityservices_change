"use client";

import { useState } from "react";
import { downloadCsv } from "@/lib/format";
import { enumerateQuarterLabelsBetween, etQuarterKey, parseQuarterLabel } from "@/lib/time";

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

const MAX_SUBRANGES = 12; // guard: at most ~3 years of quarters per export

/**
 * Quarter sub-ranges overlapping [from, to], each clamped to [from, to]. Quarters
 * are date-disjoint, so each request is bounded (≈1 quarter → complete in one
 * call) and the per-quarter CSVs concatenate with no cross-quarter duplicates.
 */
function quarterSubRanges(from: string, to: string): { from: string; to: string }[] {
  const labels = enumerateQuarterLabelsBetween(etQuarterKey(from), etQuarterKey(to));
  const out: { from: string; to: string }[] = [];
  for (const label of labels) {
    const q = parseQuarterLabel(label);
    if (!q) continue;
    const qStart = q.start.toISOString().slice(0, 10);
    const qLast = new Date(q.end.getTime() - 86_400_000).toISOString().slice(0, 10); // last day of quarter
    const subFrom = from > qStart ? from : qStart;
    const subTo = to < qLast ? to : qLast;
    if (subFrom <= subTo) out.push({ from: subFrom, to: subTo });
  }
  return out;
}

/**
 * Analyst-facing filter panel that drives /api/export/gmv. Two actions:
 *  • Raw transactions — one row per sold lot (Excel-ready detail).
 *  • Pivot summary — GMV + lot count by period × site × type × market.
 * Wide ranges are split into per-quarter requests (each complete) and assembled,
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
    const subRanges = quarterSubRanges(f, t);
    if (subRanges.length === 0) {
      setError("No valid quarters in the selected range.");
      return;
    }
    if (subRanges.length > MAX_SUBRANGES) {
      setError(`Range spans ${subRanges.length} quarters (max ${MAX_SUBRANGES}). Narrow the dates.`);
      return;
    }

    setBusy(mode);
    try {
      const parts: string[] = [];
      let matched = 0;
      let truncated = false;

      for (let i = 0; i < subRanges.length; i++) {
        const sr = subRanges[i];
        if (subRanges.length > 1) setProgress(`Fetching ${etQuarterKey(sr.from)} — ${i + 1} of ${subRanges.length}…`);
        const params = new URLSearchParams({ mode, from: sr.from, to: sr.to, site, type, market });
        if (category.trim()) params.set("category", category.trim());
        if (stateFilter.trim()) params.set("state", stateFilter.trim());
        if (minUsd.trim()) params.set("minUsd", minUsd.trim());
        if (maxUsd.trim()) params.set("maxUsd", maxUsd.trim());
        if (mode === "pivot") params.set("period", period);

        const res = await fetch(`/api/export/gmv?${params.toString()}`);
        if (!res.ok) {
          let msg = `Export failed for ${etQuarterKey(sr.from)} (${res.status})`;
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
        // Keep the header only from the first part; later parts contribute rows.
        parts.push(i === 0 ? csv : csv.split("\n").slice(1).join("\n"));
      }

      downloadCsv(`lqdt-gmv-${mode}-${f}_to_${t}.csv`, parts.join(""));
      setProgress(null);
      const span = `${subRanges.length} quarter${subRanges.length === 1 ? "" : "s"}`;
      setNotice(
        matched === 0
          ? "No lots matched. Widen the date range or relax filters."
          : truncated
            ? `Exported ${matched.toLocaleString()} lots across ${span}. Some chunks hit the safety cap — coverage may be slightly partial for an unusually dense quarter.`
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
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div className="mt-10 w-full max-w-2xl rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold">Export GMV data</h3>
            <p className="mt-0.5 text-xs text-gray-500">
              Per-lot sold data for Excel. Filter, then export raw transactions or a pivot summary. &ldquo;Type&rdquo; is by
              seller identity (government = federal/state/local agencies; retail = commercial). Wide ranges are fetched
              per-quarter and combined.
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
          Source: Maestro sold archive (realized hammer, USD via daily FX). Each quarter is fetched completely (every page),
          so totals reconcile with the GMV chart. Pivot columns: Period · Site · Type · Market · GMV · Lots.
        </p>
      </div>
    </div>
  );
}
