import { NextResponse } from "next/server";
import { ttlCache } from "@/lib/cache";
import { azFetchDataFreshness, azFetchCronRunsRecent } from "@/lib/azure-tables";

export const dynamic = "force-dynamic";

type CronRunRow = {
  run_id: string;
  source: string;
  status: string;
  rows_ingested: number | null;
  error: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
};

// The freshness provider fetches this on every dashboard page mount (8 Supabase
// reads). Cache the computed payload so tab-to-tab navigation doesn't re-run
// them; five minutes is still near-live relative to the four-hour ingestion
// only change every ~4h, and the UI computes row age client-side).
const statusCache = ttlCache<Awaited<ReturnType<typeof buildDataStatus>>>(5 * 60_000);

export async function GET() {
  return NextResponse.json(await statusCache.get("data-status", buildDataStatus));
}

async function buildDataStatus() {
  const [tables, cronRows] = await Promise.all([
    loadTableFreshness(),
    azFetchCronRunsRecent(60).catch(() => []) as Promise<CronRunRow[]>,
  ]);

  // Reduce recent cron_runs to the latest entry per source.
  const perSource: Record<string, CronRunRow> = {};
  for (const row of cronRows) {
    if (!perSource[row.source]) perSource[row.source] = row; // rows already sorted desc
  }
  const lastRun = perSource["__run__"] ?? cronRows[0] ?? null;

  // Alerting: failed runs, stale data, and zero-row successes.
  // future_improvements.md "Add alerting for stale data, failed cron runs,
  // unexpectedly low row counts...".
  const STALE_HOURS = 48;
  const ageHours = (iso: string | null): number | null => {
    if (!iso) return null;
    const t = Date.parse(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
    return Number.isNaN(t) ? null : (Date.now() - t) / 3_600_000;
  };
  const alerts: { level: "warn" | "error"; message: string }[] = [];
  if (lastRun?.status === "failed") alerts.push({ level: "error", message: "Last cron run failed." });
  for (const [src, row] of Object.entries(perSource)) {
    if (src === "__run__") continue;
    if (row.status === "failed") {
      alerts.push({ level: "error", message: `${src} failed: ${row.error ?? "unknown error"}` });
    } else if (row.status === "success" && (row.rows_ingested ?? 0) === 0) {
      alerts.push({ level: "warn", message: `${src} ingested 0 rows on the last run.` });
    }
  }
  for (const [table, iso] of Object.entries(tables)) {
    const hrs = ageHours(iso);
    if (hrs === null) alerts.push({ level: "warn", message: `${table} has no data.` });
    else if (hrs > STALE_HOURS) alerts.push({ level: "warn", message: `${table} is stale (${Math.round(hrs)}h old).` });
  }

  return {
    generated_at: new Date().toISOString(),
    tables,
    alerts,
    cron: {
      last_run_id: lastRun?.run_id ?? null,
      last_run_at: lastRun?.ended_at ?? lastRun?.started_at ?? null,
      last_run_status: lastRun?.status ?? null,
      sources: perSource,
    },
  };
}

async function loadTableFreshness(): Promise<Record<string, string | null>> {
  return azFetchDataFreshness().catch(() => ({}));
}
