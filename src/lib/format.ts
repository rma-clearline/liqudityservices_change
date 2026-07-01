// Shared client-side formatters + CSV export. Several components each defined
// their own fmtDollar/fmt/fmtPct; new UI uses these.

// USAspending award-type codes → human-readable labels.
const AWARD_TYPE_LABELS: Record<string, string> = {
  A: "BPA Call",
  B: "Purchase Order",
  C: "Delivery Order",
  D: "Definitive Contract",
  IDV_A: "IDV: GWAC",
  IDV_B: "IDV: IDC",
  IDV_B_A: "IDV: IDC (Requirements)",
  IDV_B_B: "IDV: IDC (Indefinite Quantity)",
  IDV_B_C: "IDV: IDC (Definite Quantity)",
  IDV_C: "IDV: FSS",
  IDV_D: "IDV: BOA",
  IDV_E: "IDV: BPA",
};

export function humanizeAwardType(raw: string | null | undefined): string {
  if (!raw) return "—";
  const upper = raw.trim().toUpperCase();
  if (AWARD_TYPE_LABELS[upper]) return AWARD_TYPE_LABELS[upper];
  // USAspending often returns readable text already (e.g. "PURCHASE ORDER").
  return raw.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export function fmtNum(n: number | null | undefined): string {
  return n != null ? n.toLocaleString("en-US") : "—";
}

export function fmtDollar(n: number | null | undefined): string {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (abs >= 1_000) return "$" + (n / 1_000).toFixed(0) + "k";
  return "$" + n.toFixed(0);
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  return n != null ? (n * 100).toFixed(digits) + "%" : "—";
}

/** Relative age like "2m ago" / "3h ago" / "5d ago" from an ISO/date string. */
export function fmtAge(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "no data";
  const t = Date.parse(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(t)) return "no data";
  const secs = Math.max(0, Math.round((now - t) / 1000));
  if (secs < 90) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Build a CSV string from rows of records, using `columns` order + headers. */
export function toCsv<T extends Record<string, unknown>>(
  rows: T[],
  columns: { key: keyof T; label: string }[],
): string {
  const escape = (value: unknown): string => {
    const text = value == null ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const header = columns.map((c) => escape(c.label)).join(",");
  const lines = rows.map((row) => columns.map((c) => escape(row[c.key])).join(","));
  return [header, ...lines].join("\n") + "\n";
}

/** Trigger a client-side CSV download. No-op outside the browser. */
export function downloadCsv(filename: string, csv: string): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
