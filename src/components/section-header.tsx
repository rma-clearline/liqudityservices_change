"use client";

import { Freshness } from "./freshness";

/** Section title + a data-freshness badge, shared across the tab pages. */
export function SectionHeader({ title, source, table }: { title: string; source?: string; table?: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      <Freshness source={source} table={table} />
    </div>
  );
}
