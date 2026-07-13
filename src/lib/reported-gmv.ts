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

export type ReportedQuarterGmv = { quarter: string; reported_gmv_usd: number };

/** Company guidance + the Clearline model's own GMV estimate for a quarter
 *  (whichever the model carries — either side may be absent). */
export type ModelQuarterEstimate = {
  quarter: string;
  guidance_low_usd: number | null;
  guidance_high_usd: number | null;
  clearline_estimate_usd: number | null;
};

const REPORTED_GMV_PATH =
  process.env.REPORTED_GMV_QUARTERLY_PATH ||
  path.join(process.cwd(), "scripts", "reported-gmv-quarterly.csv");
const MODEL_ESTIMATES_PATH =
  process.env.MODEL_ESTIMATES_QUARTERLY_PATH ||
  path.join(process.cwd(), "scripts", "model-estimates-quarterly.csv");

let cached: ReportedQuarterGmv[] | null = null;
let cachedEstimates: ModelQuarterEstimate[] | null = null;

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
