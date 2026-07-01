"use client";

import { useRef, useState, useMemo } from "react";
import type {
  ListingRow,
  MarketplaceMetricsRow,
  FederalContractRow,
  ContractSnapshotRow,
  MarketplaceSellerRow,
  SamOpportunityRow,
  StateContractRow,
  SellerDeltaRow,
} from "@/lib/supabase";
import { ListingsChart } from "./listings-chart";
import { ListingsTable } from "./listings-table";
import { EmailSnapshot } from "./email-snapshot";
import { MarketplaceMetrics } from "./marketplace-metrics";
import { RevenueForecast } from "./revenue-forecast";
import { FederalContracts } from "./federal-contracts";
import { TopSellers } from "./top-sellers";
import { SellerMovers } from "./seller-movers";
import { SamOpportunities } from "./sam-opportunities";
import { StateContracts } from "./state-contracts";
import { ExecutiveSummary } from "./executive-summary";
import { AlertsBanner, DataStatusProvider, Freshness } from "./freshness";

const RANGES = ["All", "3Y", "1Y", "6M", "3M", "1M"] as const;
type Range = (typeof RANGES)[number];

const NAV = [
  { id: "summary", label: "Summary" },
  { id: "trend", label: "Listings" },
  { id: "forecast", label: "Forecast" },
  { id: "marketplace", label: "Marketplace" },
  { id: "sellers", label: "Sellers" },
  { id: "federal", label: "Federal" },
  { id: "opportunities", label: "Opportunities" },
  { id: "state", label: "State/Local" },
];

function fmt(n: number | null | undefined) {
  return n != null ? n.toLocaleString("en-US") : "—";
}

function cutoffDate(range: Range): string | null {
  if (range === "All") return null;
  const now = new Date();
  const months: Record<Exclude<Range, "All">, number> = {
    "3Y": 36, "1Y": 12, "6M": 6, "3M": 3, "1M": 1,
  };
  now.setMonth(now.getMonth() - months[range]);
  return now.toISOString().slice(0, 10);
}

function SectionHeader({ title, source, table }: { title: string; source?: string; table?: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      <Freshness source={source} table={table} />
    </div>
  );
}

function SectionNav() {
  return (
    <nav className="sticky top-0 z-30 -mx-6 mb-6 border-b bg-white/90 px-6 py-2 backdrop-blur">
      <div className="flex gap-1 overflow-x-auto text-sm">
        {NAV.map((n) => (
          <a
            key={n.id}
            href={`#${n.id}`}
            className="whitespace-nowrap rounded-md px-3 py-1 text-gray-600 hover:bg-gray-100 hover:text-gray-900"
          >
            {n.label}
          </a>
        ))}
      </div>
    </nav>
  );
}

export function Dashboard({
  listings,
  metricsAllsurplus,
  sellersAllsurplus,
  sellersGovdeals,
  sellerDeltas,
  metricsGovdeals,
  contracts,
  contractSnapshot,
  samOpportunities,
  stateContracts,
}: {
  listings: ListingRow[];
  metricsAllsurplus: MarketplaceMetricsRow | null;
  metricsGovdeals: MarketplaceMetricsRow | null;
  contracts: FederalContractRow[];
  contractSnapshot: ContractSnapshotRow | null;
  sellersAllsurplus: MarketplaceSellerRow[];
  sellersGovdeals: MarketplaceSellerRow[];
  sellerDeltas: SellerDeltaRow[];
  samOpportunities: SamOpportunityRow[];
  stateContracts: StateContractRow[];
}) {
  const [range, setRange] = useState<Range>("All");
  const chartRef = useRef<HTMLDivElement>(null);
  const latest = listings[0] ?? null;

  const filtered = useMemo(() => {
    const cutoff = cutoffDate(range);
    if (!cutoff) return listings;
    return listings.filter((r) => r.date >= cutoff);
  }, [listings, range]);

  return (
    <DataStatusProvider>
      <SectionNav />

      <AlertsBanner />

      <ExecutiveSummary />

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

      <section id="trend" className="mb-8 scroll-mt-20">
        <SectionHeader title="Active Listings Trend" table="listings" source="listings" />
        <div ref={chartRef}>
          <ListingsChart data={filtered} allData={listings} />
        </div>
      </section>

      <section id="forecast" className="mb-8 scroll-mt-20">
        <SectionHeader title="Quarterly Revenue Forecast" source="auctions" table="auctions" />
        <RevenueForecast />
      </section>

      <section id="marketplace" className="mb-8 scroll-mt-20">
        <SectionHeader title="Marketplace Metrics" source="marketplace_metrics" table="marketplace_metrics" />
        <MarketplaceMetrics allsurplus={metricsAllsurplus} govdeals={metricsGovdeals} />
      </section>

      <section id="sellers" className="mb-8 scroll-mt-20">
        <SectionHeader title="Top Sellers" source="marketplace_metrics" table="marketplace_sellers" />
        <div className="space-y-6">
          <SellerMovers deltas={sellerDeltas} />
          <TopSellers allsurplus={sellersAllsurplus} govdeals={sellersGovdeals} />
        </div>
      </section>

      <section id="federal" className="mb-8 scroll-mt-20">
        <SectionHeader title="Federal Contracts" source="federal_contracts" table="federal_contracts" />
        <FederalContracts contracts={contracts} snapshot={contractSnapshot} />
      </section>

      <section id="opportunities" className="mb-8 scroll-mt-20">
        <SectionHeader title="Federal Opportunities (SAM.gov)" source="sam" table="sam_opportunities" />
        <SamOpportunities opportunities={samOpportunities} />
      </section>

      <section id="state" className="mb-8 scroll-mt-20">
        <SectionHeader title="State & Local Contracts" source="state_contracts" table="state_contracts" />
        <StateContracts contracts={stateContracts} />
      </section>

      <section className="scroll-mt-20">
        <h2 className="text-lg font-semibold mb-4">History</h2>
        <ListingsTable data={filtered} />
      </section>
    </DataStatusProvider>
  );
}
