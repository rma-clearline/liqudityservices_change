"use client";

import { useMemo, useRef, useState } from "react";
import type { ListingRow } from "@/lib/supabase";
import { ListingsChart } from "./listings-chart";
import { ListingsTable } from "./listings-table";
import { EmailSnapshot } from "./email-snapshot";
import { SectionHeader } from "./section-header";

const RANGES = ["All", "3Y", "1Y", "6M", "3M", "1M"] as const;
type Range = (typeof RANGES)[number];

// Both series (AllSurplus + GovDeals) were only captured from this day on, so the
// chart/table floor here — no partial single-series stretch before it. "All"/"3Y"
// therefore start at 1/1/2025 (the default view), which is what the quarter-tick
// x-axis anchors to.
const DATA_START = "2025-01-01";

function fmt(n: number | null | undefined) {
  return n != null ? n.toLocaleString("en-US") : "—";
}

function cutoffDate(range: Range): string | null {
  if (range === "All") return null;
  const now = new Date();
  const months: Record<Exclude<Range, "All">, number> = { "3Y": 36, "1Y": 12, "6M": 6, "3M": 3, "1M": 1 };
  now.setMonth(now.getMonth() - months[range]);
  return now.toISOString().slice(0, 10);
}

export function ListingsView({ listings }: { listings: ListingRow[] }) {
  // Default view: the full both-series history, i.e. from 1/1/2025 → now.
  const [range, setRange] = useState<Range>("All");
  const chartRef = useRef<HTMLDivElement>(null);
  const latest = listings[0] ?? null;

  const filtered = useMemo(() => {
    const cutoff = cutoffDate(range);
    // Floor every range at DATA_START (both-series start); short ranges keep their
    // own cutoff when it's later.
    const floor = cutoff && cutoff > DATA_START ? cutoff : DATA_START;
    return listings.filter((r) => r.date >= floor);
  }, [listings, range]);

  return (
    <div>
      {latest && (
        <div className="grid grid-cols-2 gap-4 mb-8">
          <div className="rounded-lg border p-4">
            <p className="text-xs text-gray-500 mb-1">AllSurplus active listings</p>
            <p className="text-3xl font-bold text-blue-600 tabular-nums">{fmt(latest.allsurplus)}</p>
          </div>
          <div className="rounded-lg border p-4">
            <p className="text-xs text-gray-500 mb-1">GovDeals active listings</p>
            <p className="text-3xl font-bold text-green-600 tabular-nums">{fmt(latest.govdeals)}</p>
          </div>
          <p className="col-span-2 text-xs text-gray-400">Last updated: {latest.date} {latest.timestamp} ET</p>
        </div>
      )}

      <EmailSnapshot chartRef={chartRef} />

      <div className="flex gap-2 mb-4">
        {RANGES.map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={`px-3 py-1 text-sm rounded-md border transition-colors ${
              range === r
                ? "bg-gray-900 text-white border-gray-900"
                : "bg-white text-gray-600 border-gray-300 hover:border-gray-400"
            }`}
          >
            {r}
          </button>
        ))}
      </div>

      <section className="mb-8">
        <SectionHeader title="Active Listings Trend" source="listings" table="listings" />
        <div ref={chartRef}>
          <ListingsChart data={filtered} allData={listings} />
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-4">History</h2>
        <ListingsTable data={filtered} />
      </section>
    </div>
  );
}
