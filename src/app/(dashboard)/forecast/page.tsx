import { RevenueForecast } from "@/components/revenue-forecast";
import { SectionHeader } from "@/components/section-header";

export const dynamic = "force-dynamic";

export default function ForecastPage() {
  return (
    <div>
      <SectionHeader
        title="Quarterly Revenue Forecast"
        source="auctions"
        table="auctions"
        note="Auctions only — GMV and revenue here cover the auction marketplaces (AllSurplus, GovDeals, Industrial) and exclude RSCG purchase/resale and Machinio, so these figures do not reconcile to total company revenue."
      />
      <RevenueForecast />
    </div>
  );
}
