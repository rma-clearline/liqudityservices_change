// LQDT's total REPORTED (company-wide) GMV by calendar quarter — the benchmark the
// scraped/projected GMV is compared against — plus company guidance and the
// Clearline model's estimates. Sourced from the financial model via
// `scripts/extract-reported-gmv.mjs`. The CSVs are GITIGNORED (model-derived data
// never enters the repo): local dev reads them from `scripts/`; prod reads them
// from Container App secret files (env path overrides, pushed by
// `scripts/push-model-data.mjs`). Absent files just disable the overlays.
//
// Quarters are calendar "YYYYQn" keys (aligned to the chart's bucket keys); the UI
// renders the dual CQ/FQ label. Amounts are USD (the extractor converts the model's
// $000 to dollars). This is a small fixed series, so it's module-cached.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { getModelEstimateOverrides, isAzureSqlConfigured } from "@/lib/azure-sql";

export type ReportedQuarterGmv = { quarter: string; reported_gmv_usd: number };

/** Company guidance + the Clearline model's own GMV estimate for a quarter
 *  (whichever the model carries — either side may be absent). `source` says where
 *  the row came from: the model-workbook export or an analyst's manual override. */
export type ModelQuarterEstimate = {
  quarter: string;
  guidance_low_usd: number | null;
  guidance_high_usd: number | null;
  clearline_estimate_usd: number | null;
  source?: "model" | "manual";
  updated_by?: string | null;
  updated_at?: string | null;
};

/** One quarterly model metric in long format (see the extractor's METRIC_ROWS
 *  registry for the key vocabulary: govdeals_gmv, total_take_rate, revenue,
 *  eps_guidance_low, ...). Values are base units — USD, fraction, count, or $
 *  per share depending on the metric. `kind` says whether the model column was
 *  a reported actual or the model's own forecast. */
export type ModelMetricRow = {
  quarter: string;
  metric: string;
  value: number;
  kind: "reported" | "forecast";
};

const REPORTED_GMV_PATH =
  process.env.REPORTED_GMV_QUARTERLY_PATH ||
  path.join(process.cwd(), "scripts", "reported-gmv-quarterly.csv");
const MODEL_ESTIMATES_PATH =
  process.env.MODEL_ESTIMATES_QUARTERLY_PATH ||
  path.join(process.cwd(), "scripts", "model-estimates-quarterly.csv");
const MODEL_METRICS_PATH =
  process.env.MODEL_METRICS_QUARTERLY_PATH ||
  path.join(process.cwd(), "scripts", "model-metrics-quarterly.csv");

let cached: ReportedQuarterGmv[] | null = null;
let cachedEstimates: ModelQuarterEstimate[] | null = null;
let cachedMetrics: ModelMetricRow[] | null = null;

/** The prod files arrive as base64-encoded Container App secrets (base64 survives
 *  CLI quoting; raw multi-line CSVs don't). Local dev reads the plain CSVs. */
function decodeMaybeBase64(raw: string): string {
  const head = raw.slice(0, 200);
  if (head.includes(",")) return raw; // plain CSV (header row has commas)
  try {
    return Buffer.from(raw.trim(), "base64").toString("utf8");
  } catch {
    return raw;
  }
}

/** Reported total-company GMV per calendar quarter, chronological. `[]` if the CSV
 *  is absent (the app runs fine without the benchmark overlay). */
export async function loadReportedQuarterlyGmv(): Promise<ReportedQuarterGmv[]> {
  if (cached) return cached;
  const out: ReportedQuarterGmv[] = [];
  try {
    const raw = decodeMaybeBase64(await readFile(REPORTED_GMV_PATH, "utf8"));
    for (const line of raw.trim().split(/\r?\n/).slice(1)) {
      // Columns: quarter,quarter_end,reported_gmv_usd (no quoted fields).
      const [quarter, , gmvRaw] = line.split(",");
      if (!/^\d{4}Q[1-4]$/.test(quarter ?? "")) continue;
      const gmv = Number(gmvRaw);
      if (!Number.isFinite(gmv) || gmv <= 0) continue;
      out.push({ quarter, reported_gmv_usd: gmv });
    }
    out.sort((a, b) => a.quarter.localeCompare(b.quarter));
  } catch {
    // No committed CSV -> no benchmark overlay; the rest of the app is unaffected.
  }
  cached = out;
  return out;
}

/** Company guidance + Clearline model GMV estimates per calendar quarter,
 *  chronological. `[]` if the CSV is absent. Same extractor/CSV pipeline as the
 *  reported series (`scripts/extract-reported-gmv.mjs`). */
export async function loadModelEstimates(): Promise<ModelQuarterEstimate[]> {
  if (cachedEstimates) return cachedEstimates;
  const out: ModelQuarterEstimate[] = [];
  try {
    const raw = decodeMaybeBase64(await readFile(MODEL_ESTIMATES_PATH, "utf8"));
    for (const line of raw.trim().split(/\r?\n/).slice(1)) {
      // Columns: quarter,quarter_end,guidance_low_usd,guidance_high_usd,clearline_estimate_usd
      const [quarter, , lowRaw, highRaw, clRaw] = line.split(",");
      if (!/^\d{4}Q[1-4]$/.test(quarter ?? "")) continue;
      const num = (s: string | undefined) => {
        const n = Number(s);
        return s !== "" && s != null && Number.isFinite(n) && n > 0 ? n : null;
      };
      const row: ModelQuarterEstimate = {
        quarter,
        guidance_low_usd: num(lowRaw),
        guidance_high_usd: num(highRaw),
        clearline_estimate_usd: num(clRaw),
      };
      if (row.guidance_low_usd || row.guidance_high_usd || row.clearline_estimate_usd) out.push(row);
    }
    out.sort((a, b) => a.quarter.localeCompare(b.quarter));
  } catch {
    // No committed CSV -> no guidance/estimate overlay; the rest of the app is unaffected.
  }
  cachedEstimates = out;
  return out;
}

/** Long-format quarterly model metrics (segments, take rates, P&L, guidance
 *  ranges, operating stats), chronological. `[]` if the CSV is absent. Unlike the
 *  other loaders, zero/negative values are kept — EPS and beat_vs_mid can be
 *  legitimately negative. */
export async function loadModelMetrics(): Promise<ModelMetricRow[]> {
  if (cachedMetrics) return cachedMetrics;
  const out: ModelMetricRow[] = [];
  try {
    const raw = decodeMaybeBase64(await readFile(MODEL_METRICS_PATH, "utf8"));
    for (const line of raw.trim().split(/\r?\n/).slice(1)) {
      // Columns: quarter,quarter_end,metric,value,kind (no quoted fields).
      const [quarter, , metric, valueRaw, kind] = line.split(",");
      if (!/^\d{4}Q[1-4]$/.test(quarter ?? "")) continue;
      if (!/^[a-z0-9_]+$/.test(metric ?? "")) continue;
      if (kind !== "reported" && kind !== "forecast") continue;
      const value = Number(valueRaw);
      if (!Number.isFinite(value)) continue;
      out.push({ quarter, metric, value, kind });
    }
    out.sort((a, b) => a.quarter.localeCompare(b.quarter) || a.metric.localeCompare(b.metric));
  } catch {
    // No CSV -> the QTD model sections render without model columns.
  }
  cachedMetrics = out;
  return out;
}

/**
 * Model-file estimates merged with analyst overrides from `lqdt.model_estimates`
 * (Azure SQL — the app owns the schema and bootstraps the table itself). A DB row
 * REPLACES that quarter's file values wholesale, so an analyst can also blank a
 * field. Queried per call (tiny table, warm S2) so saves show up immediately; DB
 * errors degrade to file-only.
 */
export async function loadModelEstimatesMerged(): Promise<ModelQuarterEstimate[]> {
  const file = await loadModelEstimates();
  const map = new Map<string, ModelQuarterEstimate>(file.map((e) => [e.quarter, { ...e, source: "model" as const }]));
  if (isAzureSqlConfigured()) {
    try {
      for (const row of await getModelEstimateOverrides()) {
        if (!/^\d{4}Q[1-4]$/.test(row.quarter)) continue;
        map.set(row.quarter, {
          quarter: row.quarter,
          guidance_low_usd: row.guidance_low_usd,
          guidance_high_usd: row.guidance_high_usd,
          clearline_estimate_usd: row.clearline_estimate_usd,
          source: "manual",
          updated_by: row.updated_by,
          updated_at: row.updated_at,
        });
      }
    } catch {
      // DB unreachable -> model-file values only.
    }
  }
  return [...map.values()].sort((a, b) => a.quarter.localeCompare(b.quarter));
}
