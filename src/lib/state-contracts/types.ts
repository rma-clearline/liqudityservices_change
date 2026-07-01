export type RecordType = "contract" | "payment" | "purchase_order" | "solicitation" | "amendment" | "award";

export type StateContract = {
  state_code: string;
  source_portal: string;
  source_dataset_id: string;
  contract_id: string;
  vendor_name: string;
  vendor_normalized: string;
  customer_agency: string;
  contract_title: string | null;
  amount: number | null;
  year: string;
  quarter: string;
  period_start: string | null;
  period_end: string | null;
  // Lifecycle stage of the record. Assigned centrally in index.ts by dataset so
  // awards/payments/solicitations aren't blended. Optional on the adapter side.
  record_type?: RecordType;
  raw_data: Record<string, unknown>;
};

export type StateAdapter = {
  stateCode: string;
  portal: string;
  fetch: () => Promise<StateContract[]>;
};

const VENDOR_PATTERNS: { normalized: string; patterns: RegExp[] }[] = [
  { normalized: "govdeals", patterns: [/govdeals/i, /gov\s*deals/i] },
  { normalized: "liquidity_services", patterns: [/liquidity\s*services/i, /liquidity\s*svc/i] },
  { normalized: "bid4assets", patterns: [/bid4\s*assets/i, /bid\s*4\s*assets/i] },
  { normalized: "government_liquidation", patterns: [/government\s*liquidation/i, /gov\s*liquidation/i] },
  { normalized: "allsurplus", patterns: [/allsurplus/i, /all\s*surplus/i] },
  { normalized: "govplanet", patterns: [/govplanet/i, /gov\s*planet/i] },
  { normalized: "machinio", patterns: [/machinio/i] },
  { normalized: "network_international", patterns: [/network\s*international/i] },
];

// Common corporate suffixes stripped for display + matching robustness.
const SUFFIX_RE = /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|holdings|group|usa)\b/gi;

/** Lowercased, punctuation- and suffix-stripped vendor name for matching/display. */
export function cleanVendorName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, " ")
    .replace(SUFFIX_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Manual overrides for known spellings that the pattern list would miss.
const VENDOR_OVERRIDES: { normalized: string; needles: string[] }[] = [
  { normalized: "liquidity_services", needles: ["liquidity services", "liquidityservices", "liquidity svcs", "lsi government"] },
  { normalized: "govdeals", needles: ["govdeals", "gov deals"] },
  { normalized: "bid4assets", needles: ["bid4assets", "bid 4 assets"] },
  { normalized: "government_liquidation", needles: ["government liquidation", "govt liquidation"] },
  { normalized: "allsurplus", needles: ["allsurplus", "all surplus"] },
  { normalized: "govplanet", needles: ["govplanet", "gov planet"] },
];

export function normalizeVendor(name: string): string | null {
  // 1. Fast path: original pattern list.
  for (const { normalized, patterns } of VENDOR_PATTERNS) {
    if (patterns.some((p) => p.test(name))) return normalized;
  }
  // 2. Robust path: match against the cleaned name (handles punctuation,
  //    suffixes, and odd spacing that the raw patterns miss).
  const cleaned = cleanVendorName(name);
  for (const { normalized, needles } of VENDOR_OVERRIDES) {
    if (needles.some((n) => cleaned.includes(n))) return normalized;
  }
  return null;
}

export const SEARCH_TERMS = ["govdeals", "liquidity services", "bid4assets", "government liquidation", "allsurplus", "govplanet"];
