import { QtdProgress } from "@/components/qtd-progress";
import { SectionHeader } from "@/components/section-header";

export const dynamic = "force-dynamic";

export default function QtdPage() {
  return (
    <div>
      <SectionHeader
        title="Cumulative QTD Progress"
        source="auctions"
        table="auctions"
        note="Cumulative daily GMV through the latest scraped day, day-aligned against last year's same fiscal quarter, with a capture-rate scaling to estimated total-company GMV and comparisons vs company guidance and the Clearline model."
      />
      <QtdProgress />
    </div>
  );
}
