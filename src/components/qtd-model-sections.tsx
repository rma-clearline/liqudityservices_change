"use client";

// Model-driven QTD sections (A. Segment GMV, B. Earnings preview, C. Transactions
// & ASP, D. Supply & demand). All math lives in the pure computeQtdModelData
// (src/lib/qtd-model-compute.ts) so the page's CSV export and the cron report
// email emit exactly the numbers these sections render. This file is the React
// rendering only.

import { useMemo, type ReactNode } from "react";
import { formatQuarterLabel } from "@/lib/time";
import { fmtM, fmtPct, MetricsTable, StatCard, type MCol } from "./qtd-shared";
import {
  computeQtdModelData,
  type BucketDailyRow,
  type Group,
  type ListingsDay,
  type ModelMetricRow,
  type QtdModelInput,
} from "@/lib/qtd-model-compute";

// Re-export the compute + page-facing types so existing imports from
// "./qtd-model-sections" (qtd-progress.tsx) keep working.
export { computeQtdModelData };
export type { BucketDailyRow, ListingsDay, ModelMetricRow };

const fmtCount = (v: number) => Math.round(v).toLocaleString("en-US");
const fmtEps = (v: number) => `$${v.toFixed(2)}`;
const fmtPlainPct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;
const fmtPreview = (v: number | null, kind: "usd" | "eps" | "pct") =>
  v == null ? "—" : kind === "usd" ? fmtM(v) : kind === "eps" ? fmtEps(v) : fmtPlainPct(v);

function Section({ title, sub, defaultOpen = false, children }: { title: string; sub?: string; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details open={defaultOpen} className="rounded-lg border">
      <summary className="cursor-pointer select-none bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-700">
        {title}
        {sub && <span className="ml-1.5 font-normal text-gray-400">{sub}</span>}
      </summary>
      <div className="space-y-3 border-t p-3">{children}</div>
    </details>
  );
}

const Unavailable = ({ what }: { what: string }) => (
  <p className="text-xs text-gray-400">{what} unavailable — the durable store didn&rsquo;t answer for this request.</p>
);

const yoySpan = (v: number | null) =>
  v == null ? <span className="text-gray-300">—</span> : <span className={v >= 0 ? "text-green-600" : "text-red-600"}>{fmtPct(v)}</span>;

const qLabel = (q: string, isQtd: boolean) => (isQtd ? `QTD ${formatQuarterLabel(q, "cy")}` : formatQuarterLabel(q, "cy"));

export function QtdModelSections(props: QtdModelInput) {
  const { selected, currentQuarter, listings } = props;
  const m = useMemo(() => computeQtdModelData(props), [props]);

  const groupProvenance = m.hasGroups ? (
    <p className="text-[11px] text-gray-400">
      Group data through {m.groupLast} · day {m.dg} of {m.totalDays} for {formatQuarterLabel(selected)} (may lag the headline series by up to a day).
    </p>
  ) : null;

  return (
    <div className="space-y-3">
      {/* A. Segments */}
      <Section title="Segment GMV" sub="scraped gov / retail / intl vs reported GovDeals / RSCG / CAG" defaultOpen>
        {!m.hasGroups ? (
          <Unavailable what="Scraped segment split" />
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-3">
              {m.segments.map((seg) => (
                <StatCard
                  key={seg.key}
                  label={`${seg.name} QTD (${seg.sub})`}
                  value={
                    <>
                      {fmtM(seg.qtdGmv)} {yoySpan(seg.yoy)}
                    </>
                  }
                  sub={
                    seg.capture
                      ? `capture ≈ ${fmtPlainPct(seg.capture.rate, 0)} vs ${seg.vs} (${seg.capture.n} qtrs) · implied total ${fmtM(seg.impliedTotal!)}`
                      : `no capture rate yet vs ${seg.vs}`
                  }
                />
              ))}
            </div>
            <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-4">
              {m.segmentHistory.map(({ metric, title, rows }) => {
                if (rows.length === 0) return null;
                const cols: MCol[] = rows.map((r) => ({
                  key: `${r.quarter}-${r.basis}`,
                  top: formatQuarterLabel(r.quarter, "cy"),
                  sub: `(${formatQuarterLabel(r.quarter, "fq")}${r.basis === "model E" ? " · model E" : ""})`,
                  nominal: r.value,
                  yoy: r.yoy,
                  hl: r.basis === "model E",
                  total: true,
                }));
                return (
                  <div key={metric}>
                    <p className="mb-1 text-xs font-medium text-gray-500">{title}</p>
                    <MetricsTable groups={[{ name: title, cols }]} scale={1} scaled={false} />
                  </div>
                );
              })}
            </div>
            {!m.hasMetrics && <p className="text-xs text-gray-400">Model metrics unavailable — reported segment history hidden.</p>}
            {groupProvenance}
          </>
        )}
      </Section>

      {/* B. Earnings preview */}
      <Section title={`Earnings preview — ${formatQuarterLabel(currentQuarter)}`} sub="always the current quarter, total-company basis">
        {!m.hasMetrics && m.preview.rows.every((r) => r.guidanceLow == null && r.model == null) ? (
          <p className="text-xs text-gray-400">Model metrics unavailable — no guidance / model context to preview.</p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b-2 border-gray-300 text-left">
                    <th className="px-2.5 py-1 font-semibold text-gray-600">Metric</th>
                    <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Guidance</th>
                    <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Guide mid</th>
                    <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Clearline model</th>
                    <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Ours (implied)</th>
                    <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Ours vs mid</th>
                  </tr>
                </thead>
                <tbody>
                  {m.preview.rows.map((r) => (
                    <tr key={r.label} className="border-b border-gray-100">
                      <td className="px-2.5 py-1 font-medium text-gray-700">{r.label}</td>
                      <td className="px-2.5 py-1 text-right tabular-nums text-gray-700">
                        {r.guidanceLow != null && r.guidanceHigh != null
                          ? `${fmtPreview(r.guidanceLow, r.kind)}–${fmtPreview(r.guidanceHigh, r.kind)}`
                          : "—"}
                      </td>
                      <td className="px-2.5 py-1 text-right tabular-nums text-gray-500">{fmtPreview(r.guidanceMid, r.kind)}</td>
                      <td className="px-2.5 py-1 text-right tabular-nums text-gray-700">{fmtPreview(r.model, r.kind)}</td>
                      <td className="px-2.5 py-1 text-right tabular-nums font-semibold text-gray-900">{fmtPreview(r.ours, r.kind)}</td>
                      <td className="px-2.5 py-1 text-right tabular-nums">{yoySpan(r.vsMid)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-gray-400">
              Ours (GMV) = the scaled full-quarter estimate{m.preview.method ? ` (${m.preview.method})` : ""} at the page&rsquo;s capture rate.
              Implied revenue = scaled FQE × model take rate{" "}
              {m.preview.takeRate != null
                ? `${fmtPlainPct(m.preview.takeRate)} (${m.preview.takeRateIsForecast ? "model forecast" : "latest reported"})`
                : "—"}.
              {m.preview.consensus != null && m.preview.consensusDelta != null && (
                <>
                  {" "}
                  Street consensus GMV (CH): {fmtM(m.preview.consensus)} — ours {fmtPct(m.preview.consensusDelta)} vs consensus.
                </>
              )}
            </p>
            {m.takeRateModel?.available && (
              <div className="overflow-x-auto rounded-lg border">
                <p className="border-b bg-gray-50 px-3 py-1.5 text-[11px] font-semibold text-gray-600">
                  Take-rate model{" "}
                  <span className="font-normal text-gray-400">
                    (bucket coefficients fitted on {m.takeRateModel.nQuarters} reported quarter{m.takeRateModel.nQuarters === 1 ? "" : "s"} — θ =
                    revenue per scraped $, capture absorbed)
                  </span>
                </p>
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b-2 border-gray-300 text-left">
                      <th className="px-2.5 py-1 font-semibold text-gray-600">Bucket</th>
                      <th className="px-2.5 py-1 text-right font-semibold text-gray-600">FQE GMV (scraped)</th>
                      <th className="px-2.5 py-1 text-right font-semibold text-gray-600">θ</th>
                      <th className="px-2.5 py-1 text-right font-semibold text-gray-600">≈ take rate</th>
                      <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Revenue contribution</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.takeRateModel.coeffs.map((c) => (
                      <tr key={c.bucket} className="border-b border-gray-100">
                        <td className="px-2.5 py-1 font-medium text-gray-700">{c.label}</td>
                        <td className="px-2.5 py-1 text-right tabular-nums text-gray-700">{c.fqeGmv != null ? fmtM(c.fqeGmv) : "—"}</td>
                        <td className="px-2.5 py-1 text-right tabular-nums text-gray-900">{c.theta.toFixed(3)}</td>
                        <td className="px-2.5 py-1 text-right tabular-nums text-gray-500">{fmtPlainPct(c.approxTake)}</td>
                        <td className="px-2.5 py-1 text-right tabular-nums text-gray-700">
                          {c.revContribution != null ? fmtM(c.revContribution) : "—"}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-b border-gray-100 bg-gray-50/60">
                      <td className="px-2.5 py-1 font-medium text-gray-700">+ Purchase revenue (mostly unscraped GMV, incl. AllSurplus DTC)</td>
                      <td className="px-2.5 py-1 text-right text-gray-300">—</td>
                      <td className="px-2.5 py-1 text-right text-gray-300">—</td>
                      <td className="px-2.5 py-1 text-right text-gray-300">—</td>
                      <td className="px-2.5 py-1 text-right tabular-nums text-gray-700">{fmtM(m.takeRateModel.purchaseAdd)}</td>
                    </tr>
                    <tr className="border-b border-gray-100 bg-gray-50/60">
                      <td className="px-2.5 py-1 font-medium text-gray-700">+ Machinio (subscription, no GMV)</td>
                      <td className="px-2.5 py-1 text-right text-gray-300">—</td>
                      <td className="px-2.5 py-1 text-right text-gray-300">—</td>
                      <td className="px-2.5 py-1 text-right text-gray-300">—</td>
                      <td className="px-2.5 py-1 text-right tabular-nums text-gray-700">{fmtM(m.takeRateModel.machinioAdd)}</td>
                    </tr>
                    <tr className="bg-blue-50">
                      <td className="px-2.5 py-1 font-semibold text-gray-800">Revenue (mix-adj)</td>
                      <td className="px-2.5 py-1 text-right text-gray-300">—</td>
                      <td className="px-2.5 py-1 text-right text-gray-300">—</td>
                      <td className="px-2.5 py-1 text-right tabular-nums font-medium text-gray-700">
                        {m.takeRateModel.mixTakeRate != null ? fmtPlainPct(m.takeRateModel.mixTakeRate) : "—"}
                      </td>
                      <td className="px-2.5 py-1 text-right tabular-nums font-semibold text-gray-900">
                        {m.takeRateModel.mixRevenue != null ? fmtM(m.takeRateModel.mixRevenue) : "—"}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p className="px-3 py-1.5 text-[11px] text-gray-400">
                  In-sample backtest vs reported revenue:{" "}
                  {m.takeRateModel.backtest.map((b) => `${formatQuarterLabel(b.q, "cy")} ${fmtPct(b.errPct)}`).join(" · ")}.
                  {m.preview.rows.some((r) => r.label === "Revenue") &&
                    m.takeRateModel.mixRevenue != null &&
                    (() => {
                      const flat = m.preview.rows.find((r) => r.label === "Revenue")?.ours;
                      return flat != null && flat > 0 ? (
                        <> Mix-adj vs flat take rate: {fmtPct(m.takeRateModel.mixRevenue / flat - 1)}.</>
                      ) : null;
                    })()}
                  {!m.takeRateModel.converged && " (fit did not fully converge)"}
                </p>
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-3">
              {m.preview.beat && (
                <>
                  <StatCard
                    label={`Avg beat vs guidance mid (last ${m.preview.beat.n} qtrs)`}
                    value={yoySpan(m.preview.beat.avg)}
                    sub="reported GMV vs guidance midpoint"
                  />
                  <StatCard
                    label="Beat guidance mid"
                    value={`${m.preview.beat.wins} of ${m.preview.beat.n}`}
                    sub="quarters where reported GMV exceeded the midpoint"
                  />
                </>
              )}
              {m.preview.impliedBeat != null && (
                <StatCard
                  label="Our implied beat this quarter"
                  value={yoySpan(m.preview.impliedBeat)}
                  sub={`scaled FQE ${fmtM(m.preview.scaledFqe!)} vs guidance mid ${fmtM(m.preview.guidanceMid!)}`}
                />
              )}
            </div>
          </>
        )}
      </Section>

      {/* C. Transactions & ASP */}
      <Section title="Transactions & ASP" sub={`captured lots vs reported completed transactions — ${formatQuarterLabel(selected)}`}>
        {!m.hasGroups ? (
          <Unavailable what="Captured lot counts" />
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-3">
              <StatCard
                label="QTD lots captured"
                value={
                  <>
                    {fmtCount(m.txns.lotsQtd)} {yoySpan(m.txns.lotsYoy)}
                  </>
                }
                sub={
                  m.matchedDays != null
                    ? `vs LY same ${m.matchedDays} days: ${fmtCount(m.txns.lyLotsMatched)}`
                    : "prior-year lot data not covered"
                }
              />
              <StatCard
                label="Txn capture rate"
                value={m.txns.capture ? fmtPlainPct(m.txns.capture.rate, 1) : "—"}
                sub={
                  m.txns.capture
                    ? `captured lots ÷ reported completed txns (${m.txns.capture.n} qtrs)`
                    : "needs a reported, fully-covered quarter"
                }
              />
              <StatCard
                label={m.txns.selectedComplete ? "Full-quarter transactions (implied)" : `FQ transactions (implied, ${m.txns.method})`}
                value={m.txns.fqe != null ? fmtCount(m.txns.fqe) : "—"}
                sub={
                  m.txns.modelTxn != null && m.txns.fqe != null
                    ? `model${m.txns.modelTxnIsForecast ? " E" : ""}: ${fmtCount(m.txns.modelTxn)} — ours ${fmtPct(m.txns.fqe / m.txns.modelTxn - 1)}`
                    : "no model transaction figure for this quarter"
                }
              />
            </div>
            {m.aspRows.length > 0 && (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b-2 border-gray-300 text-left">
                      <th className="px-2.5 py-1 font-semibold text-gray-600">Quarter</th>
                      <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Scraped $/lot</th>
                      <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Y/Y</th>
                      <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Reported $/txn</th>
                      <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Y/Y</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.aspRows.map((r) => (
                      <tr key={`${r.q}-${r.isQtd}`} className={`border-b border-gray-100 ${r.isQtd ? "bg-blue-50" : ""}`}>
                        <td className="whitespace-nowrap px-2.5 py-1 font-medium text-gray-700">
                          {qLabel(r.q, r.isQtd)}
                          <span className="ml-1 text-[10px] font-normal text-gray-400">({formatQuarterLabel(r.q, "fq")})</span>
                        </td>
                        <td className="px-2.5 py-1 text-right tabular-nums font-semibold text-gray-900">
                          {r.scraped != null ? `$${fmtCount(r.scraped)}` : "—"}
                        </td>
                        <td className="px-2.5 py-1 text-right tabular-nums">{yoySpan(r.scrapedYoy)}</td>
                        <td className="px-2.5 py-1 text-right tabular-nums text-gray-700">
                          {r.rep != null ? `$${fmtCount(r.rep)}${r.repE ? " E" : ""}` : "—"}
                        </td>
                        <td className="px-2.5 py-1 text-right tabular-nums">{yoySpan(r.repYoy)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {m.ops.quarters.length > 0 && (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b-2 border-gray-300 text-left">
                      <th className="px-2.5 py-1 font-semibold text-gray-600">Reported operating stats</th>
                      {m.ops.quarters.map((q) => (
                        <th key={q} className="px-2.5 py-1 text-right font-semibold text-gray-600">
                          {formatQuarterLabel(q, "cy")}
                          <span className="ml-1 font-normal text-gray-400">({formatQuarterLabel(q, "fq")})</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {m.ops.rows.map((row) => (
                      <tr key={row.metric} className="border-b border-gray-100">
                        <td className="px-2.5 py-1 font-medium text-gray-700">{row.label}</td>
                        {row.cells.map((c) => (
                          <td key={c.q} className="px-2.5 py-1 text-right tabular-nums text-gray-900">
                            {c.value != null ? fmtCount(c.value) : "—"}
                            {c.value != null && c.yoy != null && (
                              <span className={`ml-1 text-[10px] ${c.yoy >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtPct(c.yoy)}</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {groupProvenance}
          </>
        )}
      </Section>

      {/* D. Supply & demand */}
      <Section title="Supply & demand" sub="active listings productivity + bid intensity">
        {m.listingRows == null && listings !== "error" && <p className="text-xs text-gray-400">Loading listings…</p>}
        {listings === "error" && <p className="text-xs text-gray-400">Listings data unavailable.</p>}
        {m.listingRows != null && m.listingRows.length > 0 && (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b-2 border-gray-300 text-left">
                  <th className="px-2.5 py-1 font-semibold text-gray-600">Quarter</th>
                  <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Avg AS listings</th>
                  <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Y/Y</th>
                  <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Avg GD listings</th>
                  <th className="px-2.5 py-1 text-right font-semibold text-gray-600">Y/Y</th>
                  <th className="px-2.5 py-1 text-right font-semibold text-gray-600">GMV / GD listing</th>
                  <th className="px-2.5 py-1 text-right font-semibold text-gray-600">GMV / AS listing</th>
                </tr>
              </thead>
              <tbody>
                {m.listingRows.map((r) => (
                  <tr key={`${r.q}-${r.isQtd}`} className={`border-b border-gray-100 ${r.isQtd ? "bg-blue-50" : ""}`}>
                    <td className="whitespace-nowrap px-2.5 py-1 font-medium text-gray-700">
                      {qLabel(r.q, r.isQtd)}
                      <span className="ml-1 text-[10px] font-normal text-gray-400">({formatQuarterLabel(r.q, "fq")})</span>
                    </td>
                    <td className="px-2.5 py-1 text-right tabular-nums text-gray-900">{fmtCount(r.as)}</td>
                    <td className="px-2.5 py-1 text-right tabular-nums">{yoySpan(r.asYoy)}</td>
                    <td className="px-2.5 py-1 text-right tabular-nums text-gray-900">{fmtCount(r.gd)}</td>
                    <td className="px-2.5 py-1 text-right tabular-nums">{yoySpan(r.gdYoy)}</td>
                    <td className="px-2.5 py-1 text-right tabular-nums text-gray-700">
                      {r.gmvPerGd != null ? `$${(r.gmvPerGd / 1000).toFixed(1)}k` : "—"}
                    </td>
                    <td className="px-2.5 py-1 text-right tabular-nums text-gray-700">
                      {r.gmvPerAs != null ? `$${(r.gmvPerAs / 1000).toFixed(1)}k` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {m.listingRows != null && (
          <p className="text-[11px] text-gray-400">
            GMV / listing = the quarter&rsquo;s captured site GMV ÷ average listings (GD site ÷ GD listings; AD+GI ÷ AllSurplus).
            Blank where the store&rsquo;s daily series doesn&rsquo;t cover the whole quarter; QTD is blank because partial-quarter
            GMV over average listings isn&rsquo;t comparable to full quarters.
          </p>
        )}
        {m.bids ? (
          <div className="grid gap-3 md:grid-cols-3">
            <StatCard
              label="QTD bids per lot"
              value={m.bids.perLot != null ? m.bids.perLot.toFixed(1) : "—"}
              sub={
                m.bids.lyPerLot != null && m.bids.perLotMatched != null
                  ? `LY same window: ${m.bids.lyPerLot.toFixed(1)} (${fmtPct(m.bids.perLotMatched / m.bids.lyPerLot - 1)})`
                  : "LY window not covered"
              }
            />
            <StatCard
              label="QTD total bids"
              value={
                <>
                  {fmtCount(m.bids.qtd)} {yoySpan(m.bids.yoy)}
                </>
              }
              sub="bids on captured sold lots (demand-intensity proxy)"
            />
            <StatCard
              label="Reported auction participants (latest)"
              value={m.latestParticipants != null ? fmtCount(m.latestParticipants) : "—"}
              sub="company-reported quarterly figure, for scale"
            />
          </div>
        ) : (
          <Unavailable what="Bid intensity" />
        )}
      </Section>
    </div>
  );
}

