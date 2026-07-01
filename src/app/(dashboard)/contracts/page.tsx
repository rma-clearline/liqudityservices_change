import { supabase } from "@/lib/supabase";
import type {
  FederalContractRow,
  ContractSnapshotRow,
  SamOpportunityRow,
  StateContractRow,
} from "@/lib/supabase";
import { FederalContracts } from "@/components/federal-contracts";
import { SamOpportunities } from "@/components/sam-opportunities";
import { StateContracts } from "@/components/state-contracts";
import { SectionHeader } from "@/components/section-header";

export const dynamic = "force-dynamic";

export default async function ContractsPage() {
  const [contractsRes, snapshotsRes, samRes, stateRes] = await Promise.all([
    supabase.from("federal_contracts").select("*").order("start_date", { ascending: false }).limit(20),
    supabase.from("contract_snapshots").select("*").order("date", { ascending: false }).limit(1),
    supabase.from("sam_opportunities").select("*").order("posted_date", { ascending: false }).limit(100),
    supabase
      .from("state_contracts")
      .select("*")
      .order("year", { ascending: false })
      .order("quarter", { ascending: false })
      .limit(200),
  ]);

  const contracts: FederalContractRow[] = contractsRes.data ?? [];
  const contractSnapshot: ContractSnapshotRow | null = snapshotsRes.data?.[0] ?? null;
  const samOpportunities: SamOpportunityRow[] = samRes.data ?? [];
  const stateContracts: StateContractRow[] = stateRes.data ?? [];

  return (
    <div className="space-y-10">
      <section>
        <SectionHeader title="Federal Contracts" source="federal_contracts" table="federal_contracts" />
        <FederalContracts contracts={contracts} snapshot={contractSnapshot} />
      </section>

      <section>
        <SectionHeader title="Federal Opportunities (SAM.gov)" source="sam" table="sam_opportunities" />
        <SamOpportunities opportunities={samOpportunities} />
      </section>

      <section>
        <SectionHeader title="State &amp; Local Contracts" source="state_contracts" table="state_contracts" />
        <StateContracts contracts={stateContracts} />
      </section>
    </div>
  );
}
