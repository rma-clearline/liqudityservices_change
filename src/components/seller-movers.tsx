"use client";

import { useMemo } from "react";
import type { SellerDeltaRow } from "@/lib/supabase";
import { fmtDollar, fmtNum } from "@/lib/format";

function MoverRow({ d }: { d: SellerDeltaRow }) {
  const delta = d.listing_count_delta ?? 0;
  const up = delta > 0;
  const name = d.company_name || `Seller #${d.account_id}`;
  return (
    <div className="flex items-center justify-between gap-3 text-sm py-1 border-b border-gray-100">
      <span className="truncate">{name}</span>
      <span className={`tabular-nums whitespace-nowrap font-medium ${up ? "text-green-600" : "text-red-600"}`}>
        {up ? "+" : ""}{fmtNum(delta)} listings
        <span className="text-gray-400 font-normal ml-2">{fmtDollar(d.gmv_delta)}</span>
      </span>
    </div>
  );
}

export function SellerMovers({ deltas }: { deltas: SellerDeltaRow[] }) {
  const { gainers, losers, newCount, goneCount } = useMemo(() => {
    const active = deltas.filter((d) => !d.is_new && !d.disappeared && (d.listing_count_delta ?? 0) !== 0);
    const sorted = [...active].sort((a, b) => (b.listing_count_delta ?? 0) - (a.listing_count_delta ?? 0));
    return {
      gainers: sorted.filter((d) => (d.listing_count_delta ?? 0) > 0).slice(0, 5),
      losers: sorted.filter((d) => (d.listing_count_delta ?? 0) < 0).slice(-5).reverse(),
      newCount: deltas.filter((d) => d.is_new).length,
      goneCount: deltas.filter((d) => d.disappeared).length,
    };
  }, [deltas]);

  if (deltas.length === 0) {
    return (
      <p className="text-xs text-gray-400">
        Seller movers appear once at least two daily snapshots exist (needs the marketplace_seller_deltas view).
      </p>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-3 text-xs">
        <span className="rounded border px-2 py-0.5">
          New sellers <span className="font-semibold text-green-600">{fmtNum(newCount)}</span>
        </span>
        <span className="rounded border px-2 py-0.5">
          Disappeared <span className="font-semibold text-red-600">{fmtNum(goneCount)}</span>
        </span>
        <span className="text-gray-400 self-center">vs prior snapshot</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <div>
          <p className="text-xs font-semibold text-gray-500 mb-1">Biggest gainers (listings)</p>
          {gainers.length ? gainers.map((d) => <MoverRow key={`${d.platform}-${d.account_id}`} d={d} />) : <p className="text-xs text-gray-400">None</p>}
        </div>
        <div>
          <p className="text-xs font-semibold text-gray-500 mb-1">Biggest decliners (listings)</p>
          {losers.length ? losers.map((d) => <MoverRow key={`${d.platform}-${d.account_id}`} d={d} />) : <p className="text-xs text-gray-400">None</p>}
        </div>
      </div>
    </div>
  );
}
