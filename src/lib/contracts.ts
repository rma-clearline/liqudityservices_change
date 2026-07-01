import { fetchWithRetry } from "./http";

const USA_SPENDING_BASE = "https://api.usaspending.gov/api/v2";
const SEARCH_ENDPOINT = `${USA_SPENDING_BASE}/search/spending_by_award/`;
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_LIMIT = 100; // USAspending max per page
const MAX_PAGES = Number(process.env.USASPENDING_MAX_PAGES) || 10;

const NAME_VARIANTS = [
  "Liquidity Services",
  "GovDeals",
  "Government Liquidation",
  "AllSurplus",
  "Bid4Assets",
];

const AWARD_FIELDS = [
  "Award ID",
  "Recipient Name",
  "Award Amount",
  "Total Obligation",
  "Awarding Agency",
  "Funding Agency",
  "Award Type",
  "Start Date",
  "End Date",
  "Description",
  "Place of Performance State Code",
  "NAICS Code",
] as const;

const CONTRACT_CODES = ["A", "B", "C", "D"];
const IDV_CODES = ["IDV_A", "IDV_B", "IDV_B_A", "IDV_B_B", "IDV_B_C", "IDV_C", "IDV_D", "IDV_E"];

// USAspending earliest available date
const EARLIEST_DATE = "2007-10-01";

export type ContractAward = {
  award_id: string;
  recipient_name: string;
  award_amount: number;
  total_obligation: number;
  awarding_agency: string;
  funding_agency: string | null;
  award_type: string;
  start_date: string;
  end_date: string | null;
  description: string;
  place_of_performance_state: string | null;
  naics_code: string | null;
};

export type ContractSummary = {
  total_active_contracts: number;
  total_obligated_amount: number;
  new_contracts_last_30d: number;
  new_obligation_last_30d: number;
  top_agencies: { name: string; amount: number; count: number }[];
};

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return formatDate(d);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRow(row: Record<string, any>): ContractAward {
  return {
    award_id: String(row["Award ID"] ?? ""),
    recipient_name: String(row["Recipient Name"] ?? ""),
    award_amount: Number(row["Award Amount"] ?? 0),
    total_obligation: Number(row["Total Obligation"] ?? 0),
    awarding_agency: String(row["Awarding Agency"] ?? ""),
    funding_agency: row["Funding Agency"] ? String(row["Funding Agency"]) : null,
    award_type: String(row["Award Type"] ?? ""),
    start_date: String(row["Start Date"] ?? ""),
    end_date: row["End Date"] ? String(row["End Date"]) : null,
    description: String(row["Description"] ?? ""),
    place_of_performance_state: row["Place of Performance State Code"]
      ? String(row["Place of Performance State Code"])
      : null,
    naics_code: row["NAICS Code"] ? String(row["NAICS Code"]) : null,
  };
}

// Paginates through all result pages (bounded by MAX_PAGES) rather than only
// the first 100 rows. future_improvements.md "Paginate USAspending contract
// pulls beyond the current request window".
async function searchAwards(
  recipientName: string,
  startDate: string,
  endDate: string,
  awardTypeCodes: string[],
): Promise<ContractAward[]> {
  const awards: ContractAward[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    let data: { results?: Record<string, unknown>[]; page_metadata?: { hasNext?: boolean } };
    try {
      const res = await fetchWithRetry(
        SEARCH_ENDPOINT,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filters: {
              recipient_search_text: [recipientName],
              time_period: [{ start_date: startDate, end_date: endDate }],
              award_type_codes: awardTypeCodes,
            },
            fields: [...AWARD_FIELDS],
            page,
            limit: PAGE_LIMIT,
            sort: "Start Date",
            order: "desc",
          }),
        },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      if (!res.ok) break;
      data = await res.json();
    } catch {
      break;
    }

    const results = data.results ?? [];
    for (const row of results) awards.push(mapRow(row));

    if (results.length < PAGE_LIMIT || data.page_metadata?.hasNext === false) break;
  }

  return awards;
}

function dedup(awards: ContractAward[]): ContractAward[] {
  const seen = new Map<string, ContractAward>();
  for (const a of awards) {
    if (a.award_id && !seen.has(a.award_id)) {
      seen.set(a.award_id, a);
    }
  }
  return Array.from(seen.values());
}

export async function fetchNewContracts(
  sinceDaysAgo: number = 365,
): Promise<ContractAward[]> {
  const startDate = sinceDaysAgo > 6000 ? EARLIEST_DATE : daysAgo(sinceDaysAgo);
  const endDate = formatDate(new Date());

  // Search each name variant for both contracts and IDVs (separate groups required by API)
  const searches = NAME_VARIANTS.flatMap((name) => [
    searchAwards(name, startDate, endDate, CONTRACT_CODES),
    searchAwards(name, startDate, endDate, IDV_CODES),
  ]);

  const results = await Promise.all(searches);
  return dedup(results.flat());
}

export async function fetchContractSummary(
  recentContracts?: ContractAward[],
): Promise<ContractSummary> {
  const allContracts = recentContracts ?? await fetchNewContracts(99999);

  const today = formatDate(new Date());
  const cutoff30 = daysAgo(30);

  const activeContracts = allContracts.filter(
    (c) => c.end_date === null || c.end_date >= today,
  );

  const recent = allContracts.filter((c) => c.start_date >= cutoff30);

  const totalObligated = activeContracts.reduce(
    (sum, c) => sum + c.total_obligation,
    0,
  );

  const newObligation = recent.reduce(
    (sum, c) => sum + c.total_obligation,
    0,
  );

  const agencyMap = new Map<string, { amount: number; count: number }>();
  for (const c of activeContracts) {
    const name = c.awarding_agency || "Unknown";
    const entry = agencyMap.get(name) ?? { amount: 0, count: 0 };
    entry.amount += c.total_obligation;
    entry.count += 1;
    agencyMap.set(name, entry);
  }

  const topAgencies = Array.from(agencyMap.entries())
    .map(([name, { amount, count }]) => ({ name, amount, count }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);

  return {
    total_active_contracts: activeContracts.length,
    total_obligated_amount: totalObligated,
    new_contracts_last_30d: recent.length,
    new_obligation_last_30d: newObligation,
    top_agencies: topAgencies,
  };
}
