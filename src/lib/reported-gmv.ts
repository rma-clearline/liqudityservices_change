// LQDT's total REPORTED (company-wide) GMV by calendar quarter — the benchmark the
// scraped/projected GMV is compared against. Sourced from the financial model via
// `scripts/extract-reported-gmv.mjs`, which writes the committed CSV read here at
// runtime (same `scripts/`-CSV pattern as the historical daily GMV in auctions.ts).
//
// Quarters are calendar "YYYYQn" keys (aligned to the chart's bucket keys); the UI
// renders the dual CQ/FQ label. Amounts are USD (the extractor converts the model's
// $000 to dollars). This is a small fixed series, so it's module-cached.

import { readFile } from "node:fs/promises";
import path from "node:path";

export type ReportedQuarterGmv = { quarter: string; reported_gmv_usd: number };

const REPORTED_GMV_PATH =
  process.env.REPORTED_GMV_QUARTERLY_PATH ||
  path.join(process.cwd(), "scripts", "reported-gmv-quarterly.csv");

let cached: ReportedQuarterGmv[] | null = null;

/** Reported total-company GMV per calendar quarter, chronological. `[]` if the CSV
 *  is absent (the app runs fine without the benchmark overlay). */
export async function loadReportedQuarterlyGmv(): Promise<ReportedQuarterGmv[]> {
  if (cached) return cached;
  const out: ReportedQuarterGmv[] = [];
  try {
    const raw = await readFile(REPORTED_GMV_PATH, "utf8");
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
