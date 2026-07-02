"use client";

import { Freshness } from "./freshness";

/** Section title + a data-freshness badge, shared across the tab pages. */
export function SectionHeader({
  title,
  source,
  table,
  note,
}: {
  title: string;
  source?: string;
  table?: string;
  /** Optional one-line context shown under the title (e.g. why a source is sparse). */
  note?: string;
}) {
  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        <Freshness source={source} table={table} />
      </div>
      {note && <p className="mt-1 text-xs text-gray-500 max-w-3xl">{note}</p>}
    </div>
  );
}
