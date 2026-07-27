import type { TakeRateComposition, TakeRateQuarter, MeasuredFeeSite } from "@/lib/dashboard-data";

const SITE_LABEL: Record<string, string> = { AD: "AllSurplus", GD: "GovDeals", GI: "Industrial" };

function m(usd: number): string {
  if (Math.abs(usd) >= 1_000_000) return "$" + (usd / 1_000_000).toFixed(1) + "M";
  if (Math.abs(usd) >= 1_000) return "$" + (usd / 1_000).toFixed(0) + "k";
  return "$" + usd.toFixed(0);
}
const pf = (frac: number) => (frac * 100).toFixed(2) + "%"; // reported take rates are fractions
const pp = (pct: number | null) => (pct == null ? "—" : pct.toFixed(2) + "%"); // measured fee is a percent
function fq(quarter: string): string {
  // 2026Q1 -> "2026 Q1"
  const m2 = /^(\d{4})Q([1-4])$/.exec(quarter);
  return m2 ? `${m2[1]} Q${m2[2]}` : quarter;
}

export function TakeRateView({ data }: { data: TakeRateComposition }) {
  const { latest, quarters, measured } = data;
  if (!latest) {
    return <p className="text-sm text-gray-500">Model metrics unavailable — the reported take-rate workbook isn&apos;t loaded.</p>;
  }
  const bySite = new Map((measured?.bySite ?? []).map((s) => [s.site, s]));
  const feePct = (site: string): number | null => bySite.get(site)?.blended_pct ?? null;

  // Marketplace composition: reported commission take rate paired with the measured
  // seller admin fee. Only the clean commission segments (GovDeals, CAG) — RSCG is a
  // purchase/ownership line, not a commission, so it's excluded from this split.
  const compRows: { label: string; site: string; take: number }[] = [
    { label: "GovDeals", site: "GD", take: latest.govdealsTake },
    { label: "Industrial (CAG)", site: "GI", take: latest.cagTake },
  ];

  return (
    <div className="space-y-10 text-sm">
      {/* Thesis */}
      <p className="max-w-3xl text-gray-600">
        LSI&apos;s take is overwhelmingly a <strong>buyer-premium and services</strong> story, not a seller-commission one. The
        seller admin fee — the one component we can measure directly from the marketplace API — is only about{" "}
        <strong>{pp(measured?.overall_pct ?? null)}</strong> of GMV, a small slice of the ~{pf(latest.consignmentTake)} blended
        marketplace commission. (The reported ~{pf(latest.blendedTake)} total take is revenue ÷ all GMV, inflated by the
        purchase/ownership line — see the build-up below.) Everything below shows how reported revenue is built and where that
        seller fee sits within it.
      </p>

      {/* 1. Revenue build-up for the latest reported quarter */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">How revenue is built — {fq(latest.quarter)} (reported)</h3>
        <p className="mb-3 text-xs text-gray-500">
          Each business segment&apos;s GMV × its reported take rate, plus Machinio services, reconstructs total revenue. RSCG is a
          purchase/ownership line (LSI buys and resells), so its ~{pf(latest.rscgTake)} &quot;take&quot; is a gross margin on owned
          goods, not a marketplace commission.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-gray-300 text-left">
                <th className="py-1.5 pr-4">Segment</th>
                <th className="py-1.5 pr-4 text-right">GMV</th>
                <th className="py-1.5 pr-4 text-right">Take rate</th>
                <th className="py-1.5 text-right">Revenue</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              <tr className="border-b border-gray-100">
                <td className="py-1 pr-4">GovDeals (consignment marketplace)</td>
                <td className="py-1 pr-4 text-right">{m(latest.govdealsGmv)}</td>
                <td className="py-1 pr-4 text-right">{pf(latest.govdealsTake)}</td>
                <td className="py-1 text-right">{m(latest.govdealsRev)}</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 pr-4">RSCG (retail supply chain — purchase model)</td>
                <td className="py-1 pr-4 text-right">{m(latest.rscgGmv)}</td>
                <td className="py-1 pr-4 text-right">{pf(latest.rscgTake)}</td>
                <td className="py-1 text-right">{m(latest.rscgRev)}</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 pr-4">CAG / Industrial (capital assets)</td>
                <td className="py-1 pr-4 text-right">{m(latest.cagGmv)}</td>
                <td className="py-1 pr-4 text-right">{pf(latest.cagTake)}</td>
                <td className="py-1 text-right">{m(latest.cagRev)}</td>
              </tr>
              <tr className="border-b border-gray-100">
                <td className="py-1 pr-4">Machinio (services)</td>
                <td className="py-1 pr-4 text-right text-gray-400">—</td>
                <td className="py-1 pr-4 text-right text-gray-400">—</td>
                <td className="py-1 text-right">{m(latest.machinio)}</td>
              </tr>
              <tr className="border-b border-gray-300 font-semibold">
                <td className="py-1.5 pr-4">Reconstructed revenue</td>
                <td className="py-1.5 pr-4 text-right">{m(latest.totalGmv)}</td>
                <td className="py-1.5 pr-4 text-right">{pf(latest.blendedTake)}</td>
                <td className="py-1.5 text-right">{m(latest.reconstructed)}</td>
              </tr>
              <tr>
                <td className="py-1 pr-4 text-gray-500">Actual reported revenue</td>
                <td className="py-1 pr-4"></td>
                <td className="py-1 pr-4"></td>
                <td className="py-1 text-right text-gray-500">{m(latest.reported)}</td>
              </tr>
              <tr>
                <td className="py-1 pr-4 text-gray-500">Difference</td>
                <td className="py-1 pr-4"></td>
                <td className="py-1 pr-4"></td>
                <td className="py-1 text-right text-gray-500">
                  {(latest.deltaUsd >= 0 ? "+" : "") + m(latest.deltaUsd)} (
                  {latest.reported ? ((latest.deltaUsd / latest.reported) * 100).toFixed(2) : "0.00"}%)
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* 2. Take rate composition: seller fee vs implied buyer premium */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">Take rate composition — seller fee vs. buyer premium</h3>
        <p className="mb-3 text-xs text-gray-500">
          Each marketplace&apos;s reported commission take rate, split into the <strong>measured</strong> seller admin fee (from the
          marketplace API) and the <strong>implied</strong> remainder (buyer&apos;s premium + fees + services), which the anonymous
          API doesn&apos;t expose.
          {measured
            ? ` Measured fee is GMV-weighted over the trailing 90 days (${measured.from} → ${measured.to}).`
            : " Measured seller fee unavailable (store not configured)."}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-gray-300 text-left">
                <th className="py-1.5 pr-4">Marketplace</th>
                <th className="py-1.5 pr-4 text-right">Reported take rate</th>
                <th className="py-1.5 pr-4 text-right">Measured seller admin fee</th>
                <th className="py-1.5 text-right">Implied buyer premium + services</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {compRows.map((r) => {
                const fee = feePct(r.site);
                // Only show an implied buyer-premium when BOTH the take and the seller
                // fee are known — an unmeasured fee must not be silently treated as 0%.
                const implied = r.take > 0 && fee != null ? r.take * 100 - fee : null;
                return (
                  <tr key={r.site} className="border-b border-gray-100">
                    <td className="py-1 pr-4">{r.label}</td>
                    <td className="py-1 pr-4 text-right">{r.take ? pf(r.take) : "—"}</td>
                    <td className="py-1 pr-4 text-right">{pp(fee)}</td>
                    <td className="py-1 text-right">{implied == null ? "—" : implied.toFixed(2) + "%"}</td>
                  </tr>
                );
              })}
              <tr className="border-b border-gray-300 font-semibold">
                <td className="py-1.5 pr-4">Blended (all consignment)</td>
                <td className="py-1.5 pr-4 text-right">{latest.consignmentTake > 0 ? pf(latest.consignmentTake) : "—"}</td>
                <td className="py-1.5 pr-4 text-right">{pp(measured?.overall_pct ?? null)}</td>
                <td className="py-1.5 text-right">
                  {latest.consignmentTake > 0 && measured?.overall_pct != null
                    ? (latest.consignmentTake * 100 - measured.overall_pct).toFixed(2) + "%"
                    : "—"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-gray-400">
          The seller admin fee accounts for roughly{" "}
          {measured?.overall_pct != null && latest.consignmentTake > 0
            ? ((measured.overall_pct / (latest.consignmentTake * 100)) * 100).toFixed(0)
            : "—"}
          % of the blended marketplace commission; the rest is buyer-side + services. RSCG/purchase GMV is an ownership model (no
          seller fee, no buyer premium) and is excluded from this marketplace split.
        </p>
      </section>

      {/* 3. Measured seller admin fee detail */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">Measured seller admin fee — detail &amp; coverage</h3>
        <p className="mb-3 text-xs text-gray-500">
          Per-lot admin fee (LQDT&apos;s seller-side fee) pulled from the marketplace asset-detail endpoint, GMV-weighted over sold
          lots in the trailing 90 days. Coverage grows as the daily job prices more sellers.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-gray-300 text-left">
                <th className="py-1.5 pr-4">Marketplace</th>
                <th className="py-1.5 pr-4 text-right">GMV-weighted admin fee</th>
                <th className="py-1.5 pr-4 text-right">Priced GMV</th>
                <th className="py-1.5 pr-4 text-right">Total GMV</th>
                <th className="py-1.5 pr-4 text-right">Sellers priced</th>
                <th className="py-1.5 text-right">Coverage</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {(["GD", "AD", "GI"] as const).map((site) => {
                const s: MeasuredFeeSite | undefined = bySite.get(site);
                const cov = s && s.total_gmv > 0 ? (s.covered_gmv / s.total_gmv) * 100 : 0;
                return (
                  <tr key={site} className="border-b border-gray-100">
                    <td className="py-1 pr-4">{SITE_LABEL[site]}</td>
                    <td className="py-1 pr-4 text-right">{pp(s?.blended_pct ?? null)}</td>
                    <td className="py-1 pr-4 text-right">{m(s?.covered_gmv ?? 0)}</td>
                    <td className="py-1 pr-4 text-right">{m(s?.total_gmv ?? 0)}</td>
                    <td className="py-1 pr-4 text-right">{s?.covered_sellers ?? 0}</td>
                    <td className="py-1 text-right">{cov.toFixed(0)}%</td>
                  </tr>
                );
              })}
              <tr className="border-b border-gray-300 font-semibold">
                <td className="py-1.5 pr-4">Overall</td>
                <td className="py-1.5 pr-4 text-right">{pp(measured?.overall_pct ?? null)}</td>
                <td className="py-1.5 pr-4 text-right">{m(measured?.covered_gmv ?? 0)}</td>
                <td className="py-1.5 pr-4 text-right">{m(measured?.total_gmv ?? 0)}</td>
                <td className="py-1.5 pr-4"></td>
                <td className="py-1.5 text-right">
                  {measured && measured.total_gmv > 0 ? ((measured.covered_gmv / measured.total_gmv) * 100).toFixed(0) : "0"}%
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* 4. Revenue reconciliation across quarters */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">Revenue reconciliation — how close each quarter lands</h3>
        <p className="mb-3 text-xs text-gray-500">
          The segment build-up (GovDeals + RSCG + CAG + Machinio) vs. actual reported revenue, last {quarters.length} quarters.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-gray-300 text-left">
                <th className="py-1.5 pr-4">Quarter</th>
                <th className="py-1.5 pr-4 text-right">Total GMV</th>
                <th className="py-1.5 pr-4 text-right">Total take (rev/GMV)</th>
                <th className="py-1.5 pr-4 text-right">Reconstructed rev</th>
                <th className="py-1.5 pr-4 text-right">Reported rev</th>
                <th className="py-1.5 text-right">Δ</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {quarters
                .slice()
                .reverse()
                .map((q: TakeRateQuarter) => (
                  <tr key={q.quarter} className="border-b border-gray-100">
                    <td className="py-1 pr-4">{fq(q.quarter)}</td>
                    <td className="py-1 pr-4 text-right">{m(q.totalGmv)}</td>
                    <td className="py-1 pr-4 text-right">{pf(q.blendedTake)}</td>
                    <td className="py-1 pr-4 text-right">{m(q.reconstructed)}</td>
                    <td className="py-1 pr-4 text-right">{m(q.reported)}</td>
                    <td className="py-1 text-right text-gray-500">
                      {(q.deltaUsd >= 0 ? "+" : "") + m(q.deltaUsd)} (
                      {q.reported ? ((q.deltaUsd / q.reported) * 100).toFixed(2) : "0.00"}%)
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="max-w-3xl text-xs text-gray-400">
        Method &amp; caveats: reported segment GMVs, take rates and revenue come from the model workbook (latest reported quarter{" "}
        {fq(latest.quarter)}). The seller admin fee is measured live per lot from the marketplace API and GMV-weighted; the
        &quot;implied&quot; columns are the reported take minus that measured fee — the buyer&apos;s premium half is inferred, not
        directly measured, because the API only exposes it to an authenticated buyer. Measured fee and reported take rates cover
        different periods (fees are per-seller and stable, so this is immaterial). RSCG/purchase is an ownership model, excluded
        from the seller/buyer marketplace split.
      </p>
    </div>
  );
}
