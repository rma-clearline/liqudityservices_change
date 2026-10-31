import { QtdProgress } from "@/components/qtd-progress";
import { SectionHeader } from "@/components/section-header";
import Link from "next/link";

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
      <p className="mt-10 text-xs text-gray-500">
        The Invaluable panel (the GMS proxy for the acquired auction platform) has its own tab:{" "}
        <Link href="/invaluable" className="underline hover:text-gray-800">
          Invaluable
        </Link>
        .
      </p>
    </div>
  );
}
