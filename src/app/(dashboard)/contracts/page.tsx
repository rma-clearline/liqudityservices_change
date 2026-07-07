import { FederalContracts } from "@/components/federal-contracts";
import { SamOpportunities } from "@/components/sam-opportunities";
import { StateContracts } from "@/components/state-contracts";
import { GovernmentSellers } from "@/components/government-sellers";
import { SectionHeader } from "@/components/section-header";
import { getContractsData } from "@/lib/dashboard-data";

export const dynamic = "force-dynamic";

export default async function ContractsPage() {
  const { contracts, snapshot: contractSnapshot, sam: samOpportunities, state: stateContracts, sellerSnapshot } =
    await getContractsData();

  return (
    <div className="space-y-10">
      <section>
        <SectionHeader
          title="Government Surplus Sellers"
          source="marketplace_metrics"
          table="marketplace_sellers"
          note="Who is actually selling on AllSurplus/GovDeals right now, by level of government. This is LQDT's live government-surplus franchise — the federal/state/local contract sections below are the paper trail. Filter by level; GMV is the current-bid proxy, not realized."
        />
        <GovernmentSellers sellers={sellerSnapshot.sellers} snapshotDate={sellerSnapshot.date} />
      </section>

      <section>
        <SectionHeader
          title="Federal Contracts — LQDT as prime vendor"
          source="federal_contracts"
          table="federal_contracts"
          note="Sparse by nature: LQDT is a surplus seller/agent, not a federal prime recipient, so USAspending shows only a handful of lifetime prime awards. LQDT's real federal activity is disposal solicitations (see Federal Opportunities below) and the DoD/DLA surplus program — not obligations paid to LQDT."
        />
        <FederalContracts contracts={contracts} snapshot={contractSnapshot} />
      </section>

      <section>
        <SectionHeader
          title="Federal Opportunities (SAM.gov)"
          source="sam"
          table="sam_opportunities"
          note="The forward-looking federal pipeline: new government surplus-disposal solicitations. Requires a valid SAM.gov Opportunities API key — if empty, the SAM_API_KEY is unset or unauthorized (see freshness/alerts)."
        />
        <SamOpportunities opportunities={samOpportunities} />
      </section>

      <section>
        <SectionHeader title="State &amp; Local Contracts" source="state_contracts" table="state_contracts" />
        <StateContracts contracts={stateContracts} />
      </section>
    </div>
  );
}
