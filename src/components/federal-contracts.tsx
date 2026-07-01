"use client";

import type { FederalContractRow, ContractSnapshotRow } from "@/lib/supabase";
import { ExportButton } from "./export-button";
import { humanizeAwardType } from "@/lib/format";

function fmtDollar(n: number | null | undefined) {
  if (n == null) return "—";
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(0) + "k";
  return "$" + n.toFixed(0);
}

function sixMonthCutoff(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  return d.toISOString().slice(0, 10);
}

export function FederalContracts({
  contracts,
  snapshot,
}: {
  contracts: FederalContractRow[];
  snapshot: ContractSnapshotRow | null;
}) {
  if (!snapshot && contracts.length === 0) {
    return <p className="text-gray-500 text-sm">No federal contract data yet. Data will appear after the next cron run.</p>;
  }

  return (
    <div className="space-y-6">
      {snapshot && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-lg border p-3">
            <p className="text-xs text-gray-500 mb-1">Active Contracts</p>
            <p className="text-xl font-bold tabular-nums">{snapshot.total_active_contracts ?? 0}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs text-gray-500 mb-1">Total Obligated</p>
            <p className="text-xl font-bold tabular-nums">{fmtDollar(snapshot.total_obligated_amount)}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs text-gray-500 mb-1">New (Last 30d)</p>
            <p className="text-xl font-bold tabular-nums">{snapshot.new_contracts_last_30d ?? 0}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs text-gray-500 mb-1">New Obligation (30d)</p>
            <p className="text-xl font-bold tabular-nums">{fmtDollar(snapshot.new_obligation_last_30d)}</p>
          </div>
        </div>
      )}

      {snapshot?.top_agencies && snapshot.top_agencies.length > 0 && (
        <div>
          <p className="text-xs text-gray-500 mb-2">Top Agencies by Obligation</p>
          <div className="space-y-1">
            {snapshot.top_agencies.slice(0, 5).map((a) => (
              <div key={a.name} className="flex items-center justify-between text-sm">
                <span className="truncate mr-4">{a.name}</span>
                <span className="text-gray-500 tabular-nums whitespace-nowrap">
                  {fmtDollar(a.amount)} ({a.count})
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {contracts.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
            <p className="text-xs text-gray-500">Recent Contract Awards</p>
            <div className="flex items-center gap-3">
              <p className="text-xs text-gray-400">
                <span className="inline-block w-3 h-3 align-middle mr-1 bg-amber-50 border border-amber-200 rounded-sm" />
                Current or past 6 months
              </p>
              <ExportButton
                rows={contracts}
                filename="lqdt-federal-contracts.csv"
                columns={[
                  { key: "award_id", label: "Award ID" },
                  { key: "recipient_name", label: "Recipient" },
                  { key: "awarding_agency", label: "Awarding Agency" },
                  { key: "award_type", label: "Award Type" },
                  { key: "award_amount", label: "Award Amount" },
                  { key: "total_obligation", label: "Total Obligation" },
                  { key: "start_date", label: "Start" },
                  { key: "end_date", label: "End" },
                  { key: "naics_code", label: "NAICS" },
                  { key: "place_of_performance_state", label: "PoP State" },
                  { key: "description", label: "Description" },
                ]}
              />
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b-2 border-gray-300">
                  <th className="py-2 pr-4 text-left">Award ID</th>
                  <th className="py-2 pr-4 text-left">Type</th>
                  <th className="py-2 pr-4 text-left">Agency</th>
                  <th className="py-2 pr-4 text-right">Amount</th>
                  <th className="py-2 pr-4 text-left">Start</th>
                  <th className="py-2 text-left">Description</th>
                </tr>
              </thead>
              <tbody>
                {contracts.slice(0, 20).map((c) => {
                  const cutoff = sixMonthCutoff();
                  const recent = !!c.start_date && c.start_date >= cutoff;
                  return (
                    <tr key={c.award_id} className={`border-b border-gray-100 ${recent ? "bg-amber-50" : ""}`}>
                      <td className="py-1.5 pr-4 font-mono text-xs">{c.award_id}</td>
                      <td className="py-1.5 pr-4 whitespace-nowrap text-gray-600">{humanizeAwardType(c.award_type)}</td>
                      <td className="py-1.5 pr-4 truncate max-w-[200px]">{c.awarding_agency ?? "—"}</td>
                      <td className="py-1.5 pr-4 text-right tabular-nums">{fmtDollar(c.total_obligation)}</td>
                      <td className="py-1.5 pr-4 whitespace-nowrap">{c.start_date ?? "—"}</td>
                      <td className="py-1.5 truncate max-w-[300px] text-gray-500">{c.description ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
