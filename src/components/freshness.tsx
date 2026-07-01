"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { fmtAge } from "@/lib/format";

export type CronSourceStatus = {
  status: string;
  ended_at: string | null;
  rows_ingested: number | null;
  error: string | null;
};

export type DataAlert = { level: "warn" | "error"; message: string };

export type DataStatus = {
  generated_at: string;
  tables: Record<string, string | null>;
  alerts?: DataAlert[];
  cron: {
    last_run_id: string | null;
    last_run_at: string | null;
    last_run_status: string | null;
    sources: Record<string, CronSourceStatus>;
  };
};

const DataStatusContext = createContext<DataStatus | null>(null);

export function DataStatusProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<DataStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/data-status")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setStatus(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return <DataStatusContext.Provider value={status}>{children}</DataStatusContext.Provider>;
}

export function useDataStatus() {
  return useContext(DataStatusContext);
}

/** Banner listing any active data alerts (failed runs, stale data, 0-row pulls). */
export function AlertsBanner() {
  const status = useDataStatus();
  const alerts = status?.alerts ?? [];
  if (alerts.length === 0) return null;
  const hasError = alerts.some((a) => a.level === "error");
  return (
    <div
      className={`mb-6 rounded-lg border p-3 text-sm ${
        hasError ? "border-red-200 bg-red-50 text-red-700" : "border-amber-200 bg-amber-50 text-amber-700"
      }`}
    >
      <p className="mb-1 font-semibold">{hasError ? "⚠ Data issues" : "Data notices"}</p>
      <ul className="list-disc pl-5 space-y-0.5">
        {alerts.slice(0, 8).map((a, i) => (
          <li key={i}>{a.message}</li>
        ))}
      </ul>
    </div>
  );
}

function ageColor(iso: string | null | undefined, failed: boolean): string {
  if (failed || !iso) return "bg-red-50 text-red-600 border-red-200";
  const t = Date.parse(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(t)) return "bg-gray-50 text-gray-500 border-gray-200";
  const hours = (Date.now() - t) / 3_600_000;
  if (hours <= 24) return "bg-green-50 text-green-700 border-green-200";
  if (hours <= 72) return "bg-amber-50 text-amber-700 border-amber-200";
  return "bg-red-50 text-red-600 border-red-200";
}

/**
 * Small freshness badge for a section header. Pass `source` (a cron_runs source
 * name) to reflect the last run's status, and/or `table` for the underlying
 * table's latest row age.
 */
export function Freshness({ source, table }: { source?: string; table?: string }) {
  const status = useDataStatus();
  if (!status) return null;

  const cronSource = source ? status.cron.sources[source] : undefined;
  const failed = cronSource?.status === "failed";
  const iso = cronSource?.ended_at ?? (table ? status.tables[table] : null);
  if (!iso && !failed && !cronSource) return null;

  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs ${ageColor(iso, failed)}`}>
      {failed ? "last run failed" : `updated ${fmtAge(iso)}`}
    </span>
  );
}
