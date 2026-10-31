import { InvaluableDashboard } from "@/components/invaluable-dashboard";
import { SectionHeader } from "@/components/section-header";

export const dynamic = "force-dynamic";

export default function InvaluablePage() {
  return (
    <div>
      <SectionHeader
        title="Invaluable panel — GMS proxy"
        note="Liquidity Services closed its acquisition of Auction Holdings (Invaluable, AuctionZip) on 2026-10-01; its gross merchandise sales join reported GMV from FY27 Q1. This panel collects the full hosted catalogs of auction houses on the platform and infers which lots were won online, which is Invaluable's GMS definition. Permission-based collection; one client, identified, two requests a second per house site."
      />
      <InvaluableDashboard />
    </div>
  );
}
