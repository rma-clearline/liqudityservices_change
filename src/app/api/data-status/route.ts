import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Which column best represents "freshness" for each data table. `fallback` is
// used when the primary column doesn't exist yet (e.g. a not-yet-applied
// migration) so the endpoint degrades gracefully instead of reporting "no data".
const TABLE_FRESHNESS: { table: string; column: string; fallback?: string }[] = [
  { table: "listings", column: "date" },
  { table: "marketplace_metrics", column: "date" },
  { table: "marketplace_sellers", column: "date" },
  { table: "auctions", column: "last_seen_at" },
  { table: "federal_contracts", column: "first_seen_date" },
  { table: "contract_snapshots", column: "date" },
  { table: "sam_opportunities", column: "first_seen_date" },
  // last_seen_date advances every run (migration 023); fall back to first_seen_date
  // until that migration is applied.
  { table: "state_contracts", column: "last_seen_date", fallback: "first_seen_date" },
];

async function latestValue(table: string, column: string, fallback?: string): Promise<string | null> {
  const { data, error } = await supabase
    .from(table)
    .select(column)
    .order(column, { ascending: false })
    .limit(1);
  if (error) {
    return fallback ? latestValue(table, fallback) : null;
  }
  if (!data || data.length === 0) return null;
  const row = data[0] as unknown as Record<string, unknown>;
  const value = row[column];
  return typeof value === "string" ? value : null;
}

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

export async function GET() {
  const [tableEntries, cronRes] = await Promise.all([
    Promise.all(
      TABLE_FRESHNESS.map(async ({ table, column, fallback }) => [table, await latestValue(table, column, fallback)] as const),
    ),
    supabase
      .from("cron_runs")
      .select("run_id, source, status, rows_ingested, error, started_at, ended_at, duration_ms")
      .order("started_at", { ascending: false })
      .limit(60),
  ]);

  const tables = Object.fromEntries(tableEntries.map(([table, value]) => [table, value]));

  // Reduce recent cron_runs to the latest entry per source.
  const cronRows = (cronRes.data ?? []) as CronRunRow[];
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

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    tables,
    alerts,
    cron: {
      last_run_id: lastRun?.run_id ?? null,
      last_run_at: lastRun?.ended_at ?? lastRun?.started_at ?? null,
      last_run_status: lastRun?.status ?? null,
      sources: perSource,
    },
  });
}
