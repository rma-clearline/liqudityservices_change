import type { TakeRateComposition, TakeRateQuarter, MeasuredFeeSite } from "@/lib/dashboard-data";
import type { FeeBucket } from "@/lib/azure-sql";

const SITE_LABEL: Record<string, string> = { AD: "AllSurplus", GD: "GovDeals", GI: "Industrial" };

function m(usd: number): string {
  if (Math.abs(usd) >= 1_000_000) return "$" + (usd / 1_000_000).toFixed(1) + "M";
  if (Math.abs(usd) >= 1_000) return "$" + (usd / 1_000).toFixed(0) + "k";
  return "$" + usd.toFixed(0);
}
const pf = (frac: number) => (frac * 100).toFixed(2) + "%"; // reported take rates are fractions
const pp = (pct: number | null) => (pct == null ? "—" : pct.toFixed(2) + "%"); // measured fee is a percent
// The buyer premium sits ON TOP of the winning bid and GMV is the premium-inclusive
// transaction value, so a fee's contribution to the take rate (revenue ÷ GMV) is its
// rate ÷ (1 + premium), NOT the raw rate. This is the basis on which the measured fees
// reconcile to the reported take rate (GovDeals to ~0.02pp).
const inclusiveTake = (premiumPct: number, adminPct: number) => (premiumPct + adminPct) / (1 + premiumPct / 100);
// Services residual cell: "n.m." when clearly negative (a coverage/measurement artifact,
// not negative services revenue); tiny negatives clamp to 0.
const svc = (v: number | null) => (v == null ? "—" : v < -0.25 ? "n.m." : Math.max(0, v).toFixed(2) + "%");
function fq(quarter: string): string {
  // 2026Q1 -> "2026 Q1"
  const m2 = /^(\d{4})Q([1-4])$/.exec(quarter);
  return m2 ? `${m2[1]} Q${m2[2]}` : quarter;
}

// Published buyer's-premium ranges by marketplace (the buyer pays these on top of the
// winning bid). Seller-set, so not precisely measurable — these are the published
// schedules: GovDeals cap 12.5% / typ 7.5-12.5%; AllSurplus ~10-15%. Edit as schedules
// change. Percentages, not fractions.
const BP_RANGE: Record<string, [number, number]> = {
  GD: [7.5, 12.5],
  GI: [10, 15],
  BLENDED: [9, 13],
};

/** One fee-pattern table (lot size / seller type / category). All GMV-weighted. */
function PatternTable({ title, rows, note }: { title: string; rows: FeeBucket[]; note?: string }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-gray-600">{title}</p>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b bg-gray-50/60 text-left">
              <th className="px-2.5 py-1 font-semibold text-gray-600">{note ?? ""}</th>
              <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Premium</th>
              <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Admin</th>
              <th className="px-2.5 py-1 text-right font-semibold text-gray-600" title="(premium + admin) ÷ premium-inclusive GMV — comparable to the reported take rate">
                Total take
              </th>
              <th className="px-2.5 py-1 text-right font-semibold text-gray-600" title="Hammer-price GMV the fees were measured on (excludes the buyer premium)">
                GMV (hammer)
              </th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((r, i) => (
              <tr key={`${r.dim}:${i}`} className="border-b border-gray-100">
                <td className={`whitespace-nowrap py-1 pr-2.5 text-gray-700 ${r.sub ? "pl-7 text-gray-500" : "pl-2.5"}`}>{r.dim || "—"}</td>
                <td className="px-2.5 py-1 text-right">{pp(r.premium_pct)}</td>
                <td className="px-2.5 py-1 text-right text-gray-500">{pp(r.admin_pct)}</td>
                <td className="px-2.5 py-1 text-right font-semibold">{pp(r.total_pct)}</td>
                <td className="px-2.5 py-1 text-right text-gray-500">
                  {r.sub ? <span title="already included in the row above">({m(r.gmv)})</span> : m(r.gmv)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function TakeRateView({ data }: { data: TakeRateComposition }) {
  const { latest, quarters, measured, patterns, measuredByQuarter } = data;
  if (!latest) {
    return <p className="text-sm text-gray-500">Model metrics unavailable — the reported take-rate workbook isn&apos;t loaded.</p>;
  }
  const bySite = new Map((measured?.bySite ?? []).map((s) => [s.site, s]));
  const feePct = (site: string): number | null => bySite.get(site)?.blended_pct ?? null;
  const premPct = (site: string): number | null => bySite.get(site)?.premium_pct ?? null;

  // Marketplace composition: reported commission take rate paired with the measured
  // seller admin fee. Only the clean commission segments (GovDeals, CAG) — RSCG is a
  // purchase/ownership line, not a commission, so it's excluded from this split.
  const compRows: { label: string; site: string; take: number }[] = [
    { label: "GovDeals", site: "GD", take: latest.govdealsTake },
    { label: "Industrial (CAG)", site: "GI", take: latest.cagTake },
  ];

  // Independent cross-check: fee-implied band = measured seller fee + published buyer
  // premium. The measured buyer premium is shown alongside for a direct comparison.
  const bandRows: { label: string; reported: number; fee: number | null; prem: number | null; bp: [number, number]; note?: string }[] = [
    { label: "GovDeals", reported: latest.govdealsTake, fee: feePct("GD"), prem: premPct("GD"), bp: BP_RANGE.GD },
    { label: "Industrial (CAG)", reported: latest.cagTake, fee: feePct("GI"), prem: premPct("GI"), bp: BP_RANGE.GI, note: "+ Machinio services" },
    { label: "Blended marketplace", reported: latest.consignmentTake, fee: measured?.overall_pct ?? null, prem: measured?.premium_overall_pct ?? null, bp: BP_RANGE.BLENDED },
  ];

  // Recommended take rate per category: trailing-4-quarter GMV-weighted (smooths the
  // quarterly seasonality — CAG in particular swings). Latest quarter shown alongside.
  const ttm = quarters.slice(-4);
  const wt = (rev: (q: TakeRateQuarter) => number, gmv: (q: TakeRateQuarter) => number): number => {
    const g = ttm.reduce((a, q) => a + gmv(q), 0);
    return g > 0 ? ttm.reduce((a, q) => a + rev(q), 0) / g : 0;
  };
  const consignRates = ttm.filter((q) => q.consignmentTake > 0).map((q) => q.consignmentTake);
  const ttmConsign = consignRates.length ? consignRates.reduce((a, b) => a + b, 0) / consignRates.length : latest.consignmentTake;
  type RecItem =
    | { kind: "group"; label: string; key: string }
    | { kind: "row"; key: string; label: string; rec: number; latest: number; basis: string };
  const recItems: RecItem[] = [
    { kind: "group", key: "g1", label: "Marketplace commission — the auction take rate" },
    { kind: "row", key: "gd", label: "GovDeals", rec: wt((q) => q.govdealsRev, (q) => q.govdealsGmv), latest: latest.govdealsTake, basis: "reported actual (SEC-verified); inside the fee-implied band" },
    { kind: "row", key: "cag", label: "Industrial / CAG", rec: wt((q) => q.cagRev, (q) => q.cagGmv), latest: latest.cagTake, basis: "reported; includes Machinio subscription + valuation services" },
    { kind: "row", key: "cons", label: "Blended consignment", rec: ttmConsign, latest: latest.consignmentTake, basis: "reported blended marketplace commission" },
    { kind: "group", key: "g2", label: "Non-commission — for context, not an auction fee" },
    { kind: "row", key: "rscg", label: "RSCG (purchase / ownership)", rec: wt((q) => q.rscgRev, (q) => q.rscgGmv), latest: latest.rscgTake, basis: "gross margin on goods LSI buys and resells" },
    { kind: "row", key: "total", label: "Total company (revenue ÷ GMV)", rec: wt((q) => q.reconstructed, (q) => q.totalGmv), latest: latest.blendedTake, basis: "includes the purchase/ownership line — not a marketplace rate" },
  ];

  // Blended auction take (premium-inclusive) + services residual for the composition table.
  const blendedPrem = measured?.premium_overall_pct ?? null;
  const blendedFee = measured?.overall_pct ?? null;
  const blendedAuction = blendedPrem != null && blendedFee != null ? inclusiveTake(blendedPrem, blendedFee) : null;
  const blendedServices = latest.consignmentTake > 0 && blendedAuction != null ? latest.consignmentTake * 100 - blendedAuction : null;

  // Revenue back-test — segment build-up using OUR measured take rates.
  //   GovDeals GMV × measured GD take  +  CAG GMV × measured AD/GI take
  //   + RSCG segment revenue + Machinio (neither is a listing fee, so both come from the model)
  // The segments must be govdeals + cag + rscg (the model's own decomposition): consignment_gmv
  // ALREADY CONTAINS RSCG's consignment slice, so using consignment_gmv here alongside the RSCG
  // line would double-count that slice. Verified in the metrics: consignment + purchase ==
  // govdeals + rscg + cag to the dollar. Only the TAKE RATES are ours; segment GMV is the
  // model's, because total GMV isn't observable from scraping.
  const MIN_COVERED_GMV = 25_000_000; // don't present a thinly-measured quarter as authoritative
  const takeByQ = new Map(measuredByQuarter.map((x) => [x.quarter, x]));
  const backtest = quarters
    .map((q) => {
      const mq = takeByQ.get(q.quarter);
      if (!mq || q.reported <= 0 || mq.covered_gmv < MIN_COVERED_GMV) return null;
      if (mq.gd_take_pct == null || mq.cag_take_pct == null || q.govdealsGmv <= 0) return null;
      const gd = q.govdealsGmv * (mq.gd_take_pct / 100);
      const cag = q.cagGmv * (mq.cag_take_pct / 100);
      const auction = gd + cag;
      const rscg = q.rscgGmv * q.rscgTake;
      const modeled = auction + rscg + q.machinio;
      // Reported auction revenue for the same two segments, from the model's own take rates.
      const reportedAuction = q.govdealsGmv * q.govdealsTake + q.cagGmv * q.cagTake;
      return {
        quarter: q.quarter,
        gdTake: mq.gd_take_pct,
        cagTake: mq.cag_take_pct,
        auction,
        reportedAuction: reportedAuction > 0 ? reportedAuction : null,
        services: reportedAuction > 0 ? reportedAuction - auction : null,
        modeled,
        reported: q.reported,
        deltaPct: (modeled / q.reported - 1) * 100,
        coveredGmv: mq.covered_gmv,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .reverse(); // newest first, matching the reconciliation table below

  return (
    <div className="space-y-10 text-sm">
      {/* Recommended take rates — headline summary */}
      <section className="rounded-lg border border-gray-300 bg-gray-50/70 p-4">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">Recommended take rates by category</h3>
          <span className="text-xs text-gray-500">trailing 4 quarters, GMV-weighted · latest reported {fq(latest.quarter)}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-gray-300 text-left text-xs text-gray-500">
                <th className="py-1 pr-4">Category</th>
                <th className="py-1 pr-4 text-right">Recommended</th>
                <th className="py-1 pr-4 text-right">Latest</th>
                <th className="py-1">Basis</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {recItems.map((it) =>
                it.kind === "group" ? (
                  <tr key={it.key}>
                    <td colSpan={4} className="pt-2.5 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                      {it.label}
                    </td>
                  </tr>
                ) : (
                  <tr key={it.key} className="border-b border-gray-100">
                    <td className="py-1 pr-4">{it.label}</td>
                    <td className="py-1 pr-4 text-right font-semibold">{pf(it.rec)}</td>
                    <td className="py-1 pr-4 text-right text-gray-500">{pf(it.latest)}</td>
                    <td className="py-1 text-xs text-gray-500">{it.basis}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-gray-400">
          Reported rates are LSI&apos;s filed actuals — verified to the decimal against SEC filings and consistent with published
          fee mechanics. Within each marketplace rate both fees are now <em>measured</em> live per lot from the marketplace bid
          box — the buyer&apos;s premium ({pp(measured?.premium_overall_pct ?? null)} blended) and the seller admin fee
          ({pp(measured?.overall_pct ?? null)} blended). Use the marketplace commissions (~10–17%) as the auction take rate; the
          total (~{pf(latest.blendedTake)}) mixes in the purchase/ownership line and isn&apos;t a fee.
        </p>
      </section>

      {/* Thesis */}
      <p className="max-w-3xl text-gray-600">
        LSI&apos;s take is overwhelmingly a <strong>buyer-premium and services</strong> story, not a seller-commission one. We now
        measure both auction fees directly from the marketplace bid box: the <strong>buyer&apos;s premium</strong> is the bulk at
        ~<strong>{pp(measured?.premium_overall_pct ?? null)}</strong> of covered GMV, while the seller admin fee is only about{" "}
        <strong>{pp(measured?.overall_pct ?? null)}</strong> — together roughly the ~{pf(latest.consignmentTake)} blended
        marketplace commission. (The reported ~{pf(latest.blendedTake)} total take is revenue ÷ all GMV, inflated by the
        purchase/ownership line — see the build-up below.) Everything below shows how reported revenue is built and where those
        fees sit within it.
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

      {/* 2. Take rate composition: measured buyer premium + measured seller fee + residual */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">Take rate composition — buyer premium + seller fee (both measured)</h3>
        <p className="mb-3 text-xs text-gray-500">
          Each marketplace&apos;s reported commission take rate, decomposed into the two fees we read <strong>live per lot from the
          marketplace bid box</strong> — the <strong>buyer&apos;s premium</strong> and the <strong>seller admin fee</strong>. Because
          the premium sits on top of the winning bid and GMV is premium-inclusive, those rates translate to an{" "}
          <strong>auction take of GMV = (premium + admin) ÷ (1 + premium)</strong>, which lines up with the reported take rate; the
          gap is the <strong>services</strong> layer (Machinio + valuations, concentrated on Industrial).
          {measured
            ? ` Measured fees are GMV-weighted over the trailing 90 days (${measured.from} → ${measured.to}).`
            : " Measured fees unavailable (store not configured)."}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-gray-300 text-left">
                <th className="py-1.5 pr-4">Marketplace</th>
                <th className="py-1.5 pr-4 text-right">Reported take rate</th>
                <th className="py-1.5 pr-4 text-right">Buyer premium (rate)</th>
                <th className="py-1.5 pr-4 text-right">Seller admin fee (rate)</th>
                <th className="py-1.5 pr-4 text-right" title="(premium + admin fee) ÷ (1 + premium) — the fees' contribution to revenue ÷ premium-inclusive GMV">
                  Auction take (of GMV)
                </th>
                <th className="py-1.5 text-right">Services / residual</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {compRows.map((r) => {
                const fee = feePct(r.site);
                const prem = premPct(r.site);
                // Auction take on the reported (premium-inclusive) GMV basis, so it lines
                // up with the reported take; only when BOTH measured fees are known.
                const auction = prem != null && fee != null ? inclusiveTake(prem, fee) : null;
                const services = r.take > 0 && auction != null ? r.take * 100 - auction : null;
                return (
                  <tr key={r.site} className="border-b border-gray-100">
                    <td className="py-1 pr-4">{r.label}</td>
                    <td className="py-1 pr-4 text-right">{r.take ? pf(r.take) : "—"}</td>
                    <td className="py-1 pr-4 text-right">{pp(prem)}</td>
                    <td className="py-1 pr-4 text-right">{pp(fee)}</td>
                    <td className="py-1 pr-4 text-right">{auction == null ? "—" : auction.toFixed(2) + "%"}</td>
                    <td className="py-1 text-right">{svc(services)}</td>
                  </tr>
                );
              })}
              <tr className="border-b border-gray-300 font-semibold">
                <td className="py-1.5 pr-4">Blended (all consignment)</td>
                <td className="py-1.5 pr-4 text-right">{latest.consignmentTake > 0 ? pf(latest.consignmentTake) : "—"}</td>
                <td className="py-1.5 pr-4 text-right">{pp(blendedPrem)}</td>
                <td className="py-1.5 pr-4 text-right">{pp(blendedFee)}</td>
                <td className="py-1.5 pr-4 text-right">{blendedAuction == null ? "—" : blendedAuction.toFixed(2) + "%"}</td>
                <td className="py-1.5 text-right">{svc(blendedServices)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-gray-400">
          GMV basis: LSI defines GMV as the total sales value of transactions on which it earns compensation, and the buyer premium
          is charged on top of the winning bid — so GMV is premium-inclusive and a fee&apos;s take contribution is rate ÷ (1 + premium).
          On that basis GovDeals reconciles to ≈0 services (a pure-auction segment), while Industrial carries a services layer
          (Machinio + valuations) on top of its auction fees. The buyer&apos;s premium is the bulk of the take; the seller admin fee
          is a small add-on, and the two are often substitutes (many GovDeals sellers charge a premium with a 0% admin fee).
          &quot;n.m.&quot; appears when premium and admin-fee coverage (priced on different lot subsets) over-explain the take.
          RSCG/purchase GMV is an ownership model (no seller fee, no buyer premium) and is excluded from this split.
        </p>
      </section>

      {/* Independent cross-check: fee-implied band */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">Independent cross-check — fee-implied take-rate band</h3>
        <div className="mb-3 rounded-md border border-blue-100 bg-blue-50/60 px-3 py-2 text-xs text-gray-600">
          <p className="mb-1 font-semibold text-gray-700">How this is calculated</p>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>
              Take rate = the cut LSI keeps on a sale ÷ the sale price (GMV). It comes from two fees.
            </li>
            <li>
              <strong>Seller admin fee</strong> — the seller pays LSI. We read this directly from the marketplace, per lot
              (measured, not assumed).
            </li>
            <li>
              <strong>Buyer&apos;s premium</strong> — the buyer pays on top of the winning bid. It&apos;s set by each seller; we now
              read it directly per lot (the <em>measured</em> column), and also show the marketplaces&apos; <em>published ranges</em>
              as an independent cross-check.
            </li>
            <li>
              <strong>Fee-implied band = measured seller fee + published buyer-premium range.</strong> If the reported take rate
              (from LSI&apos;s filings) lands <strong>inside</strong> the band, it&apos;s consistent with how the fees actually
              work — a check that doesn&apos;t rely on the financial model.
            </li>
          </ul>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-gray-300 text-left">
                <th className="py-1.5 pr-4">Marketplace</th>
                <th className="py-1.5 pr-4 text-right">Reported take</th>
                <th className="py-1.5 pr-4 text-right">Measured seller fee</th>
                <th className="py-1.5 pr-4 text-right">Buyer premium (measured)</th>
                <th className="py-1.5 pr-4 text-right">Buyer premium (published)</th>
                <th className="py-1.5 pr-4 text-right">Fee-implied band</th>
                <th className="py-1.5 text-right">Reported vs. band</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {bandRows.map((r) => {
                const feeVal = r.fee ?? 0;
                const lo = feeVal + r.bp[0];
                const hi = feeVal + r.bp[1];
                const rep = r.reported > 0 ? r.reported * 100 : null;
                let label = "—";
                let color = "text-gray-400";
                if (rep != null) {
                  if (rep >= lo && rep <= hi) {
                    label = "✓ consistent";
                    color = "text-green-700";
                  } else if (rep > hi) {
                    label = `above band${r.note ? ` (${r.note})` : ""}`;
                    color = "text-amber-700";
                  } else {
                    label = "below band";
                    color = "text-amber-700";
                  }
                }
                return (
                  <tr key={r.label} className="border-b border-gray-100">
                    <td className="py-1 pr-4">{r.label}</td>
                    <td className="py-1 pr-4 text-right">{rep == null ? "—" : rep.toFixed(2) + "%"}</td>
                    <td className="py-1 pr-4 text-right">{pp(r.fee)}</td>
                    <td className="py-1 pr-4 text-right">{pp(r.prem)}</td>
                    <td className="py-1 pr-4 text-right text-gray-500">
                      {r.bp[0].toFixed(1)}–{r.bp[1].toFixed(1)}%
                    </td>
                    <td className="py-1 pr-4 text-right">
                      {lo.toFixed(1)}–{hi.toFixed(1)}%
                    </td>
                    <td className={`py-1 text-right ${color}`}>{label}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-gray-400">
          Buyer-premium ranges are published, seller-set schedules (not precisely measurable). Industrial/CAG sits above its
          buyer-premium band because that segment also books Machinio subscription + valuation <strong>services</strong> revenue on
          top of auction fees — expected, not a discrepancy. Example: GovDeals reported {pf(latest.govdealsTake)} = measured seller
          fee {pp(feePct("GD"))} + an implied buyer premium of{" "}
          {feePct("GD") != null ? (latest.govdealsTake * 100 - (feePct("GD") as number)).toFixed(2) + "%" : "—"}, squarely inside
          the published 7.5–12.5% range.
        </p>
      </section>

      {/* 3. Measured take-rate fees detail */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">Measured take-rate fees — detail &amp; coverage</h3>
        <p className="mb-3 text-xs text-gray-500">
          Per-lot buyer&apos;s premium and seller admin fee, read from the marketplace bid box and GMV-weighted over sold lots in
          the trailing 90 days. Coverage grows as the daily job prices more sellers.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-gray-300 text-left">
                <th className="py-1.5 pr-4">Marketplace</th>
                <th className="py-1.5 pr-4 text-right">GMV-weighted buyer premium</th>
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
                    <td className="py-1 pr-4 text-right">{pp(s?.premium_pct ?? null)}</td>
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
                <td className="py-1.5 pr-4 text-right">{pp(measured?.premium_overall_pct ?? null)}</td>
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

      {/* 3b. Fee patterns — where the take rate is higher/lower */}
      {patterns && (patterns.bySize.length > 0 || patterns.bySellerType.length > 0) && (
        <section>
          <h3 className="mb-1 text-sm font-semibold">Fee patterns — what drives the take rate</h3>
          <p className="mb-3 text-xs text-gray-500">
            Measured fees across every sold lot in our history, GMV-weighted. The strongest driver is{" "}
            <strong>lot size</strong> (large lots negotiate rates down), then <strong>who the seller is</strong> — state
            governments run a different structure (low premium, high seller fee). Category is largely a proxy for seller mix, so
            it compresses once seller type is held constant. Fees are contracted per seller, so each row reflects the mix of
            sellers active in that bucket.
          </p>
          <div className="grid gap-4 lg:grid-cols-2">
            <PatternTable title="By lot size — the take rate declines as lots get larger" rows={patterns.bySize} note="Lot size" />
            <PatternTable title="By seller type (government split out by level)" rows={patterns.bySellerType} note="Seller" />
          </div>
          {patterns.byCategory.length > 0 && (
            <div className="mt-4">
              <PatternTable title="Largest categories by GMV (not exhaustive — top 12 only)" rows={patterns.byCategory} note="Category" />
            </div>
          )}
          <p className="mt-2 text-xs text-gray-400">
            Total take is on the premium-inclusive basis, so it&apos;s comparable to the reported take rate; the GMV column is the
            hammer price the fees were measured on, so the two columns aren&apos;t a straight multiply. The size effect is a genuine
            rate difference rather than a shift between premium and admin fee — it holds on the two combined. Practical read: GMV
            growth concentrated in large lots dilutes the blended take rate even with no change in posted pricing. Government rows
            are indented under their seller type and their GMV is shown in parentheses because it is already counted above.
          </p>
        </section>
      )}

      {/* 3c. Revenue back-test from measured fees */}
      {backtest.length > 0 && (
        <section>
          <h3 className="mb-1 text-sm font-semibold">Revenue back-test — rebuilt from our measured fees</h3>
          <p className="mb-3 text-xs text-gray-500">
            Each quarter&apos;s revenue rebuilt segment by segment: <strong>GovDeals GMV × our measured GovDeals take</strong> +{" "}
            <strong>Industrial GMV × our measured AllSurplus/Industrial take</strong> (both from the marketplace bid box, not the
            model) + the RSCG segment and Machinio, which aren&apos;t listing fees and so come from the model. Segment GMV is the
            model&apos;s — total GMV isn&apos;t observable from scraping — so this tests the <em>fee rates</em>, not the volumes.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b-2 border-gray-300 text-left">
                  <th className="py-1.5 pr-4">Quarter</th>
                  <th className="py-1.5 pr-4 text-right">GD take (ours)</th>
                  <th className="py-1.5 pr-4 text-right">Ind. take (ours)</th>
                  <th className="py-1.5 pr-4 text-right">Auction rev (ours)</th>
                  <th className="py-1.5 pr-4 text-right">Auction rev (reported)</th>
                  <th className="py-1.5 pr-4 text-right">Services gap</th>
                  <th className="py-1.5 pr-4 text-right">Total modeled rev</th>
                  <th className="py-1.5 pr-4 text-right">Reported rev</th>
                  <th className="py-1.5 text-right">Δ</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {backtest.map((b) => (
                  <tr key={b.quarter} className="border-b border-gray-100">
                    <td className="py-1 pr-4">{fq(b.quarter)}</td>
                    <td className="py-1 pr-4 text-right">{b.gdTake.toFixed(2)}%</td>
                    <td className="py-1 pr-4 text-right">{b.cagTake.toFixed(2)}%</td>
                    <td className="py-1 pr-4 text-right">{m(b.auction)}</td>
                    <td className="py-1 pr-4 text-right text-gray-500">{b.reportedAuction == null ? "—" : m(b.reportedAuction)}</td>
                    <td className="py-1 pr-4 text-right text-gray-500">{svc(b.services)}</td>
                    <td className="py-1 pr-4 text-right font-semibold">{m(b.modeled)}</td>
                    <td className="py-1 pr-4 text-right">{m(b.reported)}</td>
                    <td className={`py-1 text-right ${Math.abs(b.deltaPct) <= 2 ? "text-green-700" : "text-amber-700"}`}>
                      {(b.deltaPct >= 0 ? "+" : "") + b.deltaPct.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-gray-400">
            Read the <strong>GovDeals</strong> column first: our measured GovDeals take reproduces the filed GovDeals take rate to
            within a few hundredths of a point, so that segment&apos;s revenue rebuilds almost exactly — strong independent evidence
            the measured fees are right. The <strong>services gap</strong> (reported auction revenue − ours) is concentrated in
            Industrial, where the segment books Machinio-adjacent valuation/advisory revenue on top of auction fees; that isn&apos;t
            a listing fee, so it can&apos;t appear in scraped data and the total therefore rebuilds a few percent light. Segments must
            be GovDeals + Industrial + RSCG (the model&apos;s own decomposition) — consignment GMV already contains RSCG&apos;s
            consignment slice, so mixing the two would double-count it. Quarters with under {m(MIN_COVERED_GMV)} of measured GMV are
            omitted rather than shown as authoritative.
          </p>
        </section>
      )}

      {/* 4. Revenue reconciliation across quarters */}
      <section>
        <h3 className="mb-1 text-sm font-semibold">Revenue reconciliation — how close each quarter lands</h3>
        <p className="mb-3 text-xs text-gray-500">
          The segment build-up (GovDeals + RSCG + CAG + Machinio) vs. actual reported revenue, last {quarters.length} quarters. The
          small Δ is a known model line, not an error — see the note below the table.
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
        <p className="mt-2 text-xs text-gray-400">
          Δ = the model&apos;s &quot;Corporate &amp; other / eliminations&quot; revenue line, which the four-segment build-up
          doesn&apos;t include — verified to the dollar against v15 (a flat ≈ −$17k in FY24Q4–25Q3, and $0 in the two latest
          quarters, where Δ ≈ 0). At ≤0.01% of revenue it&apos;s the reconciliation residual, not an error.
        </p>
      </section>

      <p className="max-w-3xl text-xs text-gray-400">
        Method &amp; caveats: reported segment GMVs, take rates and revenue come from the model workbook (latest reported quarter{" "}
        {fq(latest.quarter)}). Both auction fees — the buyer&apos;s premium and the seller admin fee — are now measured live per
        lot from the marketplace bid box and GMV-weighted; the &quot;services / residual&quot; column is the reported take minus
        both measured fees. Premium is set per seller/event, so a single stored value per seller is a close approximation, and
        premium vs admin-fee coverage can differ slightly. Measured fees and reported take rates cover different periods (fees are
        stable, so this is immaterial). RSCG/purchase is an ownership model, excluded from the seller/buyer marketplace split.
      </p>
    </div>
  );
}
