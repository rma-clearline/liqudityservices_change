"use client";

import type { SamOpportunityRow } from "@/lib/supabase";
import { ExportButton } from "./export-button";

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

function noticeTypeBadge(t: string | null): string {
  if (!t) return "bg-gray-100 text-gray-600";
  const s = t.toLowerCase();
  if (s.includes("award")) return "bg-green-100 text-green-700";
  if (s.includes("sources sought")) return "bg-amber-100 text-amber-700";
  if (s.includes("solicitation")) return "bg-blue-100 text-blue-700";
  if (s.includes("presol") || s.includes("pre-sol")) return "bg-purple-100 text-purple-700";
  return "bg-gray-100 text-gray-600";
}

export function SamOpportunities({ opportunities }: { opportunities: SamOpportunityRow[] }) {
  if (opportunities.length === 0) {
    return (
      <p className="text-gray-500 text-sm">
        No SAM.gov opportunities yet. Data will appear after the next cron run (requires SAM_API_KEY env var).
      </p>
    );
  }

  const awards = opportunities.filter((o) => o.notice_type?.toLowerCase().includes("award"));
  const sourcesSought = opportunities.filter((o) => o.notice_type?.toLowerCase().includes("sources sought"));
  const solicitations = opportunities.filter((o) => {
    const t = (o.notice_type ?? "").toLowerCase();
    return t.includes("solicitation") || t.includes("combined");
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <ExportButton
          rows={opportunities}
          filename="lqdt-sam-opportunities.csv"
          columns={[
            { key: "notice_id", label: "Notice ID" },
            { key: "posted_date", label: "Posted" },
            { key: "notice_type", label: "Type" },
            { key: "title", label: "Title" },
            { key: "organization", label: "Agency" },
            { key: "naics_code", label: "NAICS" },
            { key: "classification_code", label: "PSC" },
            { key: "response_deadline", label: "Response Deadline" },
            { key: "set_aside", label: "Set-Aside" },
            { key: "pop_state", label: "PoP State" },
            { key: "pop_city", label: "PoP City" },
            { key: "awardee_name", label: "Awardee" },
            { key: "award_amount", label: "Award $" },
            { key: "ui_link", label: "Link" },
          ]}
        />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-lg border p-3">
          <p className="text-xs text-gray-500 mb-1">Total (last 90d)</p>
          <p className="text-xl font-bold tabular-nums">{opportunities.length}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-gray-500 mb-1">Sources Sought</p>
          <p className="text-xl font-bold tabular-nums text-amber-600">{sourcesSought.length}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-gray-500 mb-1">Solicitations</p>
          <p className="text-xl font-bold tabular-nums text-blue-600">{solicitations.length}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-gray-500 mb-1">Awards</p>
          <p className="text-xl font-bold tabular-nums text-green-600">{awards.length}</p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b-2 border-gray-300">
              <th className="py-2 pr-4 text-left">Posted</th>
              <th className="py-2 pr-4 text-left">Type</th>
              <th className="py-2 pr-4 text-left">Title</th>
              <th className="py-2 pr-4 text-left">Agency</th>
              <th className="py-2 pr-4 text-left">NAICS</th>
              <th className="py-2 text-right">Award $</th>
            </tr>
          </thead>
          <tbody>
            {opportunities.slice(0, 30).map((o) => {
              const cutoff = sixMonthCutoff();
              const posted = o.posted_date?.slice(0, 10) ?? "";
              const recent = !!posted && posted >= cutoff;
              return (
                <tr key={o.notice_id} className={`border-b border-gray-100 ${recent ? "bg-amber-50" : ""}`}>
                  <td className="py-1.5 pr-4 whitespace-nowrap text-gray-500">{posted || "—"}</td>
                  <td className="py-1.5 pr-4">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${noticeTypeBadge(o.notice_type)}`}>
                      {o.notice_type ?? "—"}
                    </span>
                  </td>
                  <td className="py-1.5 pr-4 max-w-[340px]">
                    {o.ui_link ? (
                      <a
                        href={o.ui_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline truncate block"
                        title={o.title}
                      >
                        {o.title}
                      </a>
                    ) : (
                      <span className="truncate block" title={o.title}>{o.title}</span>
                    )}
                    {(o.set_aside || o.pop_state) && (
                      <div className="mt-0.5 text-xs text-gray-400">
                        {o.set_aside ? <span className="mr-2">{o.set_aside}</span> : null}
                        {o.pop_state ? <span>{[o.pop_city, o.pop_state].filter(Boolean).join(", ")}</span> : null}
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 pr-4 truncate max-w-[180px] text-gray-500">{o.organization ?? "—"}</td>
                  <td className="py-1.5 pr-4 font-mono text-xs text-gray-500">{o.naics_code ?? "—"}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtDollar(o.award_amount)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-400">
        <span className="inline-block w-3 h-3 align-middle mr-1 bg-amber-50 border border-amber-200 rounded-sm" />
        Highlighted rows are from the current or past 6 months. Only LQDT-specific results: title mentions an LQDT brand, or awardee matches LQDT UEI/name.
      </p>
    </div>
  );
}
