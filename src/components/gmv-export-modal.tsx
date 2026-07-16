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
 * MONTH (not quarter) so a single request stays within the app's request budget
 * even for a dense month — a quarter can exceed it. An unusually dense month that
 * still can't be served whole is binary-split further at fetch time (see
 * fetchWindow / splitWindow).
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

// If a single-window request 5xxs (the server refusing a too-large live fallback,
// or a platform 503 on a dense window), the client binary-splits the window and
// retries each half — down to single days if needed — so the data is always
// fetched as COMPLETE slices, never a value-ranked sample. A month halves to a
// single day in ≤5 levels; 6 is a safe backstop.
const MAX_SPLIT_DEPTH = 6;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Split a [from,to] day window (from < to, YYYY-MM-DD) into two disjoint halves. */
function splitWindow(win: { from: string; to: string }): [{ from: string; to: string }, { from: string; to: string }] {
  const DAY = 86_400_000;
  const startMs = Date.parse(`${win.from}T00:00:00Z`);
  const endMs = Date.parse(`${win.to}T00:00:00Z`);
  const days = Math.round((endMs - startMs) / DAY); // ≥ 1 (caller guards from < to)
  const midMs = startMs + Math.floor(days / 2) * DAY;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return [
    { from: win.from, to: day(midMs) },
    { from: day(midMs + DAY), to: win.to },
  ];
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
 * so the export doesn't lose data; a month too dense to serve whole is binary-split
 * further and retried. Date inputs are clamped to the data range.
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
      const rawParts: string[] = []; // raw mode: per-window CSV text (date-disjoint)
      const pivotMap = new Map<string, PivotRow>(); // pivot mode: merged by period×site×type×market
      const acc = { matched: 0, truncated: false };

      // Same-window retries for the whole export run (all windows share it, so a
      // hard-down backend can't stall the export for minutes across many leaves).
      let retryBudget = 6;

      // Fetch one [from,to] window and accumulate it. Failure handling, in order:
      //  • Server's deliberate range_too_large 503 (JSON code) → the window IS too
      //    dense — binary-split immediately and fetch each half as a COMPLETE
      //    slice (never a value-ranked sample).
      //  • Raw platform 5xx / connection reset → usually the replica restarting
      //    (e.g. after a heavy request killed it) — retry the SAME window once
      //    after a short pause, then split, then surface.
      //  • 502 (genuine Maestro outage) → fail fast: smaller windows hit the same
      //    dead upstream, so splitting/retrying just amplifies requests against it.
      // Recurses down to single-day windows.
      const RETRY_DELAY_MS = 3000;
      const fetchWindow = async (win: { from: string; to: string }, depth: number, label: string, attempt = 0): Promise<void> => {
        setProgress(depth === 0 ? label : `${label} — splitting dense window (${win.from}…${win.to})`);
        const params = new URLSearchParams({ mode, from: win.from, to: win.to, site, type, market });
        if (category.trim()) params.set("category", category.trim());
        if (stateFilter.trim()) params.set("state", stateFilter.trim());
        if (minUsd.trim()) params.set("minUsd", minUsd.trim());
        if (maxUsd.trim()) params.set("maxUsd", maxUsd.trim());
        if (mode === "pivot") params.set("period", period);

        const canSplit = win.from < win.to && depth < MAX_SPLIT_DEPTH;
        const winLabel = `${win.from}${win.from === win.to ? "" : `…${win.to}`}`;
        const split = async () => {
          const [a, b] = splitWindow(win);
          await fetchWindow(a, depth + 1, label);
          await fetchWindow(b, depth + 1, label);
        };
        const retrySameWindow = async () => {
          retryBudget -= 1;
          setProgress(`${label} — server hiccup, retrying ${winLabel} shortly…`);
          await sleep(RETRY_DELAY_MS);
          return fetchWindow(win, depth, label, attempt + 1);
        };

        let res: Response;
        try {
          res = await fetch(`/api/export/gmv?${params.toString()}`);
        } catch (netErr) {
          // Connection reset / network error — often the replica restarting after
          // being killed mid-response. Wait briefly and retry the same window,
          // then fall back to splitting it.
          if (attempt === 0 && retryBudget > 0) return retrySameWindow();
          if (canSplit) return split();
          throw netErr instanceof Error ? netErr : new Error(String(netErr));
        }

        if (!res.ok) {
          // Read the error body once: the server's deliberate refuse is JSON with
          // code="range_too_large"; platform errors are typically non-JSON.
          let errBody: { error?: string; code?: string } | null = null;
          try {
            errBody = await res.json();
          } catch {
            /* non-JSON (platform) error body */
          }

          if (res.status >= 500 && res.status !== 502) {
            if (errBody?.code === "range_too_large") {
              // Deterministic: the window is too dense — retrying can't help.
              if (canSplit) return split();
            } else {
              // Raw platform 5xx — likely a restarting replica: retry, then split.
              if (attempt === 0 && retryBudget > 0) return retrySameWindow();
              if (canSplit) return split();
            }
          }
          throw new Error(errBody?.error || `Export failed for ${winLabel} (${res.status})`);
        }

        // fetch() resolves once HEADERS arrive, so a replica killed mid-CSV-transfer
        // surfaces as a rejection of the BODY read, not of fetch() — guard it with
        // the same retry→split→surface handling as a pre-header reset.
        let csv: string;
        try {
          csv = await res.text();
        } catch (bodyErr) {
          if (attempt === 0 && retryBudget > 0) return retrySameWindow();
          if (canSplit) return split();
          throw bodyErr instanceof Error ? bodyErr : new Error(String(bodyErr));
        }

        // Accumulate only after the body is FULLY read — a window retried after a
        // mid-body failure must not double-count its headers.
        acc.matched += Number(res.headers.get("X-Export-Matched") ?? 0);
        if (res.headers.get("X-Export-Truncated") === "true") acc.truncated = true;

        if (mode === "raw") {
          // Windows are date-disjoint → keep the header from the first part only.
          rawParts.push(rawParts.length === 0 ? csv : csv.split("\n").slice(1).join("\n"));
        } else {
          // A period (quarter/week) can straddle window boundaries, so merge by key.
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
      };

      for (let i = 0; i < subRanges.length; i++) {
        const sr = subRanges[i];
        const label =
          subRanges.length > 1 ? `Fetching ${sr.from.slice(0, 7)} — ${i + 1} of ${subRanges.length}…` : "Fetching…";
        await fetchWindow(sr, 0, label);
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
        acc.matched === 0
          ? "No lots matched. Widen the date range or relax filters."
          : acc.truncated
            ? `Exported ${acc.matched.toLocaleString()} lots across ${span}. Some chunks hit the safety cap — coverage may be slightly partial for an unusually dense month.`
            : `Exported ${acc.matched.toLocaleString()} lots — complete coverage across ${span}.`,
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
