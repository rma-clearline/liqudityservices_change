import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "./supabase";
import { useAzureData } from "./data-backend";
import { azInsertCronRuns } from "./azure-tables";

export type CronStatus = "success" | "partial" | "failed" | "skipped";

export type SourceSummary = {
  status: CronStatus;
  rows: number | null;
  detail?: Record<string, unknown> | null;
  error?: string | null;
};

export type CronRunRecord = {
  run_id: string;
  source: string;
  status: CronStatus;
  rows_ingested: number | null;
  detail: Record<string, unknown> | null;
  error: string | null;
  started_at: string;
  ended_at: string;
  duration_ms: number;
};

/**
 * Accumulates per-source outcomes for a single cron invocation and flushes them
 * to the `cron_runs` table (one row per source + a `__run__` summary). Used by
 * the monolithic cron and, later, the per-source split endpoints.
 */
export class CronLogger {
  readonly runId = randomUUID();
  private readonly records: CronRunRecord[] = [];
  private readonly runStart = Date.now();

  /** Run `fn`, time it, and record a cron_runs entry from `summarize`. */
  async track<T>(
    source: string,
    fn: () => Promise<T>,
    summarize: (value: T) => SourceSummary,
  ): Promise<T | null> {
    const startedAt = new Date();
    try {
      const value = await fn();
      const s = summarize(value);
      this.push(source, s.status, s.rows, s.detail ?? null, s.error ?? null, startedAt);
      return value;
    } catch (e) {
      this.push(source, "failed", 0, null, e instanceof Error ? e.message : String(e), startedAt);
      return null;
    }
  }

  push(
    source: string,
    status: CronStatus,
    rows: number | null,
    detail: Record<string, unknown> | null,
    error: string | null,
    startedAt: Date = new Date(),
  ) {
    const ended = new Date();
    this.records.push({
      run_id: this.runId,
      source,
      status,
      rows_ingested: rows,
      detail,
      error,
      started_at: startedAt.toISOString(),
      ended_at: ended.toISOString(),
      duration_ms: ended.getTime() - startedAt.getTime(),
    });
  }

  get entries(): CronRunRecord[] {
    return this.records;
  }

  /** Insert all records plus a run summary. Best-effort; never throws. */
  async flush(): Promise<CronRunRecord[]> {
    const ended = new Date();
    const anyFailed = this.records.some((r) => r.status === "failed");
    const allFailed = this.records.length > 0 && this.records.every((r) => r.status === "failed");
    const summary: CronRunRecord = {
      run_id: this.runId,
      source: "__run__",
      status: allFailed ? "failed" : anyFailed ? "partial" : "success",
      rows_ingested: this.records.reduce((s, r) => s + (r.rows_ingested ?? 0), 0),
      detail: { sources: this.records.length },
      error: null,
      started_at: new Date(this.runStart).toISOString(),
      ended_at: ended.toISOString(),
      duration_ms: ended.getTime() - this.runStart,
    };
    const all = [...this.records, summary];
    try {
      if (useAzureData()) {
        await azInsertCronRuns(all);
      } else {
        // supabase-js RESOLVES with an { error } object instead of throwing, so a
        // failure here would never reach the catch below. Re-throw it. This is the
        // exact shape that hid the outage: DATA_BACKEND defaults to supabase, prod
        // Supabase has no cron_runs table, and every insert came back PGRST205
        // "Could not find the table" — discarded, silently, for months.
        const { error } = await supabaseAdmin.from("cron_runs").insert(all);
        if (error) throw new Error(`supabase insert failed: ${error.message}`);
      }
    } catch (e) {
      // Still best-effort — a logging failure must never fail the run — but no longer
      // silent. When this write is dropped the ops log, the freshness badges and the
      // alert banner all go blank with nothing indicating they are blind.
      console.warn(
        `[cron-log] could not persist ${all.length} cron_runs record(s) to ` +
          `${useAzureData() ? "azure" : "supabase"}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
    return all;
  }
}
