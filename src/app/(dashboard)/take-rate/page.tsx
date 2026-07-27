import { TakeRateView } from "@/components/take-rate-view";
import { SectionHeader } from "@/components/section-header";
import { getTakeRateComposition } from "@/lib/dashboard-data";

export const dynamic = "force-dynamic";

export default async function TakeRatePage() {
  const data = await getTakeRateComposition();
  return (
    <div className="space-y-10">
      <section>
        <SectionHeader
          title="Take Rate Composition"
          source="sold_capture"
          table="sold_lots"
          note="Reported revenue reconstructed from segment take rates, with the measured seller admin fee split out."
        />
        <TakeRateView data={data} />
      </section>
    </div>
  );
}
