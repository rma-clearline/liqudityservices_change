import { RevenueForecast } from "@/components/revenue-forecast";
import { SectionHeader } from "@/components/section-header";

export const dynamic = "force-dynamic";

export default function ForecastPage() {
  return (
    <div>
      <SectionHeader title="Quarterly Revenue Forecast" source="auctions" table="auctions" />
      <RevenueForecast />
    </div>
  );
}
