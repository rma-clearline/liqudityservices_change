import { buildSearchPayload, maestroFetch, SEARCH_LIST_PATH, type Platform } from "./maestro";

type ScrapeResult = {
  allsurplus: number | null;
  govdeals: number | null;
};

async function fetchListingCount(businessId: Platform): Promise<number | null> {
  // displayRows:1 — we only need the x-total-count header for the active count.
  const { total } = await maestroFetch(SEARCH_LIST_PATH, buildSearchPayload(businessId, 1, 1), {
    timeoutMs: 15_000,
  });
  return total;
}

export async function scrapeListings(): Promise<ScrapeResult> {
  const [allsurplus, govdeals] = await Promise.all([
    fetchListingCount("AD"),
    fetchListingCount("GD"),
  ]);
  return { allsurplus, govdeals };
}
